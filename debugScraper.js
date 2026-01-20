
import { getVioryScraper, closeScraper } from './services/vioryScraper.js';

async function test() {
    console.log("Starting test for 'Donald Trump'...");
    try {
        const scraper = await getVioryScraper();
        const results = await scraper.searchVideos("Donald Trump", 5);

        console.log(`Found ${results.length} results.`);
        results.forEach((v, i) => {
            console.log(`\n--- Video ${i + 1} ---`);
            console.log(`Title: "${v.title}"`);
            console.log(`Description: "${v.description}"`);
            console.log(`Duration: ${v.duration}`);
            console.log(`URL: ${v.url}`);
        });

        if (results.length === 0) {
            console.log("NO RESULTS FOUND.");
        }

    } catch (e) {
        console.error("Test failed:", e);
    } finally {
        await closeScraper();
    }
}

test();
