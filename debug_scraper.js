
import { getVioryScraper } from './services/vioryScraper.js';

async function test() {
    console.log("Starting Scraper Test...");
    try {
        const scraper = await getVioryScraper();
        console.log("Scraper instance got.");
        const videos = await scraper.searchVideos("test query", 1);
        console.log("Search result:", videos);
    } catch (e) {
        console.error("CRASH DETECTED:");
        console.error(e);
    }
}

test();
