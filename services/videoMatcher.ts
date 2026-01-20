
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getVioryScraper, VideoResult } from './vioryScraper.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Default Key (Fallback)
const DEFAULT_KEY = "AIzaSyC0QCO0_h3jb6l2rDV738Rv8hAvf6_5atk";

// Helper to get dynamic key
function getApiKey(): string {
    try {
        const configPath = path.join(os.homedir(), '.clicksync', 'config.json');
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (data.geminiKey && data.geminiKey.trim().length > 10) {
                console.log("[VideoMatcher] Using custom API Key from config");
                return data.geminiKey.trim();
            }
        }
    } catch (e) {
        console.error("[VideoMatcher] Failed to load custom config:", e);
    }
    return DEFAULT_KEY;
}

const genAI = new GoogleGenerativeAI(getApiKey());

// --- Interfaces ---

export interface ScriptBlock {
    index: number;
    headline: string;
    text: string;
}

export interface BlockWithVideos extends ScriptBlock {
    searchQuery?: string;
    finalQuery?: string;
    videos: VideoResult[];
    status?: 'idle' | 'searching' | 'complete' | 'error' | 'no_results';
    analysis?: BlockAnalysis;
    queriesAttempted?: string[];
    attemptNum?: number;
    fallbackReason?: string;
    isLoading?: boolean; // Legacy support
}

interface GlobalContext {
    theme: string;
    main_people: string[];
    main_places: string[];
    main_orgs: string[];
}

interface BlockAnalysis {
    block_type: "MULTI_PERSONA" | "PERSONA" | "INSTITUTION" | "EVENT" | "GENERIC";
    main_person: string | null;
    secondary_person?: string | null;
    topic?: string;
    institution?: string | null;
    is_continuation?: boolean;
    queries: string[];
    place?: string; // Sometimes used in validation
}

interface ValidationResult {
    valid: boolean;
    videos: VideoResult[];
    reason: string;
}

// --- Logic ---

/**
 * Parse script into blocks based on [ON SCREEN: ...] markers
 */
export function parseScriptBlocks(script: string): ScriptBlock[] {
    const blocks: ScriptBlock[] = [];
    const cleanScript = script.replace(/\r\n/g, '\n');
    const markerRegex = /\[ON\s*SCREEN[:\s-]*([^\]]+)\]/gi;
    const matches = Array.from(cleanScript.matchAll(markerRegex));

    for (let i = 0; i < matches.length; i++) {
        const currentMatch = matches[i];
        const headline = currentMatch[1].trim();
        const textStart = currentMatch.index! + currentMatch[0].length;
        const textEnd = (i < matches.length - 1) ? matches[i + 1].index! : cleanScript.length;
        const text = cleanScript.substring(textStart, textEnd).trim();

        blocks.push({ index: i, headline, text });
    }

    return blocks;
}

/**
 * GLOBAL CONTEXT ANALYSIS
 */
async function analyzeGlobalContext(script: string): Promise<GlobalContext> {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-3-pro-preview' });
        const prompt = `Analyze this news script. Extract key entities.
        
Script: "${script.substring(0, 10000)}"

OUTPUT JSON ONLY:
{
  "theme": "one word (War, Diplomacy, Politics, Economy)",
  "main_people": ["list of full names mentioned"],
  "main_places": ["list of countries/cities"],
  "main_orgs": ["list of organizations"]
}`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonText = text.replace(/```json\n?|```/g, '').trim();
        return JSON.parse(jsonText);
    } catch (e) {
        console.error("Global analysis failed:", e);
        return { theme: "News", main_people: [], main_places: [], main_orgs: [] };
    }
}

/**
 * BLOCK ANALYSIS - Generates SIMPLE, VIORY-FRIENDLY queries with CONTEXT CONTINUITY
 */
