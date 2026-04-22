const WINDOW_SIZE_MS = 25;
const OVERLAP_RATIO = 0.5;
const MAX_SEEK_MS = 10;
function normalizedCrossCorrelation(a, b) {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i += 1) {
        const sampleA = a[i] ?? 0;
        const sampleB = b[i] ?? 0;
        dot += sampleA * sampleB;
        normA += sampleA * sampleA;
        normB += sampleB * sampleB;
    }
    if (normA < 1e-8 || normB < 1e-8) {
        return 0;
    }
    return dot / Math.sqrt(normA * normB);
}
function concatFloat32(parts) {
    const totalLength = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Float32Array(totalLength);
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.length;
    }
    return output;
}
function floatToInt16(samples) {
    const output = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
        const value = Math.max(-1, Math.min(1, samples[i] ?? 0));
        output[i] = Math.max(-32768, Math.min(32767, Math.round(value * 32768)));
    }
    return output;
}
function int16ToFloat32(samples) {
    const output = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
        output[i] = (samples[i] ?? 0) / 32768;
    }
    return output;
}
export class WSOLAStreamer {
    windowSize;
    overlapSize;
    maxSeek;
    analysisHop;
    window;
    inputBuffer = new Float32Array(0);
    outputBuffer = new Float32Array(0);
    readPos = 0;
    firstWindow = true;
    constructor(sampleRate, numChannels, tempo) {
        if (tempo < 0.5 || tempo > 2.0) {
            throw new Error(`Tempo must be between 0.5 and 2.0, got ${tempo}`);
        }
        if (numChannels !== 1) {
            throw new Error(`Only mono audio is supported, got ${numChannels} channels`);
        }
        this.windowSize = Math.floor(sampleRate * WINDOW_SIZE_MS / 1000);
        this.overlapSize = Math.floor(this.windowSize * OVERLAP_RATIO);
        this.maxSeek = Math.floor(sampleRate * MAX_SEEK_MS / 1000);
        const synthesisHop = this.windowSize - this.overlapSize;
        this.analysisHop = Math.max(1, Math.floor(synthesisHop * tempo));
        this.window = new Float32Array(this.windowSize);
        for (let i = 0; i < this.windowSize; i += 1) {
            this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(1, this.windowSize - 1));
        }
    }
    process(audio) {
        if (audio.length === 0) {
            return new Int16Array(0);
        }
        this.inputBuffer = concatFloat32([this.inputBuffer, int16ToFloat32(audio)]);
        const outputChunks = [];
        while (this.canProcessWindow()) {
            const chunk = this.processOneWindow();
            if (chunk.length > 0) {
                outputChunks.push(chunk);
            }
        }
        if (outputChunks.length === 0) {
            return new Int16Array(0);
        }
        return floatToInt16(concatFloat32(outputChunks));
    }
    flush() {
        const padding = new Float32Array(this.windowSize + this.maxSeek);
        this.inputBuffer = concatFloat32([this.inputBuffer, padding]);
        const outputChunks = [];
        while (this.canProcessWindow()) {
            const chunk = this.processOneWindow();
            if (chunk.length > 0) {
                outputChunks.push(chunk);
            }
        }
        if (this.outputBuffer.length > 0) {
            outputChunks.push(this.outputBuffer);
            this.outputBuffer = new Float32Array(0);
        }
        if (outputChunks.length === 0) {
            return new Int16Array(0);
        }
        return floatToInt16(concatFloat32(outputChunks));
    }
    canProcessWindow() {
        return this.readPos + this.windowSize + this.maxSeek <= this.inputBuffer.length;
    }
    processOneWindow() {
        if (this.firstWindow) {
            const segment = this.inputBuffer.slice(this.readPos, this.readPos + this.windowSize);
            const windowed = this.applyWindow(segment);
            this.firstWindow = false;
            this.readPos += this.analysisHop;
            this.outputBuffer = windowed;
            return new Float32Array(0);
        }
        const bestOffset = this.findBestOffset();
        const actualPos = this.readPos + bestOffset;
        const segment = this.inputBuffer.slice(actualPos, actualPos + this.windowSize);
        const windowed = this.applyWindow(segment);
        let finalized = new Float32Array(0);
        if (this.outputBuffer.length >= this.overlapSize) {
            const outputLength = this.outputBuffer.length;
            finalized = this.outputBuffer.slice(0, outputLength - this.overlapSize);
            const overlapTail = this.outputBuffer.slice(outputLength - this.overlapSize);
            const overlapHead = windowed.slice(0, this.overlapSize);
            const crossfaded = new Float32Array(this.overlapSize);
            for (let i = 0; i < this.overlapSize; i += 1) {
                crossfaded[i] = (overlapTail[i] ?? 0) + (overlapHead[i] ?? 0);
            }
            this.outputBuffer = concatFloat32([crossfaded, windowed.slice(this.overlapSize)]);
        }
        else {
            this.outputBuffer = concatFloat32([this.outputBuffer, windowed]);
        }
        this.readPos += this.analysisHop;
        this.compactInputBuffer();
        return finalized;
    }
    applyWindow(segment) {
        const output = new Float32Array(segment.length);
        for (let i = 0; i < segment.length; i += 1) {
            output[i] = (segment[i] ?? 0) * (this.window[i] ?? 0);
        }
        return output;
    }
    findBestOffset() {
        if (this.outputBuffer.length < this.overlapSize) {
            return 0;
        }
        const reference = this.outputBuffer.slice(this.outputBuffer.length - this.overlapSize);
        let bestOffset = 0;
        let bestCorrelation = -1;
        for (let offset = 0; offset <= this.maxSeek; offset += 1) {
            const position = this.readPos + offset;
            if (position + this.overlapSize > this.inputBuffer.length) {
                continue;
            }
            const candidate = this.inputBuffer.slice(position, position + this.overlapSize);
            const correlation = normalizedCrossCorrelation(reference, candidate);
            if (correlation > bestCorrelation) {
                bestCorrelation = correlation;
                bestOffset = offset;
            }
        }
        return bestOffset;
    }
    compactInputBuffer() {
        const safePosition = Math.max(0, this.readPos - this.maxSeek);
        if (safePosition > 0) {
            this.inputBuffer = this.inputBuffer.slice(safePosition);
            this.readPos -= safePosition;
        }
    }
}
