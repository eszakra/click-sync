
import { AssemblyWord } from './assemblyBackend';
import { AlignedSegment } from '../types';

// --- HELPER: String Similarity (Dice Coefficient / Bigram) ---
// Good for catching typos or small differences (e.g. "colour" vs "color")
function getSimilarity(s1: string, s2: string): number {
    // Basic cleaning for comparison - preserve alphanumeric
    s1 = s1.toLowerCase().replace(/[^a-z0-9ñ]/g, '');
    s2 = s2.toLowerCase().replace(/[^a-z0-9ñ]/g, '');

    if (s1 === s2) return 1.0;
    if (s1.length < 2 || s2.length < 2) {
        return s1 === s2 ? 1.0 : 0.0;
    }

    const bigrams1 = new Set<string>();
    for (let i = 0; i < s1.length - 1; i++) bigrams1.add(s1.substring(i, i + 2));

    let intersection = 0;
    for (let i = 0; i < s2.length - 1; i++) {
        const bigram = s2.substring(i, i + 2);
        if (bigrams1.has(bigram)) intersection++;
    }

    return (2.0 * intersection) / (s1.length + s2.length - 2);
}

// --- NORMALIZATION ---
// Improved: Normalizes Spanish characters (accents) and preserves 'ñ'
const normalize = (text: string) =>
    text.toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // Remove accents (á -> a)
        .replace(/[^a-z0-9ñ\s]/g, '')    // Keep alphanumeric, ñ and spaces
        .trim();

