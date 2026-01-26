/// <reference lib="webworker" />

/**
 * Web Worker for computing audio peaks
 * Handles heavy Float32Array iterations off the main thread.
 */

self.onmessage = (e: MessageEvent) => {
    const { channelData, targetPeakCount } = e.data;

    // Safety checks
    if (!channelData || !channelData.length) {
        self.postMessage({ error: 'No channel data provided' });
        return;
    }

    try {
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

            // Tight loop for performance
            for (let j = start; j < end; j++) {
                const value = channelData[j];
                if (value < min) min = value;
                if (value > max) max = value;
            }

            minPeaks[i] = min;
            maxPeaks[i] = max;
        }

        // Post back results
        // Transfer the arrays to avoid copying if possible (check browser support, but usually copy for TypedArrays in msg)
        self.postMessage({
            min: minPeaks,
            max: maxPeaks,
            length: actualPeakCount,
            samplesPerPeak
        });

    } catch (err) {
        self.postMessage({ error: (err as Error).message });
    }
};
