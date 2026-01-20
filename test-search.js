import { matchVideosToScript } from './services/videoMatcher.js';

// Test script with difficult/ambiguous entities to trigger fallbacks
const testScript = `
[ON SCREEN: Putin meeting Yvan Gil]
Russian President Vladimir Putin meets with Venezuelan Foreign Minister Yvan Gil in Moscow to discuss strategic cooperation.

[ON SCREEN: Unknown Protest in Paris]
Thousands of people gather in the streets of Paris to protest against pension reforms, waving flags and shouting slogans.

[ON SCREEN: Nicolas Maduro Speech]
President Nicolas Maduro addresses a large crowd in Caracas about the upcoming elections.
`;

console.log('--- Starting Smart Search Test ---');

try {
    const results = await matchVideosToScript(testScript, (blockIndex, status) => {
        console.log(`Block ${blockIndex} Status: ${status}`);
    });

    console.log('\n--- Final Results ---');
    results.forEach(r => {
        console.log(`\nBlock ${r.index}: "${r.headline}"`);
        console.log(`Final Query Used: "${r.searchQuery}"`);
        console.log(`Queries Attempted: ${JSON.stringify(r.queriesAttempted)}`);
        console.log(`Fallback Reasons: ${JSON.stringify(r.fallbackReasons)}`);
        console.log(`Videos Found: ${r.videos.length}`);
        if (r.videos.length > 0) {
            console.log(`Top Video: ${r.videos[0].title}`);
        }
    });

} catch (e) {
    console.error('Test Error:', e);
}