async function analyzeBlockForViory(
    block: ScriptBlock,
    globalContext: GlobalContext,
    previousContext: Partial<BlockAnalysis> | null = null
): Promise<BlockAnalysis> {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-3-pro-preview' });

        // Build context continuity section
        let continuitySection = '';
        if (previousContext && previousContext.main_person) {
            continuitySection = `
PREVIOUS BLOCK CONTEXT (for continuity):
- Previous main person: "${previousContext.main_person}"
- Previous secondary person: "${previousContext.secondary_person || 'none'}"
- Previous topic: "${previousContext.topic || 'N/A'}"

CONTINUITY RULE: If this block is a CONTINUATION of the previous block's story (same people, same event), 
you should use the SAME main entities. Only switch to new entities if the block introduces genuinely NEW subjects.
`;
        }

        const prompt = `You are helping search for stock footage. Generate a PRIORITIZED list of search queries.

BLOCK TO ANALYZE:
Block #${block.index + 1}
Headline: "${block.headline}"
Paragraph: "${block.text}"
${continuitySection}
SEARCH HIERARCHY (in order of priority):
1. If TWO important people are mentioned: search "PersonA PersonB" TOGETHER first
2. Then search the MOST IMPORTANT person + topic keyword
3. Then search just the person's NAME
4. Then search the ORGANIZATION/INSTITUTION if mentioned
5. Finally, a GENERIC fallback related to the topic

RULES:
- Extract the MAIN TOPIC from paragraph (Venezuela, sanctions, diplomacy, war, oil, etc.)
- Identify WHO is the main speaker or subject
- Queries must be 2-3 words MAX
- NO abstract words like "speaking", "says", "hopes"
- Each query should be DIFFERENT and make sense with the content
- **IF the block is a continuation of the same story/people as the previous block, KEEP the same main entities**

OUTPUT JSON ONLY:
{
  "block_type": "MULTI_PERSONA|PERSONA|INSTITUTION|EVENT|GENERIC",
  "main_person": "Full Name or null",
  "secondary_person": "Full Name or null",
  "topic": "main topic keyword",
  "institution": "org name or null",
  "is_continuation": true/false,
  "queries": [
    "attempt 1: most specific",
    "attempt 2: main person name only",
    "attempt 3: institution or topic",
    "attempt 4: broad fallback"
  ]
}`;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const jsonText = text.replace(/```json\n?|```/g, '').trim();
        return JSON.parse(jsonText);

    } catch (e) {
        console.error(`Block ${block.index} analysis failed:`, e);
        // Emergency fallback
        const words = block.headline.split(' ').slice(0, 2).join(' ');
        return {
            block_type: "GENERIC",
            main_person: null,
            queries: [words, "news footage"]
        };
    }
}

/**
 * VALIDATE RESULTS - Check if results match the query intent
 */
function validateResults(videos: VideoResult[], analysis: BlockAnalysis): ValidationResult {
    if (!videos || videos.length === 0) return { valid: false, videos: [], reason: "No results" };

    const validVideos: (VideoResult & { relevanceScore: number })[] = [];

    for (const video of videos) {
        const title = (video.title || "").toLowerCase();
        let score = 0;

        // Check for person name match (highest priority)
        if (analysis.main_person) {
            const nameParts = analysis.main_person.toLowerCase().split(' ');
            const hasName = nameParts.some(part => part.length > 3 && title.includes(part));
            if (hasName) score += 2;
        }

        // Check for place match
        if (analysis.place && title.includes(analysis.place.toLowerCase())) {
            score += 1;
        }

        // Check for institution match
        if (analysis.institution && title.includes(analysis.institution.toLowerCase())) {
            score += 1;
        }

        if (score > 0) {
            validVideos.push({ ...video, relevanceScore: score });
        }
    }

    if (validVideos.length > 0) {
        // Sort by relevance
        validVideos.sort((a, b) => b.relevanceScore - a.relevanceScore);
        return { valid: true, videos: validVideos, reason: "Found relevant matches" };
    }

    // If no matches by entity, accept any results for broad queries
    return { valid: true, videos: videos.slice(0, 10), reason: "Using broad matches" };
}

/**
 * SEARCH WITH SMART FALLBACK
 */
interface SearchResult {
    videos: VideoResult[];
    finalQuery: string;
    queriesAttempted: string[];
    attemptNum: number;
    success: boolean;
}

