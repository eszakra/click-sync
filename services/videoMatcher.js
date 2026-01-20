
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getVioryScraper } from './vioryScraper.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Default Key (Fallback)
const DEFAULT_KEY = "AIzaSyC0QCO0_h3jb6l2rDV738Rv8hAvf6_5atk";

// Helper to get dynamic key
function getApiKey() {
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

// REMOVED Global instance: const genAI = new GoogleGenerativeAI(getApiKey());

/**
 * Parse script into blocks based on [ON SCREEN: ...] markers
 */
export function parseScriptBlocks(script) {
    const blocks = [];
    const cleanScript = script.replace(/\r\n/g, '\n');
    const markerRegex = /\[ON\s*SCREEN[:\s-]*([^\]]+)\]/gi;
    const matches = Array.from(cleanScript.matchAll(markerRegex));

    for (let i = 0; i < matches.length; i++) {
        const currentMatch = matches[i];
        const headline = currentMatch[1].trim();
        const textStart = currentMatch.index + currentMatch[0].length;
        const textEnd = (i < matches.length - 1) ? matches[i + 1].index : cleanScript.length;
        const text = cleanScript.substring(textStart, textEnd).trim();

        blocks.push({ index: i, headline, text });
    }

    return blocks;
}

/**
 * GLOBAL CONTEXT ANALYSIS
 */
async function analyzeGlobalContext(script) {
    try {
        // Instantiate lazily to ensure latest key
        const genAI = new GoogleGenerativeAI(getApiKey());
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
        const jsonText = result.response.text().replace(/```json\n?|```/g, '').trim();
        return JSON.parse(jsonText);
    } catch (e) {
        console.error("Global analysis failed:", e);
        return { theme: "News", main_people: [], main_places: [], main_orgs: [] };
    }
}

/**
 * BLOCK ANALYSIS - Generates SIMPLE, VIORY-FRIENDLY queries with CONTEXT CONTINUITY
 */
