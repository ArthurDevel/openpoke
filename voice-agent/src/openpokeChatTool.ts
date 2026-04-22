import type { VoiceAgentEnv } from "./env.js";

export interface ChatHistoryMessage {
  role?: string;
  content?: string;
}

interface ChatHistoryPayload {
  messages?: ChatHistoryMessage[];
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/$/, "");
}

function getMessages(payload: ChatHistoryPayload): ChatHistoryMessage[] {
  return Array.isArray(payload.messages) ? payload.messages : [];
}

export async function fetchChatHistory(env: VoiceAgentEnv): Promise<ChatHistoryMessage[]> {
  const baseUrl = normalizeBaseUrl(env.openpokeServerUrl);
  const historyUrl = `${baseUrl}/api/v1/chat/history`;

  const response = await fetch(historyUrl, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`OpenPoke chat history failed (${response.status})`);
  }

  const payload = (await response.json()) as ChatHistoryPayload;
  return getMessages(payload);
}

export async function sendChatMessage(
  env: VoiceAgentEnv,
  message: string,
  requestId: string
): Promise<void> {
  const baseUrl = normalizeBaseUrl(env.openpokeServerUrl);
  const sendUrl = `${baseUrl}/api/v1/chat/send`;

  const sendResponse = await fetch(sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/plain, */*" },
    body: JSON.stringify({
      system: "",
      messages: [{ role: "user", content: message.trim() }],
      request_id: requestId,
      stream: false,
    }),
  });

  if (!(sendResponse.ok || sendResponse.status === 202)) {
    const detail = await sendResponse.text();
    throw new Error(detail || `OpenPoke chat send failed (${sendResponse.status})`);
  }
}

function parseSseChunk(chunk: string): { event: string; data: string } | null {
  const lines = chunk.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];

  for (const line of lines) {
    if (!line || line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  return {
    event,
    data: dataLines.join("\n"),
  };
}

export async function subscribeChatEvents(
  env: VoiceAgentEnv,
  onEvent: (event: { event: string; data: any }) => void | Promise<void>,
  signal?: AbortSignal
): Promise<void> {
  const baseUrl = normalizeBaseUrl(env.openpokeServerUrl);
  const eventsUrl = `${baseUrl}/api/v1/chat/events`;
  const decoder = new TextDecoder();

  while (!signal?.aborted) {
    const response = await fetch(eventsUrl, {
      headers: { Accept: "text/event-stream" },
      signal,
    });

    if (!response.ok) {
      throw new Error(`OpenPoke chat events failed (${response.status})`);
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("OpenPoke chat events response body is unavailable");
    }

    let buffer = "";

    try {
      while (!signal?.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");
        let boundary = buffer.indexOf("\n\n");

        while (boundary !== -1) {
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);

          const parsed = parseSseChunk(rawEvent);
          if (parsed) {
            await onEvent({
              event: parsed.event,
              data: JSON.parse(parsed.data),
            });
          }

          boundary = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }

    if (!signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
