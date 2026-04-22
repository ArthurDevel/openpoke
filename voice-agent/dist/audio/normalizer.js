const SILENCE_THRESHOLD_DBFS = -40;
const INT16_MAX = 32768;
const TARGET_RMS_DBFS = -15;
const PEAK_LIMIT_DBFS = -1;
const ATTACK_MS = 50;
const RELEASE_MS = 200;
function dbfsToLinear(dbfs) {
    return 10 ** (dbfs / 20);
}
function computeSmoothingCoefficient(timeMs, sampleRate, chunkLength) {
    if (timeMs <= 0 || chunkLength <= 0) {
        return 0;
    }
    const chunkDurationSeconds = chunkLength / sampleRate;
    const timeSeconds = timeMs / 1000;
    return Math.exp(-chunkDurationSeconds / timeSeconds);
}
export class RMSNormalizer {
    targetRmsLinear;
    peakLimitLinear;
    silenceThresholdLinear;
    attackMs;
    releaseMs;
    sampleRate;
    currentGain = 1;
    constructor(targetRmsDbfs = TARGET_RMS_DBFS, peakLimitDbfs = PEAK_LIMIT_DBFS, attackMs = ATTACK_MS, releaseMs = RELEASE_MS, sampleRate = 16000) {
        this.targetRmsLinear = dbfsToLinear(targetRmsDbfs);
        this.peakLimitLinear = dbfsToLinear(peakLimitDbfs);
        this.silenceThresholdLinear = dbfsToLinear(SILENCE_THRESHOLD_DBFS);
        this.attackMs = attackMs;
        this.releaseMs = releaseMs;
        this.sampleRate = sampleRate;
    }
    process(audio) {
        if (audio.length === 0) {
            return audio;
        }
        const samples = new Float32Array(audio.length);
        for (let i = 0; i < audio.length; i += 1) {
            samples[i] = (audio[i] ?? 0) / INT16_MAX;
        }
        let rmsAccumulator = 0;
        for (let i = 0; i < samples.length; i += 1) {
            const value = samples[i] ?? 0;
            rmsAccumulator += value * value;
        }
        const rms = Math.sqrt(rmsAccumulator / samples.length);
        const desiredGain = rms > this.silenceThresholdLinear ? this.targetRmsLinear / rms : this.currentGain;
        const coefficient = desiredGain < this.currentGain
            ? computeSmoothingCoefficient(this.attackMs, this.sampleRate, samples.length)
            : computeSmoothingCoefficient(this.releaseMs, this.sampleRate, samples.length);
        this.currentGain = coefficient * this.currentGain + (1 - coefficient) * desiredGain;
        let peak = 0;
        for (let i = 0; i < samples.length; i += 1) {
            const scaled = (samples[i] ?? 0) * this.currentGain;
            samples[i] = scaled;
            peak = Math.max(peak, Math.abs(scaled));
        }
        if (peak > this.peakLimitLinear) {
            const scale = this.peakLimitLinear / Math.tanh(peak / this.peakLimitLinear);
            for (let i = 0; i < samples.length; i += 1) {
                samples[i] = scale * Math.tanh((samples[i] ?? 0) / this.peakLimitLinear);
            }
        }
        const output = new Int16Array(samples.length);
        for (let i = 0; i < samples.length; i += 1) {
            const clipped = Math.max(-1, Math.min(1, samples[i] ?? 0));
            output[i] = Math.round(clipped * INT16_MAX);
        }
        return output;
    }
}
