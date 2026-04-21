import "dotenv/config";
import { fileURLToPath } from "node:url";
import { WorkerOptions, cli, defineAgent, voice } from "@livekit/agents";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import { getEnv } from "./env.js";
import { fetchChatHistory, sendChatMessage } from "./openpokeChatTool.js";
const env = getEnv();
const HISTORY_POLL_INTERVAL_MS = 1000;
const KNOWN_STT_REJECTION_MESSAGE_PREFIX = "failed to recognize speech after";
const KNOWN_STT_REJECTION_STACK_FRAGMENT = "SpeechStream.mainTask";
const KNOWN_STT_ABORTED_ERROR_MESSAGE = "WebSocket connection aborted";
const KNOWN_STT_ERROR_LABEL = "inference.STT";
const KNOWN_UNHANDLED_ERROR_CODE = "ERR_UNHANDLED_ERROR";
function isIgnorableWrappedSttShutdownError(reason) {
    const wrappedReason = reason;
    return wrappedReason.code === KNOWN_UNHANDLED_ERROR_CODE
        && wrappedReason.context?.type === "stt_error"
        && wrappedReason.context?.label === KNOWN_STT_ERROR_LABEL
        && wrappedReason.context?.error?.message === KNOWN_STT_ABORTED_ERROR_MESSAGE
        && wrappedReason.message.includes(KNOWN_STT_ABORTED_ERROR_MESSAGE)
        && typeof wrappedReason.stack === "string"
        && wrappedReason.stack.includes(KNOWN_STT_REJECTION_STACK_FRAGMENT);
}
function isIgnorableSttShutdownRejection(reason) {
    if (!(reason instanceof Error)) {
        return false;
    }
    const hasKnownMessage = reason.message.startsWith(KNOWN_STT_REJECTION_MESSAGE_PREFIX);
    const hasKnownStack = typeof reason.stack === "string" && reason.stack.includes(KNOWN_STT_REJECTION_STACK_FRAGMENT);
    return (hasKnownMessage && hasKnownStack) || isIgnorableWrappedSttShutdownError(reason);
}
process.on("unhandledRejection", (reason) => {
    if (isIgnorableSttShutdownRejection(reason)) {
        console.warn("[openpoke-voice-agent] ignoring known STT shutdown rejection");
        return;
    }
    setImmediate(() => {
        throw reason instanceof Error ? reason : new Error(String(reason));
    });
});
async function entry(ctx) {
    await ctx.connect();
    await ctx.waitForParticipant();
    const agent = new voice.Agent({
        instructions: env.livekitInstructions,
    });
    const session = new voice.AgentSession({
        stt: env.livekitSttModel,
        tts: new deepgram.TTS({
            apiKey: env.deepgramApiKey,
            model: env.livekitTtsModel,
        }),
        turnHandling: {
            turnDetection: "stt",
        },
    });
    const closed = new Promise((resolve) => {
        session.on(voice.AgentSessionEventTypes.Close, () => resolve());
    });
    let speechChain = Promise.resolve();
    let lastSeenMessageCount = 0;
    let stopped = false;
    await session.start({
        agent,
        room: ctx.room,
        record: false,
    });
    try {
        lastSeenMessageCount = (await fetchChatHistory(env)).length;
    }
    catch (error) {
        console.warn("[openpoke-voice-agent] failed to read initial chat history", error);
    }
    const historyPoller = setInterval(() => {
        if (stopped) {
            return;
        }
        speechChain = speechChain
            .then(async () => {
            const messages = await fetchChatHistory(env);
            const newMessages = messages.slice(lastSeenMessageCount);
            lastSeenMessageCount = messages.length;
            for (const entry of newMessages) {
                if (entry.role !== "assistant" || typeof entry.content !== "string") {
                    continue;
                }
                const text = entry.content.trim();
                if (!text) {
                    continue;
                }
                const handle = session.say(text, {
                    allowInterruptions: true,
                    addToChatCtx: false,
                });
                await handle.waitForPlayout();
            }
        })
            .catch((error) => {
            console.error("[openpoke-voice-agent] failed to narrate new assistant messages", error);
        });
    }, HISTORY_POLL_INTERVAL_MS);
    session.on(voice.AgentSessionEventTypes.UserInputTranscribed, (event) => {
        if (!event.isFinal) {
            return;
        }
        const transcript = event.transcript.trim();
        if (!transcript) {
            return;
        }
        speechChain = speechChain
            .then(async () => {
            await sendChatMessage(env, transcript);
        })
            .catch((error) => {
            console.error("[openpoke-voice-agent] failed to send chat message", error);
        });
    });
    await session.say(env.livekitGreeting, {
        allowInterruptions: true,
        addToChatCtx: false,
    }).waitForPlayout();
    await closed.finally(() => {
        stopped = true;
        clearInterval(historyPoller);
    });
}
const worker = defineAgent({
    entry,
});
export default worker;
if (process.argv[1] === fileURLToPath(import.meta.url)) {
    cli.runApp(new WorkerOptions({
        agent: fileURLToPath(import.meta.url),
        agentName: env.livekitAgentName,
        wsURL: env.livekitWsUrl,
        apiKey: env.livekitApiKey,
        apiSecret: env.livekitApiSecret,
    }));
}
