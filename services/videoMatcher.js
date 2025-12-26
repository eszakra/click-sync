import { GoogleGenerativeAI } from '@google/generative-ai';
import { getVioryScraper } from './vioryScraper.js';

// API Key
const GEMINI_API_KEY = "AIzaSyCp9B_OTNMBfRmE26o7zKFUzr4d1rnrQPU";

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/**
 * Parse script into blocks based on [ON SCREEN: ...] markers
 * @param {string} script
 * @returns {Array<{index: number, headline: string, text: string}>}
 */
export function parseScriptBlocks(script) {
    const blocks = [];

    // Normalize newlines
    const cleanScript = script.replace(/\r\n/g, '\n');

    // Regex to find [ON SCREEN: ...] markers
    const markerRegex = /\[ON\s*SCREEN[:\s-]*([^\]]+)\]/gi;

    const matches = Array.from(cleanScript.matchAll(markerRegex));

    for (let i = 0; i < matches.length; i++) {
        const currentMatch = matches[i];
        const headline = currentMatch[1].trim();

        // Get text between current marker and next marker (or end of script)
        const textStart = currentMatch.index + currentMatch[0].length;
        const textEnd = (i < matches.length - 1) ? matches[i + 1].index : cleanScript.length;
        const text = cleanScript.substring(textStart, textEnd).trim();

        blocks.push({
            index: i,
            headline,
            text
        });
    }

    return blocks;
}

/**
 * Generate a search query using Gemini AI based on the headline and context
 * @param {{index: number, headline: string, text: string}} block
 * @returns {Promise<string>}
 */
