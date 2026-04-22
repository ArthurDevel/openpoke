import { randomUUID } from "node:crypto";
import { AudioByteStream, type APIConnectOptions, tts } from "@livekit/agents";
import type { AudioFrame } from "@livekit/rtc-node";
import { StreamingAudioPostProcessor } from "./audio/postprocess.js";
import { openXaiTtsSocket, streamXaiTts } from "./xai.js";

const SAMPLE_RATE = 24000;
const NUM_CHANNELS = 1;
const DEFAULT_SPEED = 1.25;

interface XaiTtsOptions {
  apiKey: string;
  voice: string;
  sampleRate?: number;
  speed?: number;
}

function int16ToBytes(samples: Int16Array): Uint8Array {
  return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
}

function flushFrames(
  byteStream: AudioByteStream,
  processor: StreamingAudioPostProcessor
): ReturnType<AudioByteStream["write"]> {
  const flushedSamples = processor.flush();
  const flushedFrames = flushedSamples.length > 0 ? byteStream.write(int16ToBytes(flushedSamples)) : [];
  return [...flushedFrames, ...byteStream.flush()];
}

export class XaiTTS extends tts.TTS {
  readonly label = "openpoke.XaiTTS";
  private readonly apiKey: string;
  private readonly voiceId: string;
  private readonly speed: number;

  constructor(options: XaiTtsOptions) {
    super(options.sampleRate ?? SAMPLE_RATE, NUM_CHANNELS, { streaming: true });
    this.apiKey = options.apiKey;
    this.voiceId = options.voice;
    this.speed = options.speed ?? DEFAULT_SPEED;
  }

  get model(): string {
    return this.voiceId;
  }

  get provider(): string {
    return "xAI";
  }

  synthesize(
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal
  ): tts.ChunkedStream {
    return new XaiChunkedStream(this, text, connOptions, abortSignal);
  }

  stream(options?: { connOptions?: APIConnectOptions }): tts.SynthesizeStream {
    return new XaiSynthesizeStream(this, options?.connOptions);
  }

  createProcessor(): StreamingAudioPostProcessor {
    return new StreamingAudioPostProcessor({
      speed: this.speed,
      sampleRate: this.sampleRate,
      numChannels: NUM_CHANNELS,
    });
  }

  async streamPcm(
    text: string,
    onAudioDelta: (samples: Int16Array) => void,
    abortSignal?: AbortSignal
  ): Promise<void> {
    await streamXaiTts(
      text,
      this.voiceId,
      this.apiKey,
      this.sampleRate,
      onAudioDelta,
      abortSignal
    );
  }

  async openSocket() {
    return openXaiTtsSocket(this.voiceId, this.apiKey, this.sampleRate);
  }
}

class XaiChunkedStream extends tts.ChunkedStream {
  readonly label = "openpoke.XaiChunkedStream";
  private readonly ttsInstance: XaiTTS;

  constructor(
    ttsInstance: XaiTTS,
    text: string,
    connOptions?: APIConnectOptions,
    abortSignal?: AbortSignal
  ) {
    super(text, ttsInstance, connOptions, abortSignal);
    this.ttsInstance = ttsInstance;
  }

  protected async run(): Promise<void> {
    const requestId = randomUUID();
    const segmentId = randomUUID();
    const processor = this.ttsInstance.createProcessor();
    const byteStream = new AudioByteStream(
      this.ttsInstance.sampleRate,
      NUM_CHANNELS,
      Math.floor(this.ttsInstance.sampleRate / 5)
    );
    let pendingFrame: AudioFrame | null = null;
    let sentText = false;

    const emitFrames = (frames: AudioFrame[], final: boolean) => {
      const completeFrames = pendingFrame ? [pendingFrame, ...frames] : frames;
      pendingFrame = null;

      if (!final) {
        if (completeFrames.length === 0) {
          return;
        }

        for (let index = 0; index < completeFrames.length - 1; index += 1) {
          this.queue.put({
            requestId,
            segmentId,
            frame: completeFrames[index],
            deltaText: !sentText && index === 0 ? this.inputText : undefined,
            final: false,
            timedTranscripts: undefined,
          });
          sentText = true;
        }

        pendingFrame = completeFrames[completeFrames.length - 1] ?? null;
        return;
      }

      for (let index = 0; index < completeFrames.length; index += 1) {
        this.queue.put({
          requestId,
          segmentId,
          frame: completeFrames[index],
          deltaText: !sentText && index === 0 ? this.inputText : undefined,
          final: index === completeFrames.length - 1,
          timedTranscripts: undefined,
        });
        sentText = true;
      }
    };

    await this.ttsInstance.streamPcm(
      this.inputText,
      (samples) => {
        const processed = processor.push(samples);
        if (processed.length === 0) {
          return;
        }
        emitFrames(byteStream.write(int16ToBytes(processed)), false);
      },
      this.abortSignal
    );

    emitFrames(flushFrames(byteStream, processor), true);
  }
}

