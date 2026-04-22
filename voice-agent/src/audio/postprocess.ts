import { RMSNormalizer } from "./normalizer.js";
import { WSOLAStreamer } from "./speed.js";

export interface AudioPostProcessOptions {
  speed: number;
  sampleRate: number;
  numChannels: number;
}

export class StreamingAudioPostProcessor {
  private readonly speed: number;
  private readonly normalizer: RMSNormalizer;
  private readonly stretcher: WSOLAStreamer | null;

  constructor(options: AudioPostProcessOptions) {
    this.speed = options.speed;
    this.normalizer = new RMSNormalizer(undefined, undefined, undefined, undefined, options.sampleRate);
    this.stretcher =
      this.speed === 1
        ? null
        : new WSOLAStreamer(options.sampleRate, options.numChannels, this.speed);
  }

  push(samples: Int16Array): Int16Array {
    const stretched = this.stretcher ? this.stretcher.process(samples) : samples;
    if (stretched.length === 0) {
      return stretched;
    }
    return this.normalizer.process(stretched);
  }

  flush(): Int16Array {
    const stretched = this.stretcher ? this.stretcher.flush() : new Int16Array(0);
    if (stretched.length === 0) {
      return stretched;
    }
    return this.normalizer.process(stretched);
  }
}

export function postProcessPcm(
  samples: Int16Array,
  options: AudioPostProcessOptions
): Int16Array {
  if (samples.length === 0) {
    return samples;
  }

  const processor = new StreamingAudioPostProcessor(options);
  const processed = processor.push(samples);
  const flushed = processor.flush();

  let output = processed;
  if (flushed.length > 0) {
    output = new Int16Array(processed.length + flushed.length);
    output.set(processed, 0);
    output.set(flushed, processed.length);
  }

  return output;
}