export const alignScriptDeterministic = async (
    scriptText: string,
    words: AssemblyWord[]
): Promise<AlignedSegment[]> => {

    // 1. Parse Script into Segments
    // 1. Parse Script into Segments (Robust Regex Approach)
    const segments: { title: string; text: string }[] = [];

    // Normalize newlines to avoid issues
    const cleanScript = scriptText.replace(/\r\n/g, '\n');

    // Regex to find all [ON SCREEN: ...] markers
    // Capture group 1 is the Title inside the brackets.
    // We use 'g' for global and 'i' for case-insensitive.
    // IMPROVED: Now handles [ON SCREEN:, ÑON SCREEN:, ñon screen:, variations without brackets, etc.
    const markerRegex = /(?:\[|Ñ|ñ|¿)?\s*(?:ON|ÑON|on|ñon)\s*SCREEN[:\s-]*([^\]\n\r]*?)(?:\]|\n|\r|$)/gi;

    let match;
    let lastIndex = 0;

    // We need to capture the text *following* each marker.
    // Implementation: Finds a marker, then takes the substring from the end of this marker
    // to the start of the next marker (or end of string).

    // Find all matches first to get their positions
    const matches = Array.from(cleanScript.matchAll(markerRegex));

    for (let i = 0; i < matches.length; i++) {
        const currentMatch = matches[i];
        const title = currentMatch[1].trim(); // Group 1 is title

        // Start of text is end of current match
        const textStart = currentMatch.index! + currentMatch[0].length;

        // End of text is start of next match, or end of string if this is the last one
        const textEnd = (i < matches.length - 1) ? matches[i + 1].index! : cleanScript.length;

        const textContent = cleanScript.substring(textStart, textEnd).trim();

        if (title) { // Only add if title exists (even if text is empty? usually needs mixed)
            segments.push({ title: title, text: textContent });
        }
    }

    // 2. Map Segments to Words using Fuzzy Search
    const result: AlignedSegment[] = [];
    let searchIndex = 0;

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
        const seg = segments[segIdx];
        const segWords = normalize(seg.text).split(/\s+/).filter(w => w.length > 0);

        if (segWords.length === 0) continue;

        // -- FIND START --
        let bestStartMatch = { index: -1, score: 0 };
        // Use a variable window size for shorter segments
        const actualStartWindow = Math.min(5, segWords.length);
        const startTarget = segWords.slice(0, actualStartWindow).join('');

        // Scan ahead. We limit the scan to avoid overlapping too far into future segments,
        // but for safety, let's scan a good chunk (e.g., next 1000 words or until end).
        // Optimization: Stop if we find a near-perfect match.
        const maxScan = 2000;

        for (let i = searchIndex; i <= Math.min(words.length - actualStartWindow, searchIndex + maxScan); i++) {
            // Construct candidate string from transcript words
            let candidate = "";
            for (let j = 0; j < actualStartWindow; j++) candidate += normalize(words[i + j].text);

            const score = getSimilarity(startTarget, candidate);

            if (score > 0.85) { // High confidence threshold
                bestStartMatch = { index: i, score };
                break; // Stop immediately on high match
            }

            if (score > bestStartMatch.score) {
                bestStartMatch = { index: i, score };
            }
        }

        // If strong match not found with 5 words, try 3 words fallback
        if (bestStartMatch.score < 0.5) {
            const smallStartTarget = segWords.slice(0, 3).join('');
            for (let i = searchIndex; i < Math.min(words.length - 3, searchIndex + maxScan); i++) {
                let candidate = "";
                for (let j = 0; j < 3; j++) candidate += normalize(words[i + j].text);
                const score = getSimilarity(smallStartTarget, candidate);
                if (score > 0.9) {
                    bestStartMatch = { index: i, score };
                    break;
                }
            }
        }

        // Validate Match with detailed logging
        let startIndex = searchIndex; // Default to previous end if totally lost (fallback)
        let startConfidence: 'high' | 'medium' | 'low' = 'low';
        
        if (bestStartMatch.score > 0.7) {
            startIndex = bestStartMatch.index;
            startConfidence = 'high';
        } else if (bestStartMatch.score > 0.4) {
            startIndex = bestStartMatch.index;
            startConfidence = 'medium';
            console.warn(`[Matcher] Medium confidence start (${bestStartMatch.score.toFixed(2)}) for segment: "${seg.title.substring(0, 30)}..."`);
        } else {
            // Low confidence - use fallback but log warning
            startConfidence = 'low';
            console.warn(`[Matcher] LOW confidence start (${bestStartMatch.score.toFixed(2)}) for segment: "${seg.title.substring(0, 30)}..." - using fallback position ${searchIndex}`);
        }
        
        console.log(`[Matcher] Segment ${segIdx + 1}/${segments.length}: "${seg.title.substring(0, 25)}..." - Start match: score=${bestStartMatch.score.toFixed(2)}, confidence=${startConfidence}, index=${startIndex}`);

        // SAFETY CHECK: Prevent crash if script overrides audio length
        if (!words[startIndex]) {
            throw new Error(`Script/Audio Mismatch: Could not align segment "${seg.title}". The script text appears to contain content not present in the audio file.`);
        }

        // Update search Index so we search for END after START
        searchIndex = startIndex;

        // -- FIND END --
        // Similar logic, but looking for the last words of the segment.
        let bestEndMatch = { index: -1, score: 0 };
        const actualEndWindow = Math.min(5, segWords.length);
        const endTarget = segWords.slice(-actualEndWindow).join('');

        // We scan from startIndex. 
        for (let i = searchIndex; i <= Math.min(words.length - actualEndWindow, searchIndex + 5000); i++) {
            let candidate = "";
            for (let j = 0; j < actualEndWindow; j++) candidate += normalize(words[i + j].text);

            const score = getSimilarity(endTarget, candidate);

            if (score > 0.85) {
                bestEndMatch = { index: i + actualEndWindow - 1, score }; // Point to last word
                break;
            }
            if (score > bestEndMatch.score) {
                bestEndMatch = { index: i + actualEndWindow - 1, score };
            }
        }

        // Fallback for end with detailed logging
        let endIndex = -1;
        let endConfidence: 'high' | 'medium' | 'low' = 'low';
        
        if (bestEndMatch.score > 0.7) {
            endIndex = bestEndMatch.index;
            endConfidence = 'high';
        } else if (bestEndMatch.score > 0.4) {
            endIndex = bestEndMatch.index;
            endConfidence = 'medium';
            console.warn(`[Matcher] Medium confidence end (${bestEndMatch.score.toFixed(2)}) for segment: "${seg.title.substring(0, 30)}..."`);
        } else {
            // If we can't find the end, use end of file as fallback
            endIndex = words.length - 1;
            endConfidence = 'low';
            console.warn(`[Matcher] LOW confidence end (${bestEndMatch.score.toFixed(2)}) for segment: "${seg.title.substring(0, 30)}..." - using fallback (end of audio)`);
        }
        
        const segmentDuration = (words[endIndex].end - words[startIndex].start) / 1000;
        console.log(`[Matcher] Segment ${segIdx + 1}: End match: score=${bestEndMatch.score.toFixed(2)}, confidence=${endConfidence}, duration=${segmentDuration.toFixed(2)}s`);

        // Store Result with confidence metadata
        result.push({
            title: seg.title,
            text: seg.text,
            start_time: words[startIndex].start / 1000,
            end_time: words[endIndex].end / 1000,
            // @ts-ignore - Adding metadata for debugging
            _matchConfidence: {
                start: { score: bestStartMatch.score, confidence: startConfidence },
                end: { score: bestEndMatch.score, confidence: endConfidence }
            }
        });

        // Update Global Search Index for next iteration
        // Start searching for next segment *after* this segment ends
        if (endIndex !== -1) {
            searchIndex = endIndex + 1;
        }
    }

    // 3. Post-Processing: Fix Gaps & Overlaps - Ensure PERFECT CONTINUITY
    for (let i = 0; i < result.length; i++) {
        const seg = result[i];

        // NO PADDING allowed as per user request
        // Start and End are kept as detected by word timestamps initially

        // SPECIAL CASE: First segment starts exactly at 0
        if (i === 0) {
            seg.start_time = 0;
        }

        // Bridge gaps to make segments contiguous
        if (i < result.length - 1) {
            const nextSeg = result[i + 1];

            // The boundary for contiguous segments is the start of the next one
            // However, we want to ensure the detection of the next seg is reliable
            // We set the current segment's end to the next segment's start
            seg.end_time = nextSeg.start_time;
        }
    }

    // Explicitly fix the LAST segment to go to the very end of audio
    if (result.length > 0) {
        // We'll use the last word's end, but App.tsx will clip it to buffer duration anyway
        result[result.length - 1].end_time = words[words.length - 1].end / 1000;
    }

    return result;
};
