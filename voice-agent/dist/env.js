import { config as loadDotenv } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
loadDotenv({
    path: resolve(MODULE_DIR, "../../.env"),
});
function requireEnv(name) {
    const value = process.env[name]?.trim();
    if (!value) {
        throw new Error(`${name} environment variable is required`);
    }
    return value;
}
function toWebSocketUrl(value) {
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
let cachedEnv = null;
export function getEnv() {
    if (cachedEnv) {
        return cachedEnv;
    }
    cachedEnv = {
        livekitAgentName: process.env.LIVEKIT_AGENT_NAME?.trim() || "openpoke-voice-agent",
        livekitWsUrl: toWebSocketUrl(requireEnv("LIVEKIT_URL")),
        livekitApiKey: requireEnv("LIVEKIT_API_KEY"),
        livekitApiSecret: requireEnv("LIVEKIT_API_SECRET"),
        deepgramApiKey: requireEnv("DEEPGRAM_API_KEY"),
        openpokeServerUrl: process.env.OPENPOKE_SERVER_URL?.trim() || "http://localhost:8001",
        livekitSttModel: process.env.LIVEKIT_STT_MODEL?.trim() || "deepgram/nova-3:en",
        livekitTtsModel: process.env.LIVEKIT_TTS_MODEL?.trim() || "aura-2-andromeda-en",
        livekitGreeting: process.env.LIVEKIT_AGENT_GREETING?.trim() || "Hi, I'm OpenPoke. What can I help you with?",
        livekitInstructions: process.env.LIVEKIT_AGENT_INSTRUCTIONS?.trim()
            || [
                "You are OpenPoke's realtime voice transport.",
                "Do not answer questions yourself.",
                "Speech content is supplied externally from the main OpenPoke chat agent.",
            ].join(" "),
    };
    return cachedEnv;
}