class XaiSynthesizeStream extends tts.SynthesizeStream {
  readonly label = "openpoke.XaiSynthesizeStream";
  private readonly ttsInstance: XaiTTS;

  constructor(ttsInstance: XaiTTS, connOptions?: APIConnectOptions) {
    super(ttsInstance, connOptions);
    this.ttsInstance = ttsInstance;
  }

  protected async run(): Promise<void> {
    const segmentId = randomUUID();
    const requestId = randomUUID();
    const processor = this.ttsInstance.createProcessor();
    const byteStream = new AudioByteStream(
      this.ttsInstance.sampleRate,
      NUM_CHANNELS,
      Math.floor(this.ttsInstance.sampleRate / 5)
    );
    let pendingFrame: AudioFrame | null = null;
    let sentText = false;
    let streamClosed = false;

    const emitFrames = (frames: AudioFrame[], final: boolean) => {
      const completeFrames = pendingFrame ? [pendingFrame, ...frames] : frames;
      pendingFrame = null;

      if (!final) {
        if (completeFrames.length === 0) {
          return;
        }

        for (let index = 0; index < completeFrames.length - 1; index += 1) {
          this.queue.put({
            requestId,
            segmentId,
            frame: completeFrames[index],
            deltaText: undefined,
            final: false,
            timedTranscripts: undefined,
          });
          sentText = true;
        }

        pendingFrame = completeFrames[completeFrames.length - 1] ?? null;
        return;
      }

      for (let index = 0; index < completeFrames.length; index += 1) {
        this.queue.put({
          requestId,
          segmentId,
          frame: completeFrames[index],
          deltaText: undefined,
          final: index === completeFrames.length - 1,
          timedTranscripts: undefined,
        });
        sentText = true;
      }
    };

    const ws = await this.ttsInstance.openSocket();

    const outputTask = new Promise<void>((resolve, reject) => {
      ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const event = JSON.parse(raw.toString()) as Record<string, unknown>;
          const type = typeof event.type === "string" ? event.type : "";

          if (type === "audio.delta") {
            const delta = typeof event.delta === "string" ? event.delta : "";
            if (!delta) {
              return;
            }

            const buffer = Buffer.from(delta, "base64");
            const samples = new Int16Array(
              buffer.buffer,
              buffer.byteOffset,
              Math.floor(buffer.byteLength / 2)
            );
            const processed = processor.push(samples);
            if (processed.length > 0) {
              emitFrames(byteStream.write(int16ToBytes(processed)), false);
            }
            return;
          }

          if (type === "audio.done") {
            emitFrames(flushFrames(byteStream, processor), true);
            resolve();
            return;
          }

          if (type === "error") {
            const message = typeof event.message === "string" ? event.message : "Unknown xAI TTS error";
            reject(new Error(message));
          }
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });

      ws.on("error", (error: Error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });

    const inputTask = (async () => {
      for await (const item of this.input) {
        if (item === XaiSynthesizeStream.FLUSH_SENTINEL) {
          if (!streamClosed) {
            ws.send(JSON.stringify({ type: "text.done" }));
            streamClosed = true;
          }
          continue;
        }

        if (item) {
          ws.send(JSON.stringify({ type: "text.delta", delta: item }));
        }
      }

      if (!streamClosed) {
        ws.send(JSON.stringify({ type: "text.done" }));
        streamClosed = true;
      }
    })();

    await Promise.all([inputTask, outputTask]);
    try {
      ws.close();
    } catch {
      // Ignore close errors after completion.
    }
    this.queue.put(XaiSynthesizeStream.END_OF_STREAM);
  }
}
