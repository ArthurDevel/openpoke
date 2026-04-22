import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

loadDotenv({
  path: resolve(MODULE_DIR, "../../.env"),
});

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function isDeepgramModel(value: string): boolean {
  return value.startsWith("deepgram/") || value.startsWith("aura-");
}

function getSttLanguage(): string {
  const explicitLanguage = process.env.LIVEKIT_STT_LANGUAGE?.trim();
  if (explicitLanguage) {
    return explicitLanguage;
  }

  const legacyModel = process.env.LIVEKIT_STT_MODEL?.trim();
  if (!legacyModel) {
    return "en";
  }

  const languageMatch = legacyModel.match(/:([a-z]{2}(?:-[A-Z]{2})?)$/);
  return languageMatch?.[1] || "en";
}

function getTtsVoice(): string {
  const explicitVoice = process.env.LIVEKIT_TTS_VOICE?.trim();
  if (explicitVoice) {
    return explicitVoice;
  }

  const legacyModel = process.env.LIVEKIT_TTS_MODEL?.trim();
  if (!legacyModel || isDeepgramModel(legacyModel)) {
    return "eve";
  }

  return legacyModel;
}

function toWebSocketUrl(value: string): string {
  if (value.startsWith("ws://") || value.startsWith("wss://")) {
    return value;
  }
  if (value.startsWith("https://")) {
    return `wss://${value.slice("https://".length)}`;
  }
  if (value.startsWith("http://")) {
    return `ws://${value.slice("http://".length)}`;
  }
  return `wss://${value}`;
}

export interface VoiceAgentEnv {
  livekitAgentName: string;
  livekitWsUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  xaiApiKey: string;
  openpokeServerUrl: string;
  livekitSttLanguage: string;
  livekitTtsVoice: string;
  livekitGreeting: string;
  livekitInstructions: string;
}

let cachedEnv: VoiceAgentEnv | null = null;

export function getEnv(): VoiceAgentEnv {
  if (cachedEnv) {
    return cachedEnv;
  }

  cachedEnv = {
    livekitAgentName: process.env.LIVEKIT_AGENT_NAME?.trim() || "openpoke-voice-agent",
    livekitWsUrl: toWebSocketUrl(requireEnv("LIVEKIT_URL")),
    livekitApiKey: requireEnv("LIVEKIT_API_KEY"),
    livekitApiSecret: requireEnv("LIVEKIT_API_SECRET"),
    xaiApiKey: requireEnv("XAI_API_KEY"),
    openpokeServerUrl: process.env.OPENPOKE_SERVER_URL?.trim() || "http://localhost:8001",
    livekitSttLanguage: getSttLanguage(),
    livekitTtsVoice: getTtsVoice(),
    livekitGreeting:
      process.env.LIVEKIT_AGENT_GREETING?.trim() || "Hi, I'm OpenPoke. What can I help you with?",
    livekitInstructions:
      process.env.LIVEKIT_AGENT_INSTRUCTIONS?.trim()
      || [
        "You are OpenPoke's realtime voice transport.",
        "Do not answer questions yourself.",
        "Speech content is supplied externally from the main OpenPoke chat agent.",
      ].join(" "),
  };

  return cachedEnv;
}
