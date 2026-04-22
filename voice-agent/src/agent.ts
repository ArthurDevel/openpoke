import "dotenv/config";

import { randomUUID } from "node:crypto";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { fileURLToPath } from "node:url";
import {
  JobContext,
  JobProcess,
  WorkerOptions,
  cli,
  defineAgent,
  voice,
} from "@livekit/agents";
import { VAD } from "@livekit/agents-plugin-silero";
import { STT as XaiSTT } from "@livekit/agents-plugin-xai";
import { NoiseCancellation } from "@livekit/noise-cancellation-node";
import { getEnv } from "./env.js";
import { sendChatMessage, subscribeChatEvents } from "./openpokeChatTool.js";
import { XaiTTS } from "./xaiTts.js";

const env = getEnv();
const USER_TURN_ENDPOINTING_DELAY_MS = 1200;

interface WorkerUserData {
  vad?: VAD;
}

function asTextStream(stream: ReadableStream<string>): NodeReadableStream<string> {
  return stream as unknown as NodeReadableStream<string>;
}

async function prewarm(proc: JobProcess): Promise<void> {
  const userData = proc.userData as WorkerUserData;
  userData.vad = await VAD.load({
    minSilenceDuration: 800,
  });
}

async function entry(ctx: JobContext): Promise<void> {
  const userData = ctx.proc.userData as WorkerUserData;
  const vad = userData.vad;
  if (!vad) {
    throw new Error("Silero VAD was not prewarmed");
  }

  const stt = new XaiSTT({
    apiKey: env.xaiApiKey,
    language: env.livekitSttLanguage,
    interimResults: true,
  });

  let pendingUserTurn = false;
  let currentRequestId: string | null = null;
  const streamedRequestIds = new Set<string>();

  class TransportAgent extends voice.Agent {
    override async onUserTurnCompleted(_chatCtx: any, newMessage: any): Promise<void> {
      const transcript = newMessage.textContent?.trim();
      if (!transcript) {
        pendingUserTurn = false;
        return;
      }

      const requestId = randomUUID();
      currentRequestId = requestId;
      pendingUserTurn = false;
      console.info("[openpoke-voice-agent] completed user turn", { transcript });
      await sendChatMessage(env, transcript, requestId);
    }
  }

  const agent = new TransportAgent({
    instructions: env.livekitInstructions,
  });

  const session = new voice.AgentSession({
    vad,
    stt,
    tts: new XaiTTS({
      apiKey: env.xaiApiKey,
      voice: env.livekitTtsVoice,
      speed: 1.25,
    }),
    aecWarmupDuration: 0,
    turnHandling: {
      turnDetection: "vad",
      endpointing: {
        minDelay: USER_TURN_ENDPOINTING_DELAY_MS,
      },
      interruption: {
        enabled: true,
        mode: "adaptive",
      },
      preemptiveGeneration: {
        enabled: false,
      },
    },
  });

  const closed = new Promise<void>((resolve) => {
    session.on(voice.AgentSessionEventTypes.Close, () => resolve());
  });

  let stopped = false;
  let userSpeaking = false;
  let activeReplyId: string | null = null;
  let activeReplyController: ReadableStreamDefaultController<string> | null = null;
  let activeReplyHandle: ReturnType<typeof session.say> | null = null;
  const ignoredReplyIds = new Set<string>();
  const eventsAbortController = new AbortController();

  const clearActiveReply = (): void => {
    activeReplyId = null;
    activeReplyController = null;
    activeReplyHandle = null;
  };

  const abortActiveReply = (): void => {
    if (activeReplyId) {
      ignoredReplyIds.add(activeReplyId);
    }
    try {
      activeReplyController?.close();
    } catch {
      // Ignore duplicate close errors.
    }
    activeReplyHandle?.interrupt(true);
    clearActiveReply();
  };

  const startAssistantReply = (replyId: string): void => {
    abortActiveReply();

    const textStream = new ReadableStream<string>({
      start(controller) {
        activeReplyController = controller;
      },
      cancel() {
        ignoredReplyIds.add(replyId);
      },
    });

    activeReplyId = replyId;
    const handle = session.say(asTextStream(textStream), {
      allowInterruptions: true,
      addToChatCtx: false,
    });
    handle.addDoneCallback((doneHandle) => {
      if (doneHandle.interrupted) {
        ignoredReplyIds.add(replyId);
      }
      if (activeReplyHandle === handle) {
        try {
          activeReplyController?.close();
        } catch {
          // Ignore duplicate close errors.
        }
        clearActiveReply();
      }
    });
    activeReplyHandle = handle;
  };

  console.info("[openpoke-voice-agent] job assigned");
  await ctx.connect();
  await session.start({
    agent,
    room: ctx.room,
    record: false,
    inputOptions: {
      noiseCancellation: NoiseCancellation(),
      textEnabled: false,
    },
  });

  const participant = await ctx.waitForParticipant();
  console.info("[openpoke-voice-agent] participant joined", {
    participantIdentity: participant.identity,
  });

  session.on(voice.AgentSessionEventTypes.UserStateChanged, (event) => {
    userSpeaking = event.newState === "speaking";
    pendingUserTurn = event.newState !== "listening";
  });
  const assistantEventsTask = subscribeChatEvents(
    env,
    async ({ event, data }) => {
      if (stopped || !data || typeof data !== "object") {
        return;
      }

      const replyId =
        typeof (data as { reply_id?: unknown }).reply_id === "string"
          ? (data as { reply_id: string }).reply_id
          : null;
      const requestId =
        typeof (data as { request_id?: unknown }).request_id === "string"
          ? (data as { request_id: string }).request_id
          : null;
      const content =
        typeof (data as { content?: unknown }).content === "string"
          ? (data as { content: string }).content.trim()
          : "";

      if (currentRequestId && requestId !== currentRequestId) {
        return;
      }

      if (replyId && ignoredReplyIds.has(replyId)) {
        if (event === "assistant_done" || event === "assistant_abort") {
          ignoredReplyIds.delete(replyId);
        }
        return;
      }

      if (userSpeaking || pendingUserTurn) {
        if (event === "assistant_abort" && replyId) {
          ignoredReplyIds.add(replyId);
        }
        return;
      }

      if (event === "assistant_start" && replyId) {
        if (!userSpeaking) {
          startAssistantReply(replyId);
        }
        return;
      }

      if (event === "assistant_delta" && replyId) {
        if (requestId) {
          streamedRequestIds.add(requestId);
        }
        if (activeReplyId !== replyId || !activeReplyController) {
          startAssistantReply(replyId);
        }

        const delta =
          typeof (data as { delta?: unknown }).delta === "string"
            ? (data as { delta: string }).delta
            : "";
        if (delta) {
          activeReplyController?.enqueue(delta);
        }
        return;
      }

      if (event === "assistant_reply") {
        if (!content) {
          return;
        }
        if (requestId && streamedRequestIds.has(requestId)) {
          return;
        }
        abortActiveReply();
        await session.say(content, {
          allowInterruptions: true,
          addToChatCtx: false,
        }).waitForPlayout();
        return;
      }

      if (event === "assistant_done" && replyId && activeReplyId === replyId) {
        try {
          activeReplyController?.close();
        } catch {
          // Ignore duplicate close errors.
        }
        clearActiveReply();
        return;
      }

      if (event === "assistant_abort" && replyId) {
        ignoredReplyIds.add(replyId);
        if (activeReplyId === replyId) {
          abortActiveReply();
        }
      }
    },
    eventsAbortController.signal
  ).catch((error) => {
    if (!stopped) {
      console.error("[openpoke-voice-agent] assistant event stream failed", error);
    }
  });

  await session.say(env.livekitGreeting, {
    allowInterruptions: true,
    addToChatCtx: false,
  }).waitForPlayout();

  await closed.finally(async () => {
    stopped = true;
    eventsAbortController.abort();
    abortActiveReply();
    await Promise.allSettled([assistantEventsTask, stt.close()]);
  });
}

const worker = defineAgent({
  prewarm,
  entry,
});

export default worker;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cli.runApp(
    new WorkerOptions({
      agent: fileURLToPath(import.meta.url),
      agentName: env.livekitAgentName,
      wsURL: env.livekitWsUrl,
      apiKey: env.livekitApiKey,
      apiSecret: env.livekitApiSecret,
    })
  );
}
