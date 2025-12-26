import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleGenerativeAI } from '@google/generative-ai';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "AIzaSyCp9B_OTNMBfRmE26o7zKFUzr4d1rnrQPU";
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// Parse script into blocks
function parseScriptBlocks(script: string) {
    const blocks: { index: number; headline: string; text: string }[] = [];
    const regex = /\[ON\s*SCREEN:\s*([^\]]+)\]/gi;
    let match;
    let lastIndex = 0;
    let blockIndex = 0;

    while ((match = regex.exec(script)) !== null) {
        if (blockIndex > 0 && lastIndex < match.index) {
            const text = script.substring(lastIndex, match.index).trim();
            if (blocks.length > 0) {
                blocks[blocks.length - 1].text = text;
            }
        }
        blocks.push({
            index: blockIndex++,
            headline: match[1].trim(),
            text: ''
        });
        lastIndex = regex.lastIndex;
    }

    if (blocks.length > 0) {
        blocks[blocks.length - 1].text = script.substring(lastIndex).trim();
    }

    return blocks;
}

// Generate search query using Gemini
async function generateSearchQuery(headline: string, text: string): Promise<string> {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const prompt = `Generate a 3-5 word search query for finding news video footage.
Headline: "${headline}"
Context: "${text.substring(0, 200)}"

Rules:
- Focus on main entities (people, organizations, locations)
- Use specific names, not generic descriptions
- Return ONLY the search query, nothing else

Example outputs:
- "Putin Biden summit Geneva"
- "Ukraine NATO military support"
- "Venezuela Maduro protests"`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text().trim().replace(/['"]/g, '');
    } catch (error) {
        console.error('Query generation error:', error);
        return headline.split(' ').slice(0, 4).join(' ');
    }
}

// Generate Spanish context summary
async function generateScriptContext(script: string): Promise<string> {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const prompt = `Analiza este guion de noticias y proporciona un resumen de UNA ORACIÓN en ESPAÑOL sobre de qué trata.
Centra el resumen en los temas principales, personas y eventos mencionados.

Script:
"""
${script.substring(0, 1500)}
"""

Devuelve SOLO la oración del resumen en ESPAÑOL, nada más. Manténlo en menos de 50 palabras.
Ejemplo: "Cobertura del conflicto entre Ucrania y Rusia centrada en el apoyo militar de la OTAN y las negociaciones diplomáticas."`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text().trim();
    } catch (error) {
        console.error('Context generation error:', error);
        return 'Resumen no disponible';
    }
}

// Mock video search (Viory scraping doesn't work on serverless - use placeholder)
async function searchVideos(query: string): Promise<any[]> {
    // In serverless, we can't use Playwright. Return placeholder or use an API.
    // For demo purposes, return mock data
    return [
        {
            title: `${query} - Video Result`,
            url: `https://viory.video/?search=${encodeURIComponent(query)}`,
            thumbnail: '',
            duration: '2:30'
        }
    ];
}

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

    const { script } = req.body;

    if (!script || typeof script !== 'string') {
        return res.status(400).json({ error: 'Script is required' });
    }

    try {
        console.log('[Video Matching API] Starting...');

        // Generate context
        const context = await generateScriptContext(script);

        // Parse blocks
        const blocks = parseScriptBlocks(script);

        // Process each block
        const results = await Promise.all(blocks.map(async (block) => {
            const searchQuery = await generateSearchQuery(block.headline, block.text);
            const videos = await searchVideos(searchQuery);

            return {
                ...block,
                searchQuery,
                videos
            };
        }));

        console.log(`[Video Matching API] Processed ${results.length} blocks`);

        res.json({
            success: true,
            blocks: results,
            context
        });

    } catch (error: any) {
        console.error('[Video Matching API] Error:', error);
        res.status(500).json({ error: error.message });
    }
}
