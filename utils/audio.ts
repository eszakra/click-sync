/**
 * Reads a File object as an ArrayBuffer
 */
export const readFileAsArrayBuffer = (file: File): Promise<ArrayBuffer> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
};

/**
 * Converts a File object to a Base64 string (for Gemini API)
 */
export const fileToBase64 = (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Remove the Data-URI prefix (e.g. "data:audio/mp3;base64,")
      const base64 = result.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

/**
 * Creates a WAV file Blob from an AudioBuffer
 */
const bufferToWav = (buffer: AudioBuffer): Blob => {
  const numOfChan = buffer.numberOfChannels;
  const length = buffer.length * numOfChan * 2 + 44;
  const bufferArr = new ArrayBuffer(length);
  const view = new DataView(bufferArr);
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
  setUint32(buffer.sampleRate);
  setUint32(buffer.sampleRate * 2 * numOfChan); // avg. bytes/sec
  setUint16(numOfChan * 2); // block-align
  setUint16(16); // 16-bit (hardcoded in this encoder)

  setUint32(0x61746164); // "data" - chunk
  setUint32(length - pos - 4); // chunk length

  // write interleaved data
  for (i = 0; i < buffer.numberOfChannels; i++)
    channels.push(buffer.getChannelData(i));

  while (pos < buffer.length) {
    for (i = 0; i < numOfChan; i++) {
      // interleave channels
      sample = Math.max(-1, Math.min(1, channels[i][pos])); // clamp
      sample = (0.5 + sample < 0 ? sample * 32768 : sample * 32767) | 0; // scale to 16-bit signed int
      view.setInt16(44 + offset, sample, true); // write 16-bit sample
      offset += 2;
    }
    pos++;
  }

  return new Blob([bufferArr], { type: 'audio/wav' });

  function setUint16(data: number) {
    view.setUint16(pos, data, true);
    pos += 2;
  }

  function setUint32(data: number) {
    view.setUint32(pos, data, true);
    pos += 4;
  }
};

/**
 * Slices an AudioBuffer from start time to end time and returns a Blob URL
 */
export const sliceAudio = async (
  originalBuffer: AudioBuffer,
  startTime: number,
  endTime: number,
  context: AudioContext
): Promise<string> => {
  const sampleRate = originalBuffer.sampleRate;
  
  // Validate times
  const startFrame = Math.floor(Math.max(0, startTime) * sampleRate);
  const endFrame = Math.floor(Math.min(originalBuffer.duration, endTime) * sampleRate);
  const frameCount = endFrame - startFrame;

  if (frameCount <= 0) {
    throw new Error(`Invalid time range: ${startTime} to ${endTime}`);
  }

  // Create empty buffer
  const newBuffer = context.createBuffer(
    originalBuffer.numberOfChannels,
    frameCount,
    sampleRate
  );

  // Copy data
  for (let channel = 0; channel < originalBuffer.numberOfChannels; channel++) {
    const originalChannelData = originalBuffer.getChannelData(channel);
    const newChannelData = newBuffer.getChannelData(channel);
    
    // Using subarray is more efficient than a loop, but we need to copy to the new buffer
    // Float32Array.set is fast
    const slice = originalChannelData.subarray(startFrame, endFrame);
    newChannelData.set(slice);
  }

  // Encode to WAV blob
  const blob = bufferToWav(newBuffer);
  return URL.createObjectURL(blob);
};