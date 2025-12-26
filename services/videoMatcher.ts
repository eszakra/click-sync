import { GoogleGenerativeAI } from '@google/generative-ai';
import { getVioryScraper, VideoResult } from './vioryScraper.js';

// API Key (from config.ts)
const GEMINI_API_KEY = "AIzaSyCp9B_OTNMBfRmE26o7zKFUzr4d1rnrQPU";

export interface ScriptBlock {
    index: number;
    headline: string;
    text: string;
}

export interface BlockWithVideos extends ScriptBlock {
    searchQuery: string;
    videos: VideoResult[];
    isLoading?: boolean;
}

// Initialize Gemini
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

/**
 * Parse script into blocks based on [ON SCREEN: ...] markers
 */
export function parseScriptBlocks(script: string): ScriptBlock[] {
    const blocks: ScriptBlock[] = [];

    // Normalize newlines
    const cleanScript = script.replace(/\r\n/g, '\n');

    // Regex to find [ON SCREEN: ...] markers
    const markerRegex = /\[ON\s*SCREEN[:\s-]*([^\]]+)\]/gi;

    const matches = Array.from(cleanScript.matchAll(markerRegex));

    for (let i = 0; i < matches.length; i++) {
        const currentMatch = matches[i];
        const headline = currentMatch[1].trim();

        // Get text between current marker and next marker (or end of script)
        const textStart = currentMatch.index! + currentMatch[0].length;
        const textEnd = (i < matches.length - 1) ? matches[i + 1].index! : cleanScript.length;
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
 */
async function generateSearchQuery(block: ScriptBlock): Promise<string> {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        const prompt = `You are helping find stock video footage. Given this news headline and context, generate a SHORT search query (2-4 words) that would find relevant B-roll video footage.

Headline: "${block.headline}"
Context: "${block.text.substring(0, 200)}"

Rules:
- Return ONLY the search query, nothing else
- Keep it to 2-4 words maximum
- Focus on visual keywords (people, places, actions)
- No quotes or special characters

Search query:`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const query = response.text().trim().replace(/["']/g, '');

        console.log(`[VideoMatcher] Block ${block.index} search query: "${query}"`);
        return query;
    } catch (error) {
        console.error('[VideoMatcher] Gemini error:', error);
        // Fallback: use the headline itself
        return block.headline.split(' ').slice(0, 3).join(' ');
    }
}

/**
 * Match videos to all script blocks
 * Each block gets its own unique search query and videos
 */
export async function matchVideosToScript(
    script: string,
    onBlockProgress?: (blockIndex: number, status: string) => void
): Promise<BlockWithVideos[]> {
    const blocks = parseScriptBlocks(script);

    if (blocks.length === 0) {
        throw new Error('No [ON SCREEN: ...] markers found in the script');
    }

    console.log(`[VideoMatcher] Found ${blocks.length} blocks to process`);

    const scraper = await getVioryScraper();
    const results: BlockWithVideos[] = [];

    // Process each block SEQUENTIALLY to ensure unique results
    for (const block of blocks) {
        onBlockProgress?.(block.index, 'generating_query');

        // Generate unique search query for this block
        const searchQuery = await generateSearchQuery(block);

        onBlockProgress?.(block.index, 'searching_videos');

        // Search for videos with this specific query
        // Each search creates a NEW page to avoid caching issues
        const videos = await scraper.searchVideos(searchQuery);

        results.push({
            ...block,
            searchQuery,
            videos
        });

        console.log(`[VideoMatcher] Block ${block.index} completed with ${videos.length} videos`);

        // Small delay between requests to be respectful to the server
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    return results;
}

/**
 * Re-search videos for a specific block with a new query
 */
export async function reSearchBlock(
    block: BlockWithVideos,
    customQuery?: string
): Promise<BlockWithVideos> {
    const scraper = await getVioryScraper();

    const searchQuery = customQuery || await generateSearchQuery(block);
    const videos = await scraper.searchVideos(searchQuery);

    return {
        ...block,
        searchQuery,
        videos
    };
}
