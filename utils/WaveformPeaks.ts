/**
 * WaveformPeaks - Pre-compute audio peaks for efficient waveform rendering
 * 
 * This avoids re-computing waveform data on every render or zoom change.
 */

export interface PeakData {
    min: Float32Array;
    max: Float32Array;
    length: number;
    samplesPerPeak: number;
    duration: number;
}

/**
 * Compute peaks from an AudioBuffer
 * @param audioBuffer - Decoded audio buffer
 * @param targetPeakCount - Number of peaks to compute (default 10000 for good detail)
 */
export async function computePeaks(
    audioBuffer: AudioBuffer,
    targetPeakCount: number = 10000
): Promise<PeakData> {
    const channelData = audioBuffer.getChannelData(0); // Use first channel
    const totalSamples = channelData.length;
    const samplesPerPeak = Math.max(1, Math.floor(totalSamples / targetPeakCount));
    const actualPeakCount = Math.ceil(totalSamples / samplesPerPeak);

    const minPeaks = new Float32Array(actualPeakCount);
    const maxPeaks = new Float32Array(actualPeakCount);

    for (let i = 0; i < actualPeakCount; i++) {
        const start = i * samplesPerPeak;
        const end = Math.min(start + samplesPerPeak, totalSamples);

        let min = 1;
        let max = -1;

        for (let j = start; j < end; j++) {
            const value = channelData[j];
            if (value < min) min = value;
            if (value > max) max = value;
        }

        minPeaks[i] = min;
        maxPeaks[i] = max;
    }

    return {
        min: minPeaks,
        max: maxPeaks,
        length: actualPeakCount,
        samplesPerPeak,
        duration: audioBuffer.duration
    };
}

/**
 * Compute peaks from a URL (blob or file URL)
 */
export async function computePeaksFromUrl(url: string, targetPeakCount?: number): Promise<PeakData> {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();

    try {
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

        return computePeaks(audioBuffer, targetPeakCount);
    } finally {
        audioContext.close();
    }
}

export interface DrawWaveformOptions {
    x: number;
    y: number;
    width: number;
    height: number;
    color?: string;
    backgroundColor?: string;
    startTime?: number;  // Time in seconds to start drawing from
    endTime?: number;    // Time in seconds to end drawing at
    pixelsPerSecond?: number;
    scrollOffset?: number;
}

/**
 * Draw waveform to a canvas context using pre-computed peaks
 */
export function drawWaveform(
    ctx: CanvasRenderingContext2D,
    peaks: PeakData,
    options: DrawWaveformOptions
): void {
    const {
        x,
        y,
        width,
        height,
        color = '#FF0055',
        startTime = 0,
        endTime = peaks.duration,
        pixelsPerSecond = 50,
        scrollOffset = 0
    } = options;

    const centerY = y + height / 2;
    const amplitude = height / 2;

    ctx.fillStyle = color;
    ctx.globalAlpha = 0.8;

    // Calculate which peaks to draw
    const peaksPerSecond = peaks.length / peaks.duration;

    // For each pixel in the visible area
    for (let px = 0; px < width; px++) {
        // Convert pixel to time
        const time = (px + scrollOffset) / pixelsPerSecond;

        if (time < startTime || time > endTime) continue;

        // Convert time to peak index
        const peakIndex = Math.floor(time * peaksPerSecond);

        if (peakIndex < 0 || peakIndex >= peaks.length) continue;

        const min = peaks.min[peakIndex];
        const max = peaks.max[peakIndex];

        // Draw bar from min to max
        const yMin = centerY - (max * amplitude);
        const yMax = centerY - (min * amplitude);
        const barHeight = Math.max(1, yMax - yMin);

        ctx.fillRect(x + px, yMin, 1, barHeight);
    }

    ctx.globalAlpha = 1;
}


/**
 * Compute peaks using a Web Worker to avoid blocking the main thread
 */
export function computePeaksWorker(
    audioBuffer: AudioBuffer,
    targetPeakCount: number = 10000
): Promise<PeakData> {
    return new Promise((resolve, reject) => {
        // Create worker
        // Vite handles this import.meta.url magic
        const worker = new Worker(new URL('../workers/waveform.worker.ts', import.meta.url), {
            type: 'module'
        });

        const channelData = audioBuffer.getChannelData(0);

        worker.onmessage = (e) => {
            const { error, min, max, length, samplesPerPeak } = e.data;

            if (error) {
                reject(new Error(error));
            } else {
                resolve({
                    min,
                    max,
                    length,
                    samplesPerPeak,
                    duration: audioBuffer.duration
                });
            }
            worker.terminate(); // Cleanup
        };

        worker.onerror = (err) => {
            reject(err);
            worker.terminate();
        };

        // Send data
        worker.postMessage({
            channelData, // This will be cloned (or transferred if we used transfer list, but TypedArray is view)
            targetPeakCount
        });
    });
}


export default { computePeaks, computePeaksFromUrl, drawWaveform, computePeaksWorker };
