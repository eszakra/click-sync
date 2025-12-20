
import { GOOGLE_SPEECH_API_KEY } from '../config';

interface WordInfo {
    startTime: string;
    endTime: string;
    word: string;
}

interface SpeechRecognitionAuth {
    results?: {
        alternatives?: {
            words?: WordInfo[];
            transcript?: string;
        }[];
    }[];
}

export const transcribeAudio = async (audioBlob: Blob): Promise<WordInfo[]> => {
    // Convert Blob to Base64
    const reader = new FileReader();
    const base64Audio = await new Promise<string>((resolve, reject) => {
        reader.onloadend = () => {
            const result = reader.result as string;
            // Remove data URL prefix (e.g., "data:audio/mp3;base64,")
            const base64 = result.split(',')[1];
            resolve(base64);
        };
        reader.onerror = reject;
        reader.readAsDataURL(audioBlob);
    });

    const url = `https://speech.googleapis.com/v1/speech:recognize?key=${GOOGLE_SPEECH_API_KEY}`;

    const requestBody = {
        config: {
            encoding: "MP3", // Assumes MP3 for now, standard for voiceovers. Can detect if needed.
            sampleRateHertz: 44100, // Standard. If failed, might need to read header or use LINEAR16 if wav.
            languageCode: "en-US", // Defaulting to English as per script example
            enableWordTimeOffsets: true,
            model: "default"
        },
        audio: {
            content: base64Audio
        }
    };

    // Basic check for WAV to adjust config
    if (audioBlob.type.includes('wav')) {
        // @ts-ignore
        requestBody.config.encoding = "LINEAR16";
        delete requestBody.config.sampleRateHertz; // Let API detect or default
    }


    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
        const error = await response.json();
        throw new Error(`Speech API Error: ${error.error?.message || response.statusText}`);
    }

    const data: SpeechRecognitionAuth = await response.json();

    const allWords: WordInfo[] = [];

    if (data.results) {
        data.results.forEach(result => {
            if (result.alternatives && result.alternatives[0].words) {
                allWords.push(...result.alternatives[0].words);
            }
        });
    }

    return allWords;
};