async function analyzeBlockForViory(block, globalContext, previousContext = null) {
    try {
        // Instantiate lazily to ensure latest key
        const genAI = new GoogleGenerativeAI(getApiKey());
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

        // Generate queries with EXPLICIT HIERARCHY and CONTINUITY
        const prompt = `You are helping search for stock footage. Generate a PRIORITIZED list of 6-8 search queries.

BLOCK TO ANALYZE:
Block #${block.index + 1}
Headline: "${block.headline}"
Paragraph: "${block.text}"
${continuitySection}
SEARCH HIERARCHY (in order of priority):
1. If TWO important people are mentioned: search "PersonA PersonB" TOGETHER first
2. Then search the MOST IMPORTANT person + action (e.g. "Trump speech", "Putin press conference")
3. Then search just the person's FULL NAME
4. Then search person + location (e.g. "Trump White House", "Putin Kremlin")
5. Then search the ORGANIZATION/INSTITUTION if mentioned
6. Then search the EVENT TYPE + LOCATION (e.g. "NATO summit", "UN meeting")
7. Finally, a GENERIC fallback related to the topic + "footage" or "video"

CRITICAL RULES:
- Generate AT LEAST 6 DIFFERENT queries
- Extract the MAIN TOPIC from paragraph
- Identify WHO is the main speaker or subject
- **If a title/position is mentioned WITHOUT a name (e.g., "the Prime Minister", "the President", "the Foreign Minister"), use the TITLE + COUNTRY or ACTION (e.g., "Chinese Prime Minister", "Prime Minister speech")**
- Queries must be 2-4 words MAX  
- Include ACTION variants: "speech", "press conference", "interview", "meeting"
- Each query MUST be UNIQUE and DIFFERENT from the others
- **IF the block is a continuation of the same story/people as the previous block, GENERATE NEW query variants to avoid repetition**

EXAMPLE 1 (Two people mentioned):
Text: "Putin met with Trump to discuss sanctions..."
→ queries: ["Putin Trump", "Putin Trump meeting", "Vladimir Putin", "Donald Trump", "Russia USA summit", "White House Russia", "Trump sanctions"]

EXAMPLE 2 (One person, specific topic):
Text: "Zakharova accused the US of naval quarantine on Venezuelan oil..."
→ queries: ["Zakharova Venezuela", "Maria Zakharova speech", "Russia Venezuela", "Venezuela oil crisis", "Zakharova press conference", "Russia foreign ministry"]

EXAMPLE 3 (UNNAMED POSITION - very important):
Text: "The Chinese Prime Minister announced new economic policies..."
→ queries: ["Chinese Prime Minister", "China Prime Minister speech", "China economic policy", "Beijing government", "China leader announcement", "China press conference"]

EXAMPLE 4 (EVENT - bombing, protest, disaster):
Text: "Airstrikes hit the capital of Syria, destroying buildings..."
→ queries: ["Syria airstrike", "Damascus bombing", "Syria destruction", "Syria war footage", "military attack Syria", "building explosion Syria"]

EXAMPLE 5 (CONTINUATION - same people, different angle):
Previous block was about "Trump Greenland"
Current text: "Trump dismissed NATO allies concerns..."
→ queries: ["Trump NATO", "Trump press conference", "Trump Greenland NATO", "NATO summit Trump", "Trump Denmark", "Trump speaking"]
(NOT "Trump Greenland" again - that was already used!)

OUTPUT JSON ONLY:
{
  "block_type": "MULTI_PERSONA|PERSONA|INSTITUTION|EVENT|GENERIC",
  "main_person": "Full Name or position like 'Chinese Prime Minister' or null",
  "secondary_person": "Full Name or null",
  "topic": "main topic keyword",
  "institution": "org name or null",
  "is_continuation": true/false,
  "queries": [
    "attempt 1: most specific combo",
    "attempt 2: main person + action",
    "attempt 3: person name only",
    "attempt 4: person + location",
    "attempt 5: institution or topic",
    "attempt 6: broad fallback with 'footage'"
  ]
}`;

        const result = await model.generateContent(prompt);
        const jsonText = result.response.text().replace(/```json\n?|```/g, '').trim();
        return JSON.parse(jsonText);

    } catch (e) {
        console.error(`Block ${block.index} analysis failed:`, e);
        // Emergency fallback - use headline words
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
function validateResults(videos, analysis) {
    if (!videos || videos.length === 0) return { valid: false, reason: "No results" };

    const validVideos = [];

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

    // SMART VALIDATION WITH FALLBACKS
    if (analysis.main_person) {
        const nameParts = analysis.main_person.toLowerCase().split(' ');

        // Helper to check text for any name part
        const hasNameMatch = (text) => {
            if (!text) return false;
            const lower = text.toLowerCase();
            return nameParts.some(part => part.length > 3 && lower.includes(part));
        };

        // PASS 1: Strict match on title/description
        const strictMatches = videos.filter(v => {
            return hasNameMatch(v.title) || hasNameMatch(v.description);
        });

        if (strictMatches.length > 0) {
            return { valid: true, videos: strictMatches, reason: "Found strict matches in title/desc" };
        }

        // PASS 2: Check if name appears in URL slug (Viory often has keywords in URL path)
        const urlMatches = videos.filter(v => {
            if (!v.url) return false;
            const urlLower = v.url.toLowerCase();
            return nameParts.some(part => part.length > 3 && urlLower.includes(part));
        });

        if (urlMatches.length > 0) {
            console.log(`[Validation] Strict title match failed, but found ${urlMatches.length} URL matches.`);
            return { valid: true, videos: urlMatches, reason: "Matched via URL keywords" };
        }

        // PASS 3: BEST EFFORT - If we found results but can't confirm relevance, STILL return them
        // This prevents "No matches" when there clearly ARE results for the person
        if (videos.length > 0) {
            console.log(`[Validation] No strict matches, accepting ${Math.min(videos.length, 5)} best-effort results.`);
            return { valid: true, videos: videos.slice(0, 5), reason: "Best effort (unconfirmed relevance)" };
        }

        // Only fail if truly no results
        return { valid: false, reason: `No results found for: ${analysis.main_person}` };
    }

    // If no matches by entity, accept any results for broad queries
    return { valid: true, videos: videos.slice(0, 10), reason: "Using broad matches" };
}

/**
 * SEARCH WITH SMART AGGREGATION
 * - Runs ALL queries and aggregates unique results
 * - Skips queries already used in previous blocks (via globalUsedQueries)
 * - Deduplicates by video URL
 */
async function searchBlockWithAggregation(block, analysis, scraper, onProgress, globalUsedQueries = new Set()) {
    const queries = analysis.queries || [];
    const maxAttempts = queries.length;

    // Collect ALL results across queries
    const allVideos = [];
    const seenUrls = new Set();
    let successfulQueries = [];

    for (let i = 0; i < queries.length; i++) {
        const query = queries[i];
        const attemptNum = i + 1;

        // SKIP if this exact query was already used in a previous block
        if (globalUsedQueries.has(query.toLowerCase())) {
            onProgress('fallback', {
                query,
                attemptNum,
                maxAttempts,
                fallbackReason: "Query already used in previous block"
            });
            continue;
        }

        // Mark as used (even if it fails, to avoid retrying)
        globalUsedQueries.add(query.toLowerCase());

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
                    // ADD to aggregated results (dedupe by URL)
                    let addedCount = 0;
                    for (const video of validation.videos) {
                        if (!seenUrls.has(video.url)) {
                            seenUrls.add(video.url);
                            allVideos.push({ ...video, sourceQuery: query });
                            addedCount++;
                        }
                    }

                    if (addedCount > 0) {
                        successfulQueries.push(query);
                        onProgress('success', {
                            query,
                            videoCount: addedCount,
                            totalSoFar: allVideos.length,
                            attemptNum,
                            maxAttempts,
                            reason: validation.reason
                        });
                    }
                } else {
                    onProgress('fallback', {
                        query,
                        attemptNum,
                        maxAttempts,
                        fallbackReason: `Found ${videos.length} but not relevant`
                    });
                }
            } else {
                onProgress('fallback', {
                    query,
                    attemptNum,
                    maxAttempts,
                    fallbackReason: "No results found"
                });
            }

            // Small delay
            await new Promise(r => setTimeout(r, 200));

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

    // Return aggregated results
    if (allVideos.length > 0) {
        return {
            videos: allVideos,
            finalQuery: successfulQueries.join(' + '),
            queriesAttempted: queries,
            successfulQueries,
            attemptNum: queries.length,
            success: true
        };
    }

    // All queries exhausted with no results
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
export async function matchVideosToScriptWithProgress(script, onBlockUpdate, onBlockComplete) {
    const scraper = await getVioryScraper();
    const blocks = parseScriptBlocks(script);

    if (blocks.length === 0) return [];

    // 1. Global context analysis
    console.log("[Core] Analyzing global context...");
    const globalContext = await analyzeGlobalContext(script);
    console.log("[Core] Context:", globalContext);

    const results = [];
    let previousContext = null; // Track previous block's analysis for continuity

    // GLOBAL QUERY TRACKER - prevents repeating same queries across blocks
    const globalUsedQueries = new Set();

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

        // Search with AGGREGATION (runs ALL queries, dedupes globally)
        const searchResult = await searchBlockWithAggregation(block, analysis, scraper, (status, data) => {
            onBlockUpdate(block.index, status, data);
        }, globalUsedQueries);

        const blockResult = {
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
export async function matchVideosToScript(script) {
    return matchVideosToScriptWithProgress(script, () => { }, () => { });
}

/**
 * Generate a professional script context summary in SPANISH
 */
export async function generateScriptContext(script) {
    try {
        const genAI = new GoogleGenerativeAI(getApiKey());
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
export async function reSearchBlock(block, customQuery) {
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

    const searchResult = await searchBlockWithAggregation(block, analysis, scraper, (status, data) => {
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
export async function reSearchBlockWithProgress(block, customQuery, onProgress) {
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

    const searchResult = await searchBlockWithAggregation(block, analysis, scraper, (status, data) => {
        onProgress(status, data);
    });

    return {
        ...block,
        ...searchResult,
        searchQuery: searchResult.finalQuery,
        status: searchResult.success ? 'complete' : 'no_results'
    };
}
