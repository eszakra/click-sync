
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { AssemblyAI } from 'assemblyai';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 5000;

// Setup basic middleware
app.use(cors());
app.use(express.json());

// Setup file upload
const upload = multer({ dest: 'uploads/' });

// Initialize AssemblyAI
// In a real app, use .env. For this local tool, we use the provided key directly.
const client = new AssemblyAI({
    apiKey: "5ff41fbb9f314b57b4f8036534243b6b"
});

app.post('/transcribe', upload.single('audio'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const filePath = req.file.path;

    try {
        console.log(`[Server] Uploading file for transcription: ${req.file.originalname}`);

        // 1. Upload to AssemblyAI
        const uploadUrl = await client.files.upload(filePath);

        // 2. Transcribe
        const transcript = await client.transcripts.transcribe({
            audio_url: uploadUrl,
            word_boost: [], // Optional: Boost specific words if needed
        });

        // 3. Check status (SDK handles polling by default with .transcribe)
        if (transcript.status === 'error') {
            throw new Error(transcript.error);
        }

        // Only return the words and text
        res.json({
            text: transcript.text,
            words: transcript.words // Array of { text, start, end, confidence }
        });

    } catch (error) {
        console.error('[Server] Error:', error);
        res.status(500).json({ error: error.message });
    } finally {
        // Cleanup: Delete temp file
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
});

app.listen(port, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 ClickSync Server running on http://localhost:${port}`);
    console.log(`==================================================\n`);
});
