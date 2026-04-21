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

export async function sendChatMessage(env: VoiceAgentEnv, message: string): Promise<void> {
  const baseUrl = normalizeBaseUrl(env.openpokeServerUrl);
  const sendUrl = `${baseUrl}/api/v1/chat/send`;

  const sendResponse = await fetch(sendUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/plain, */*" },
    body: JSON.stringify({
      system: "",
      messages: [{ role: "user", content: message.trim() }],
      stream: false,
    }),
  });

  if (!(sendResponse.ok || sendResponse.status === 202)) {
    const detail = await sendResponse.text();
    throw new Error(detail || `OpenPoke chat send failed (${sendResponse.status})`);
  }
}