async function searchBlockWithFallback(
    block: ScriptBlock,
    analysis: BlockAnalysis,
    scraper: Awaited<ReturnType<typeof getVioryScraper>>,
    onProgress: (status: string, data: any) => void
): Promise<SearchResult> {
    const queries = analysis.queries || [];
    const maxAttempts = queries.length;

    for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        const attemptNum = i + 1;

        // Emit: Starting search
        onProgress('searching', {
            query,
            attemptNum,
            maxAttempts,
            message: `Searching: "${query}"`
        });

        console.log(`[Block ${block.index}] Try ${attemptNum}/${maxAttempts}: "${query}"`);

        try {
            const videos = await scraper.searchVideos(query, 15);

            if (videos && videos.length > 0) {
                const validation = validateResults(videos, analysis);

                if (validation.valid && validation.videos.length > 0) {
                    onProgress('success', {
                        query,
                        videoCount: validation.videos.length,
                        attemptNum,
                        maxAttempts,
                        reason: validation.reason
                    });

                    return {
                        videos: validation.videos,
                        finalQuery: query,
                        queriesAttempted: queries.slice(0, attemptNum),
                        attemptNum,
                        success: true
                    };
                }

                // Results found but not relevant
                onProgress('fallback', {
                    query,
                    attemptNum,
                    maxAttempts,
                    fallbackReason: `Found ${videos.length} results but none matched "${analysis.main_person || analysis.place || 'topic'}"`
                });
            } else {
                onProgress('fallback', {
                    query,
                    attemptNum,
                    maxAttempts,
                    fallbackReason: "No results found"
                });
            }

            // Small delay before next attempt
            await new Promise(r => setTimeout(r, 300));

        } catch (err) {
            console.error(`Search error:`, err);
            onProgress('fallback', {
                query,
                attemptNum,
                maxAttempts,
                fallbackReason: "Search error"
            });
        }
    }

    // All queries exhausted
    return {
        videos: [],
        finalQuery: "FAILED",
        queriesAttempted: queries,
        attemptNum: queries.length,
        success: false
    };
}

/**
 * MAIN FUNCTION - Process script with real-time progress
 */
export async function matchVideosToScriptWithProgress(
    script: string,
    onBlockUpdate: (blockIndex: number, status: string, data?: any) => void,
    onBlockComplete?: (block: BlockWithVideos) => void
): Promise<BlockWithVideos[]> {
    const scraper = await getVioryScraper();
    const blocks = parseScriptBlocks(script);

    if (blocks.length === 0) return [];

    // 1. Global context analysis
    console.log("[Core] Analyzing global context...");
    const globalContext = await analyzeGlobalContext(script);
    console.log("[Core] Context:", globalContext);

    const results: BlockWithVideos[] = [];
    let previousContext: Partial<BlockAnalysis> | null = null; // Track previous block's analysis for continuity

    // 2. Process each block
    for (const block of blocks) {
        // Emit: Starting block analysis
        onBlockUpdate(block.index, 'analyzing', {
            message: `Analyzing block ${block.index + 1}...`
        });

        // Analyze block WITH previous context for continuity
        const analysis = await analyzeBlockForViory(block, globalContext, previousContext);

        // Log continuity detection
        if (analysis.is_continuation) {
            console.log(`[Core] Block ${block.index + 1} is a CONTINUATION of previous block`);
        }

        // Emit: Entities extracted
        onBlockUpdate(block.index, 'extracted', {
            message: `Found: ${analysis.main_person || analysis.institution || analysis.topic || 'Generic content'}`,
            blockType: analysis.block_type,
            mainPerson: analysis.main_person,
            queries: analysis.queries,
            isContinuation: analysis.is_continuation
        });

        // Search with fallback
        const searchResult = await searchBlockWithFallback(block, analysis, scraper, (status, data) => {
            onBlockUpdate(block.index, status, data);
        });

        const blockResult: BlockWithVideos = {
            ...block,
            ...searchResult,
            analysis,
            status: searchResult.success ? 'complete' : 'no_results'
        };

        results.push(blockResult);
        if (onBlockComplete) onBlockComplete(blockResult);

        // Save this block's analysis for the next block's continuity check
        previousContext = {
            main_person: analysis.main_person,
            secondary_person: analysis.secondary_person,
            topic: analysis.topic,
            institution: analysis.institution
        };
    }

    return results;
}

/**
 * Legacy compatibility
 */
export async function matchVideosToScript(script: string): Promise<BlockWithVideos[]> {
    return matchVideosToScriptWithProgress(script, () => { }, () => { });
}

