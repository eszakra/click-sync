
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import { AssemblyAI } from 'assemblyai';
import { GoogleGenerativeAI } from '@google/generative-ai'; // Added Gemini SDK
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

// Fix for __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = process.env.PORT || 5000;

// Setup basic middleware
app.use(cors());
app.use(express.json());

// Helper: Get Gemini Key
const DEFAULT_GEMINI_KEY = "AIzaSyC0QCO0_h3jb6l2rDV738Rv8hAvf6_5atk"; // Fallback
const getGeminiKey = () => {
    try {
        const configPath = path.join(os.homedir(), '.clicksync', 'config.json');
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (data.geminiKey && data.geminiKey.length > 10) return data.geminiKey.trim();
        }
    } catch (e) { }
    return DEFAULT_GEMINI_KEY;
};

// Setup file upload - use temp directory (works in Program Files)
const uploadsDir = path.join(os.tmpdir(), 'clicksync-uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
const upload = multer({ dest: uploadsDir });

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

// Generate Project Title Endpoint
app.post('/api/generate-title', async (req, res) => {
    const { script } = req.body;
    if (!script) return res.status(400).json({ error: 'Script required' });

    console.log("[Server] Generating AI Title...");

    try {
        // Use Gemini directly here to avoid stale JS imports
        const genAI = new GoogleGenerativeAI(getGeminiKey());
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `
        Analyze the following video script and generate a SINGLE, professional, catchy YouTube title.
        
        Rules:
        1. Read the entire script context.
        2. Create a title that reflects the core topic professionally.
        3. Do NOT use clickbait styles like "YOU WON'T BELIEVE".
        4. Return ONLY the title text. No quotes.
        5. Maximum 60 characters.
        
        Script:
        "${script.substring(0, 5000)}"
        `;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const title = text.trim().replace(/^"|"$/g, '').replace(/\n/g, ' ');

        console.log(`[Server] Generated Title: ${title}`);
        res.json({ title });

    } catch (e) {
        console.error("[Server] Title Gen Error:", e);
        res.json({ title: `Project ${new Date().toLocaleDateString()}` });
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

// STREAMING POST endpoint (Solves '431 Header Too Large' issue with GET/EventSource)
app.post('/api/video-matching/stream', async (req, res) => {
    const { script } = req.body;

    if (!script || typeof script !== 'string') {
        return res.status(400).json({ error: 'Script is required' });
    }

    // Setup headers for streaming text response (NDJSON)
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Connection', 'keep-alive');

    // We don't use event-stream format anymore, just raw JSON lines
    const sendEvent = (data) => {
        // Send as a single line of JSON followed by newline
        res.write(JSON.stringify(data) + '\n');
    };

    try {
        console.log('[Server] Starting Streaming POST video matching...');

        const { matchVideosToScriptWithProgress, generateScriptContext, parseScriptBlocks } = await import('./services/videoMatcher.js');

        // Parse blocks first to know total count
        const blocks = parseScriptBlocks(script);

        // Generate and send script context IMMEDIATELY (user sees this first)
        const contextSummary = await generateScriptContext(script);
        sendEvent({ type: 'context', context: contextSummary });

        // Process with progress callback (globalContext calculated internally)
        const results = await matchVideosToScriptWithProgress(
            script,
            (blockIndex, status, data) => {
                // data now includes detailed attempt info: query, videoCount, attemptNum, maxAttempts, fallbackReason, queriesAttempted
                sendEvent({
                    type: 'status',
                    blockIndex,
                    status,
                    query: data?.query || null,
                    videoCount: data?.videoCount || null,
                    attemptNum: data?.attemptNum || null,
                    maxAttempts: data?.maxAttempts || null, // e.g. "Attempt 2/5"
                    fallbackReason: data?.fallbackReason || null,
                    queriesAttempted: data?.queriesAttempted || null
                });
            },
            (block) => {
                sendEvent({ type: 'block_complete', block });
            }
        );

        // Send complete event
        sendEvent({ type: 'complete', blocks: results });

        console.log(`[Server] Streaming complete: ${results.length} blocks`);

    } catch (error) {
        console.error('[Server] Streaming error:', error);
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
        fs.appendFileSync('server_debug.log', `[${new Date().toISOString()}] Re-search Error: ${error.stack}\n`);
        res.status(500).json({ error: error.message });
    }
});

// SSE Streaming endpoint for SINGLE block search with real-time progress
app.get('/api/video-matching/research-stream', async (req, res) => {
    // ... existing ... (keeping existing logic, just making sure I append after it)
    const blockData = req.query.block;

    if (!blockData) {
        return res.status(400).json({ error: 'Block data is required' });
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
        const block = JSON.parse(decodeURIComponent(blockData));
        const { reSearchBlockWithProgress } = await import('./services/videoMatcher.js');

        const result = await reSearchBlockWithProgress(block, null, (status, data) => {
            // Send real-time progress
            sendEvent({
                type: 'progress',
                status,
                message: data?.message || data?.query || status,
                query: data?.query,
                attemptNum: data?.attemptNum,
                maxAttempts: data?.maxAttempts,
                fallbackReason: data?.fallbackReason
            });
        });

        // Send final result
        sendEvent({ type: 'complete', block: result });

    } catch (error) {
        console.error('[Server] SSE Re-search error:', error);
        sendEvent({ type: 'error', message: error.message });
    } finally {
        res.end();
    }
});

// CONFIGURATION ENDPOINT
app.post('/api/config/key', (req, res) => {
    const { key } = req.body;
    if (!key || key.length < 10) {
        return res.status(400).json({ success: false, error: "Invalid API Key" });
    }

    try {
        const configDir = path.join(os.homedir(), '.clicksync');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        const configPath = path.join(configDir, 'config.json');

        // Read existing config or create new
        let config = {};
        if (fs.existsSync(configPath)) {
            config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        }

        // Update key
        config.geminiKey = key;

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[Server] API Key updated in ${configPath}`);

        res.json({ success: true });
    } catch (e) {
        console.error("[Server] Failed to save config:", e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// Export start function for Electron integration
export async function startServer() {
    return new Promise((resolve, reject) => {
        try {
            const server = app.listen(port, () => {
                console.log(`\n==================================================`);
                console.log(`🚀 ClickSync Server running on http://localhost:${port}`);
                console.log(`==================================================\n`);
                resolve(server);
            });
            server.on('error', (e) => reject(e));
        } catch (e) {
            reject(e);
        }
    });
}

// Auto-start if run directly (node server.js)
// Check if this is the main module being executed
const isMainModule = process.argv[1] && (
    process.argv[1].endsWith('server.js') ||
    process.argv[1].includes('server.js')
);

if (isMainModule) {
    startServer().catch(err => {
        console.error('Failed to start server:', err);
        process.exit(1);
    });
}
