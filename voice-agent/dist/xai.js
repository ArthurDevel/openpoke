import WebSocket from "ws";
const XAI_TTS_URL = "https://api.x.ai/v1/tts";
const XAI_TTS_WS_URL = "wss://api.x.ai/v1/tts";
const DEFAULT_SAMPLE_RATE = 24000;
function buildTtsWsUrl(voiceId, sampleRate) {
    const url = new URL(XAI_TTS_WS_URL);
    url.searchParams.set("language", "en");
    url.searchParams.set("voice", voiceId);
    url.searchParams.set("codec", "pcm");
    url.searchParams.set("sample_rate", String(sampleRate));
    return url;
}
export async function callXaiTts(text, voiceId, apiKey, sampleRate = DEFAULT_SAMPLE_RATE) {
    const response = await fetch(XAI_TTS_URL, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            text,
            voice_id: voiceId,
            language: "en",
            output_format: {
                codec: "pcm",
                sample_rate: sampleRate,
            },
        }),
    });
    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`xAI TTS failed (${response.status}): ${errorText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return new Int16Array(arrayBuffer.slice(0));
}
function decodePcmDelta(delta) {
    const buffer = Buffer.from(delta, "base64");
    return new Int16Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 2));
}
export async function streamXaiTts(text, voiceId, apiKey, sampleRate = DEFAULT_SAMPLE_RATE, onAudioDelta, abortSignal) {
    const url = buildTtsWsUrl(voiceId, sampleRate);
    await new Promise((resolve, reject) => {
        let settled = false;
        const ws = new WebSocket(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        const cleanup = () => {
            ws.removeAllListeners();
            abortSignal?.removeEventListener("abort", onAbort);
        };
        const finish = (error) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            if (error) {
                reject(error);
            }
            else {
                resolve();
            }
        };
        const onAbort = () => {
            try {
                ws.close();
            }
            catch {
                // Ignore close errors during cancellation.
            }
            finish(new Error("xAI TTS streaming aborted"));
        };
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        ws.on("open", () => {
            ws.send(JSON.stringify({ type: "text.delta", delta: text }));
            ws.send(JSON.stringify({ type: "text.done" }));
        });
        ws.on("message", (raw) => {
            try {
                const event = JSON.parse(raw.toString());
                const type = typeof event.type === "string" ? event.type : "";
                if (type === "audio.delta") {
                    const delta = typeof event.delta === "string" ? event.delta : "";
                    if (delta && onAudioDelta) {
                        onAudioDelta(decodePcmDelta(delta));
                    }
                    return;
                }
                if (type === "audio.done") {
                    try {
                        ws.close();
                    }
                    catch {
                        // Ignore close errors on normal completion.
                    }
                    finish();
                    return;
                }
                if (type === "error") {
                    const message = typeof event.message === "string" ? event.message : "Unknown xAI TTS error";
                    finish(new Error(message));
                }
            }
            catch (error) {
                finish(error instanceof Error ? error : new Error(String(error)));
            }
        });
        ws.on("error", (error) => {
            finish(error instanceof Error ? error : new Error(String(error)));
        });
        ws.on("close", () => {
            if (!settled) {
                finish();
            }
        });
    });
}
export async function openXaiTtsSocket(voiceId, apiKey, sampleRate = DEFAULT_SAMPLE_RATE) {
    const url = buildTtsWsUrl(voiceId, sampleRate);
    return await new Promise((resolve, reject) => {
        const ws = new WebSocket(url, {
            headers: { Authorization: `Bearer ${apiKey}` },
        });
        ws.once("open", () => resolve(ws));
        ws.once("error", (error) => reject(error instanceof Error ? error : new Error(String(error))));
    });
}