/**
 * Generate a professional script context summary in SPANISH
 */
export async function generateScriptContext(script: string): Promise<string> {
    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-3-pro-preview' });
        const prompt = `Actúa como un editor de noticias experto. Analiza este guion y genera un RESUMEN EJECUTIVO MUY BREVE (máximo 2 frases) en ESPAÑOL que explique el contexto general y los protagonistas principales.
        
Script: "${script.substring(0, 10000)}"

RESUMEN EN ESPAÑOL:`;

        const result = await model.generateContent(prompt);
        return result.response.text().trim();
    } catch (e) {
        console.error("Context generation failed:", e);
        const analysis = await analyzeGlobalContext(script);
        return `Reportaje sobre ${analysis.theme}. Protagonistas: ${analysis.main_people.slice(0, 3).join(', ')}.`;
    }
}

/**
 * Re-search a single block
 */
export async function reSearchBlock(block: BlockWithVideos, customQuery?: string): Promise<BlockWithVideos> {
    const scraper = await getVioryScraper();

    if (customQuery) {
        // Custom query - just search it directly
        const videos = await scraper.searchVideos(customQuery, 15);
        return {
            ...block,
            videos: videos || [],
            searchQuery: customQuery,
            finalQuery: customQuery,
            status: videos?.length > 0 ? 'complete' : 'no_results'
        };
    }

    // Re-analyze the block
    const analysis = await analyzeBlockForViory(block, { theme: "News", main_people: [], main_places: [], main_orgs: [] });

    const searchResult = await searchBlockWithFallback(block, analysis, scraper, (status, data) => {
        console.log(`[ReSearch] ${status}:`, data);
    });

    return {
        ...block,
        ...searchResult,
        searchQuery: searchResult.finalQuery,
        status: searchResult.success ? 'complete' : 'no_results'
    };
}

/**
 * Re-search a single block WITH progress callbacks (for SSE streaming)
 */
export async function reSearchBlockWithProgress(
    block: BlockWithVideos,
    customQuery: string | null,
    onProgress: (status: string, data: any) => void
): Promise<BlockWithVideos> {
    const scraper = await getVioryScraper();

    // Emit: Starting
    onProgress('analyzing', { message: 'Analyzing block...' });

    if (customQuery) {
        onProgress('searching', { query: customQuery, message: `Searching: "${customQuery}"` });
        const videos = await scraper.searchVideos(customQuery, 15);
        onProgress('success', { query: customQuery, videoCount: videos?.length || 0 });
        return {
            ...block,
            videos: videos || [],
            searchQuery: customQuery,
            finalQuery: customQuery,
            status: videos?.length > 0 ? 'complete' : 'no_results'
        };
    }

    // Re-analyze the block
    const analysis = await analyzeBlockForViory(block, { theme: "News", main_people: [], main_places: [], main_orgs: [] });

    onProgress('extracted', {
        message: `Found: ${analysis.main_person || analysis.institution || 'content'}`,
        queries: analysis.queries
    });

    const searchResult = await searchBlockWithFallback(block, analysis, scraper, (status, data) => {
        onProgress(status, data);
    });

    return {
        ...block,
        ...searchResult,
        searchQuery: searchResult.finalQuery,
        status: searchResult.success ? 'complete' : 'no_results'
    };
}
// --- Title Generation ---
export const generateProfessionalTitle = async (script: string): Promise<string> => {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const prompt = `
        Analyze the following video script and generate a SINGLE, professional, catchy YouTube title.
        
        Rules:
        1. Read the entire script context.
        2. Create a title that reflects the core topic professionally (like a Documentary or News report).
        3. Do NOT use clickbait styles like "YOU WON'T BELIEVE". Use styles like "The Economy of Europe: A Deep Dive" or "How Engines Work".
        4. Return ONLY the title text. No quotes, no preamble.
        5. Maximum 60 characters.
        
        Script:
        "${script.substring(0, 5000)}"
        `;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        return text.trim().replace(/^"|"$/g, '').replace(/\n/g, ' ');
    } catch (e) {
        console.error("[VideoMatcher] Title generation failed:", e);
        return `Project ${new Date().toLocaleDateString()}`;
    }
};
