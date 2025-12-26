
import { AssemblyAI } from 'assemblyai';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { audioUrl } = req.body;

    if (!audioUrl) {
        return res.status(400).json({ error: 'Audio URL is required' });
    }

    try {
        console.log('[API] Transcribing URL:', audioUrl);

        const client = new AssemblyAI({
            apiKey: "5ff41fbb9f314b57b4f8036534243b6b" // Hardcoded for this demo, usually env var
        });

        const transcript = await client.transcripts.transcribe({
            audio_url: audioUrl,
        });

        if (transcript.status === 'error') {
            throw new Error(transcript.error);
        }

        res.status(200).json({
            text: transcript.text,
            words: transcript.words
        });

    } catch (error) {
        console.error('[API] Transcription error:', error);
        res.status(500).json({ error: error.message });
    }
}
