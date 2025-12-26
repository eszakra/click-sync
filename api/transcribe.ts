import type { VercelRequest, VercelResponse } from '@vercel/node';
import { AssemblyAI } from 'assemblyai';
import formidable from 'formidable';
import fs from 'fs';

export const config = {
    api: {
        bodyParser: false, // Required for file uploads
    },
};

const client = new AssemblyAI({
    apiKey: process.env.ASSEMBLYAI_API_KEY || "5ff41fbb9f314b57b4f8036534243b6b"
});

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const form = formidable({ uploadDir: '/tmp', keepExtensions: true });

        const [fields, files] = await form.parse(req);
        const audioFile = files.audio?.[0];

        if (!audioFile) {
            return res.status(400).json({ error: 'No audio file uploaded' });
        }

        console.log(`[Transcribe API] Processing: ${audioFile.originalFilename}`);

        // Upload to AssemblyAI
        const uploadUrl = await client.files.upload(audioFile.filepath);

        // Transcribe
        const transcript = await client.transcripts.transcribe({
            audio_url: uploadUrl,
        });

        if (transcript.status === 'error') {
            throw new Error(transcript.error);
        }

        // Cleanup
        fs.unlinkSync(audioFile.filepath);

        res.json({
            text: transcript.text,
            words: transcript.words
        });

    } catch (error: any) {
        console.error('[Transcribe API] Error:', error);
        res.status(500).json({ error: error.message });
    }
}
