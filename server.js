
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
const port = process.env.PORT || 5000;

// Setup basic middleware
app.use(cors());
app.use(express.json());

// Setup file upload
const upload = multer({ dest: 'uploads/' });

// Initialize AssemblyAI
// In a real app, use .env. For this local tool, we use the provided key directly.
const client = new AssemblyAI({
    apiKey: process.env.ASSEMBLYAI_API_KEY || "5ff41fbb9f314b57b4f8036534243b6b"
});

app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
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

// Video Matching Endpoint (with context)
app.post('/api/video-matching', async (req, res) => {
    const { script } = req.body;

    if (!script || typeof script !== 'string') {
        return res.status(400).json({ error: 'Script is required' });
    }

    try {
        console.log('[Server] Starting video matching...');

        const { matchVideosToScript, generateScriptContext } = await import('./services/videoMatcher.js');

        // Generate script context first
        const context = await generateScriptContext(script);

        const results = await matchVideosToScript(script);

        console.log(`[Server] Video matching complete: ${results.length} blocks processed`);

        res.json({
            success: true,
            blocks: results,
            context: context
        });

    } catch (error) {
        console.error('[Server] Video matching error:', error);
        res.status(500).json({ error: error.message });
    }
});

// SSE Streaming endpoint for real-time progress
app.get('/api/video-matching/stream', async (req, res) => {
    const script = req.query.script;

    if (!script || typeof script !== 'string') {
        return res.status(400).json({ error: 'Script is required' });
    }

    // Setup SSE headers
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.flushHeaders();

    const sendEvent = (data) => {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
        console.log('[Server] Starting SSE video matching stream...');

        const { matchVideosToScriptWithProgress, generateScriptContext, parseScriptBlocks } = await import('./services/videoMatcher.js');

        // Parse blocks first to know total count
        const blocks = parseScriptBlocks(decodeURIComponent(script));

        // Generate and send script context
        const context = await generateScriptContext(decodeURIComponent(script));
        sendEvent({ type: 'context', context });

        // Process with progress callback
        const results = await matchVideosToScriptWithProgress(
            decodeURIComponent(script),
            (blockIndex, status, query, videoCount) => {
                sendEvent({
                    type: 'status',
                    blockIndex,
                    status,
                    query: query || null,
                    videoCount: videoCount || null
                });
            },
            (block) => {
                sendEvent({ type: 'block_complete', block });
            }
        );

        // Send complete event
        sendEvent({ type: 'complete', blocks: results });

        console.log(`[Server] SSE video matching complete: ${results.length} blocks`);

    } catch (error) {
        console.error('[Server] SSE Video matching error:', error);
        sendEvent({ type: 'error', message: error.message });
    } finally {
        res.end();
    }
});

// Re-search endpoint for individual blocks
app.post('/api/video-matching/research', async (req, res) => {
    const { block, customQuery } = req.body;

    if (!block) {
        return res.status(400).json({ error: 'Block data is required' });
    }

    try {
        const { reSearchBlock } = await import('./services/videoMatcher.js');
        const result = await reSearchBlock(block, customQuery);

        res.json({
            success: true,
            block: result
        });

    } catch (error) {
        console.error('[Server] Re-search error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.listen(port, () => {
    console.log(`\n==================================================`);
    console.log(`🚀 ClickSync Server running on http://localhost:${port}`);
    console.log(`==================================================\n`);
});