async function generateSearchQuery(block) {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const prompt = `You are a video researcher for a news platform. Find relevant footage on Viory.video.
The search engine is KEYWORD-BASED. It needs SPECIFIC ENTITIES.

Script Block:
Headline: "${block.headline}"
Context: "${block.text.substring(0, 300)}"

QUERY GENERATION RULES:
1. **ENTITIES ARE KING**: Identify the main people, countries, or organizations.
   - **Single Entity**: If focus is one person/thing -> "Donald Trump"
   - **Dual Entities**: IF TWO PEOPLE INTERACT, USE BOTH NAMES -> "Putin Yvan Gil", "Biden Trump", "NASA SpaceX"
   - **Specific Context**: "Putin Meeting", "Trump Speech" (only if specific action matters).
   
2. **DO NOT OVERSIMPLIFY**:
   - If the script mentions "Putin meeting Yvan Gil", searching ONLY "Putin" is bad. Search "Putin Yvan Gil".
   - If the script mentions "Venezuela and Russia", search "Venezuela Russia".
   
3. **ESSENTIAL ACTION ONLY**: You may add ONE keyword for specific event types if crucial.
   - Acceptable: "Speech", "Meeting", "Protest", "Launch", "Interview"
   - Examples: "Zelensky Speech", "Paris Protest", "Trump Interview"

4. **KEEP IT TIGHT**: 
   - Maximum 4-5 words.
   - NO fluff words ("footage of", "about", "showing", "video").
   - NO generic descriptions ("people talking", "walking in city").

5. **FALLBACK**: If no specific entity, use the core specific NOUNs (e.g., "Bitcoin", "Wildfire", "Stock Market").

OUTPUT: Return ONLY the search query string. Nothing else.`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let query = response.text().trim()
            .replace(/["'`]/g, '')
            .replace(/^search query:?\s*/i, '')
            .replace(/^query:?\s*/i, '')
            .trim();

        // Relaxed limit to allows multi-entity queries (e.g. "Person A Person B Context")
        const words = query.split(/\s+/);
        if (words.length > 5) {
            query = words.slice(0, 5).join(' ');
        }

        console.log(`[VideoMatcher] Block ${block.index} "${block.headline}" -> Search: "${query}"`);
        return query;
    } catch (error) {
        console.error('[VideoMatcher] Gemini error:', error);
        // Fallback: use the headline itself, cleaned up
        const fallback = block.headline
            .replace(/[^a-zA-Z0-9\s]/g, '')
            .split(' ')
            .filter(w => w.length > 2)
            .slice(0, 2) // Limit fallback to 2 words
            .join(' ');
        console.log(`[VideoMatcher] Using fallback query: "${fallback}"`);
        return fallback || 'news';
    }
}

/**
 * Match videos to all script blocks
 * Each block gets its own unique search query and videos
 * @param {string} script
 * @param {Function} [onBlockProgress]
 * @returns {Promise<Array>}
 */
export async function matchVideosToScript(script, onBlockProgress) {
    const blocks = parseScriptBlocks(script);

    if (blocks.length === 0) {
        throw new Error('No [ON SCREEN: ...] markers found in the script');
    }

    console.log(`[VideoMatcher] Found ${blocks.length} blocks to process`);

    const scraper = await getVioryScraper();
    const results = [];

    // Process each block SEQUENTIALLY to ensure unique results
    for (const block of blocks) {
        if (onBlockProgress) {
            onBlockProgress(block.index, 'generating_query');
        }

        // Generate unique search query for this block
        const searchQuery = await generateSearchQuery(block);

        if (onBlockProgress) {
            onBlockProgress(block.index, 'searching_videos');
        }

        // Search for videos with this specific query
        // Each search creates a NEW page to avoid caching issues
        // FETCH 30 VIDEOS to support "View More"
        const videos = await scraper.searchVideos(searchQuery, 30);

        results.push({
            ...block,
            searchQuery,
            videos,
            status: 'complete'
        });

        console.log(`[VideoMatcher] Block ${block.index} completed with ${videos.length} videos`);

        // Small delay between requests to be respectful to the server
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    return results;
}

/**
 * Match videos with progress callbacks for SSE streaming
 * @param {string} script
 * @param {Function} onStatusUpdate - (blockIndex, status, query, videoCount) => void
 * @param {Function} onBlockComplete - (block) => void
 * @returns {Promise<Array>}
 */
export async function matchVideosToScriptWithProgress(script, onStatusUpdate, onBlockComplete) {
    const blocks = parseScriptBlocks(script);

    if (blocks.length === 0) {
        throw new Error('No [ON SCREEN: ...] markers found in the script');
    }

    console.log(`[VideoMatcher] SSE: Found ${blocks.length} blocks to process`);

    const scraper = await getVioryScraper();
    const results = [];

    // Send initial waiting status for all blocks
    for (const block of blocks) {
        onStatusUpdate(block.index, 'waiting', null, null);
    }

    // Process each block SEQUENTIALLY
    for (const block of blocks) {
        // Status: generating query
        onStatusUpdate(block.index, 'generating_query', null, null);

        // Generate search query
        const searchQuery = await generateSearchQuery(block);

        // Status: searching with query
        onStatusUpdate(block.index, 'searching', searchQuery, null);

        // Search for videos
        const videos = await scraper.searchVideos(searchQuery, 30);

        const completedBlock = {
            ...block,
            searchQuery,
            videos,
            status: 'complete'
        };

        // Status: complete with video count
        onStatusUpdate(block.index, 'complete', searchQuery, videos.length);

        // Send block complete event
        onBlockComplete(completedBlock);

        results.push(completedBlock);

        console.log(`[VideoMatcher] SSE: Block ${block.index} completed with ${videos.length} videos`);

        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 300));
    }

    return results;
}

/**
 * Generate a summary/context for the entire script
 * @param {string} script
 * @returns {Promise<string>}
 */
export async function generateScriptContext(script) {
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
        const context = response.text().trim().replace(/^["']|["']$/g, '');

        console.log(`[VideoMatcher] Script context: "${context}"`);
        return context;
    } catch (error) {
        console.error('[VideoMatcher] Context generation error:', error);
        return 'News script analysis';
    }
}

/**
 * Re-search videos for a specific block with a new query
 * @param {Object} block
 * @param {string} [customQuery]
 * @returns {Promise<Object>}
 */
export async function reSearchBlock(block, customQuery) {
    const scraper = await getVioryScraper();

    const searchQuery = customQuery || await generateSearchQuery(block);
    const videos = await scraper.searchVideos(searchQuery, 30);

    return {
        ...block,
        searchQuery,
        videos,
        status: 'complete'
    };
}

