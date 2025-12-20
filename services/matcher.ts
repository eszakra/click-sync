
import { AssemblyWord } from './assemblyBackend';
import { AlignedSegment } from './gemini';

// --- HELPER: String Similarity (Dice Coefficient / Bigram) ---
// Good for catching typos or small differences (e.g. "colour" vs "color")
function getSimilarity(s1: string, s2: string): number {
    s1 = s1.toLowerCase().replace(/[^a-z0-9]/g, '');
    s2 = s2.toLowerCase().replace(/[^a-z0-9]/g, '');

    if (s1 === s2) return 1.0;
    if (s1.length < 2 || s2.length < 2) return 0.0;

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
const normalize = (text: string) => text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

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
    const markerRegex = /\[ON SCREEN:\s*(.*?)\]/gi;

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
        // Use a 5-word fingerprint. If that fails, try 3.
        let bestStartMatch = { index: -1, score: 0 };
        const startWindowSize = 5;
        const startTarget = segWords.slice(0, startWindowSize).join('');

        // Scan ahead. We limit the scan to avoid overlapping too far into future segments,
        // but for safety, let's scan a good chunk (e.g., next 1000 words or until end).
        // Optimization: Stop if we find a near-perfect match.
        const maxScan = 2000;

        for (let i = searchIndex; i < Math.min(words.length - startWindowSize, searchIndex + maxScan); i++) {
            // Construct candidate string from transcript words
            let candidate = "";
            for (let j = 0; j < startWindowSize; j++) candidate += normalize(words[i + j].text);

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

        // Validate Match
        let startIndex = searchIndex; // Default to previous end if totally lost (fallback)
        if (bestStartMatch.score > 0.4) {
            startIndex = bestStartMatch.index;
        } else {
            console.warn(`Low confidence start for segment: ${seg.title}`);
        }

        // Update search Index so we search for END after START
        searchIndex = startIndex;

        // -- FIND END --
        // Similar logic, but looking for the last words of the segment.
        let bestEndMatch = { index: -1, score: 0 };
        const endWindowSize = 5;
        const endTarget = segWords.slice(-endWindowSize).join('');

        // We scan from startIndex. 
        // IMPORTANT: We should ideally stop at the START of the *next* segment if known.
        // But we don't know it yet.

        for (let i = searchIndex; i < Math.min(words.length - endWindowSize, searchIndex + 5000); i++) {
            let candidate = "";
            for (let j = 0; j < endWindowSize; j++) candidate += normalize(words[i + j].text);

            const score = getSimilarity(endTarget, candidate);

            if (score > 0.85) {
                bestEndMatch = { index: i + endWindowSize - 1, score }; // Point to last word
                break;
            }
            if (score > bestEndMatch.score) {
                bestEndMatch = { index: i + endWindowSize - 1, score };
            }
        }

        // Fallback for end
        let endIndex = -1;
        if (bestEndMatch.score > 0.4) {
            endIndex = bestEndMatch.index;
        } else {
            // If we can't find the end, we might assume it goes until the next segment starts.
            // We can retroactively fix this.
            endIndex = words.length - 1; // Temporary: end of file
        }

        // Store Result
        result.push({
            title: seg.title,
            text: seg.text, // Pass text through
            start_time: words[startIndex].start / 1000,
            end_time: words[endIndex].end / 1000
        });

        // Update Global Search Index for next iteration
        // Start searching for next segment *after* this segment ends
        if (endIndex !== -1) {
            searchIndex = endIndex + 1;
        }
    }

    // 3. Post-Processing: Fix Gaps & Overlaps + Add Padding
    for (let i = 0; i < result.length; i++) {
        const seg = result[i];

        // ADD PADDING (Crucial for natural sound)
        // Start: Move back 0.15s to catch breath/attack
        seg.start_time = Math.max(0, seg.start_time - 0.15);

        // SPECIAL CASE: First segment almost always starts at 0 physically
        // If the calculated start is within the first 2 seconds, snap it to 0.
        if (i === 0 && seg.start_time < 2.0) {
            seg.start_time = 0;
        }

        // End: Move forward 0.15s for decay
        seg.end_time = seg.end_time + 0.15;

        // Fix Overlaps with next segment
        if (i < result.length - 1) {
            const nextStart = result[i + 1].start_time;
            // If padded end overlaps next start (with its padding), we have to compromise.
            // We want next segment to have its pre-padding too.
            // Let's set boundary at the midpoint of the "overlap" if possible, 
            // BUT prioritize the Start of the next segment usually.

            // Simple logic: Don't let current end go past next start minus a tiny gap
            if (seg.end_time > nextStart - 0.05) {
                seg.end_time = nextStart - 0.05;
            }
        }
    }

    // Explicitly fix the LAST segment to go to the very end of audio/transcript
    if (result.length > 0) {
        result[result.length - 1].end_time = words[words.length - 1].end / 1000;
    }

    return result;
};
