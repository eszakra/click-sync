
export const decodeAudio = async (audioBlob: Blob): Promise<AudioBuffer> => {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const audioContext = new AudioContext();
    return await audioContext.decodeAudioData(arrayBuffer);
};

export const sliceAudioBuffer = async (
    originalBuffer: AudioBuffer,
    startTime: number,
    endTime: number
): Promise<Blob> => {
    const sampleRate = originalBuffer.sampleRate;
    // Calculate start and end samples
    let startSample = Math.floor(startTime * sampleRate);
    let endSample = Math.floor(endTime * sampleRate);

    // Safety checks
    if (startSample < 0) startSample = 0;
    if (endSample > originalBuffer.length) endSample = originalBuffer.length;
    if (startSample >= endSample) {
        // Return minimal silence if invalid
        startSample = 0;
        endSample = 0;
    }

    const frameCount = endSample - startSample;
    const numberOfChannels = originalBuffer.numberOfChannels;

    // Create new OfflineAudioContext to render the slice (or just copy data)
    // Copying data is faster and synchronous
    const newBuffer = new AudioBuffer({
        length: frameCount || 1, // Prevent 0 length
        numberOfChannels: numberOfChannels,
        sampleRate: sampleRate
    });

    for (let channel = 0; channel < numberOfChannels; channel++) {
        const nowBuffering = newBuffer.getChannelData(channel);
        const originalBuffering = originalBuffer.getChannelData(channel);
        try {
            // Copy the slice
            for (let i = 0; i < frameCount; i++) {
                nowBuffering[i] = originalBuffering[startSample + i];
            }
        } catch (e) {
            console.error("Error copying channel data", e);
        }
    }

    return bufferToWav(newBuffer);
};

// Simple WAV encoder
function bufferToWav(abuffer: AudioBuffer) {
    const numOfChan = abuffer.numberOfChannels;
    const length = abuffer.length * numOfChan * 2 + 44;
    const buffer = new ArrayBuffer(length);
    const view = new DataView(buffer);
    const channels = [];
    let i;
    let sample;
    let offset = 0;
    let pos = 0;

    // write WAVE header
    setUint32(0x46464952); // "RIFF"
    setUint32(length - 8); // file length - 8
    setUint32(0x45564157); // "WAVE"

    setUint32(0x20746d66); // "fmt " chunk
    setUint32(16); // length = 16
    setUint16(1); // PCM (uncompressed)
    setUint16(numOfChan);
    setUint32(abuffer.sampleRate);
    setUint32(abuffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
    setUint16(numOfChan * 2); // block-align
    setUint16(16); // 16-bit (hardcoded in this loop)

    setUint32(0x61746164); // "data" - chunk
    setUint32(length - pos - 4); // chunk length

    // write interleaved data
    for (i = 0; i < abuffer.numberOfChannels; i++)
        channels.push(abuffer.getChannelData(i));

    while (pos < abuffer.length) {
        for (i = 0; i < numOfChan; i++) { // interleave channels
            sample = Math.max(-1, Math.min(1, channels[i][pos])); // clamp
            sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
            view.setInt16(44 + offset, sample, true); // write 16-bit sample
            offset += 2;
        }
        pos++;
    }

    // helper functions
    function setUint16(data: any) {
        view.setUint16(pos, data, true);
        pos += 2;
    }

    function setUint32(data: any) {
        view.setUint32(pos, data, true);
        pos += 4;
    }

    return new Blob([buffer], { type: "audio/wav" });
}
