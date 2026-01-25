import React, { useEffect, useRef, useState } from 'react';

interface WaveformTrackProps {
    audioUrl: string | null;
    width: number;
    height: number;
    duration: number;
}

export const WaveformTrack: React.FC<WaveformTrackProps> = ({ audioUrl, width, height, duration }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);

    // 1. Decode Audio
    useEffect(() => {
        if (!audioUrl) return;

        const loadAudio = async () => {
            try {
                const response = await fetch(audioUrl);
                const arrayBuffer = await response.arrayBuffer();
                const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
                const decoded = await audioCtx.decodeAudioData(arrayBuffer);
                setAudioBuffer(decoded);
            } catch (e) {
                console.error("Waveform decode failed", e);
            }
        };

        loadAudio();
    }, [audioUrl]);

    // 2. Draw Waveform
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !audioBuffer) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // Clear
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Styling
        ctx.fillStyle = '#FF0055'; // Vibrant Pink/Red

        // Data Extraction
        const data = audioBuffer.getChannelData(0);
        // We want to fit 'duration' seconds into 'width' pixels
        // But the timeline width might be zoomed. 
        // IMPORTANT: The parent container sets the width in % or pixels proportional to zoom.
        // We should draw to match that width.

        // Step size: how many samples per pixel
        const step = Math.ceil(data.length / width);
        const amp = height / 2;

        ctx.beginPath();
        for (let i = 0; i < width; i++) {
            let min = 1.0;
            let max = -1.0;

            // Find max/min in this chunk
            for (let j = 0; j < step; j++) {
                const datum = data[(i * step) + j];
                if (datum < min) min = datum;
                if (datum > max) max = datum;
            }

            // Draw bar
            // If silent (min > max due to init), skip
            if (max > min) {
                const x = i;
                const y = (1 + min) * amp;
                const h = Math.max(1, (max - min) * amp);
                ctx.fillRect(x, height / 2 - h / 2, 1, h);
            }
        }
    }, [audioBuffer, width, height]);

    return (
        <canvas
            ref={canvasRef}
            width={width}
            height={height}
            style={{
                width: '100%',
                height: '100%',
                display: 'block',
                opacity: 0.8
            }}
        />
    );
};
