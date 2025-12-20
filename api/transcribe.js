
import { AssemblyAI } from 'assemblyai';

export default async function handler(req, res) {
    // CORS Configuration
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { audioUrl } = req.body;

        if (!audioUrl) {
            return res.status(400).json({ error: 'Missing audioUrl' });
        }

        const apiKey = process.env.ASSEMBLYAI_API_KEY || "5ff41fbb9f314b57b4f8036534243b6b";

        const client = new AssemblyAI({ apiKey });

        // Transcribe
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
        console.error('Transcription error:', error);
        res.status(500).json({ error: error.message });
    }
}
