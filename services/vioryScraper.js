import { chromium } from 'playwright';

class VioryScraper {
    constructor() {
        this.browser = null;
        this.context = null;
    }

    async init() {
        if (!this.browser) {
            const browserlessToken = process.env.BROWSERLESS_API_KEY;

            if (browserlessToken) {
                console.log('[VioryScraper] Connecting to Browserless.io...');
                this.browser = await chromium.connectOverCDP(
                    `wss://chrome.browserless.io?token=${browserlessToken}&--no-sandbox&--disable-setuid-sandbox`
                );
            } else {
                console.log('[VioryScraper] No BROWSERLESS_API_KEY, launching local chromium...');
                this.browser = await chromium.launch({
                    headless: true,
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                });
            }

            this.context = await this.browser.newContext({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });
        }
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
        }
    }

    async searchVideos(query, maxResults = 30) {
        await this.init();

        // Create new page for each search to avoid caching issues
        const page = await this.context.newPage();
        const videos = [];

        try {
            const searchUrl = `https://viory.video/?search=${encodeURIComponent(query)}`;
            console.log(`[VioryScraper] Searching: ${searchUrl}`);

            await page.goto(searchUrl, {
                waitUntil: 'networkidle',
                timeout: 30000
            });

            // Wait for video cards to load
            await page.waitForSelector('.video-card, .video-item, [class*="video"]', { timeout: 10000 }).catch(() => {
                console.log('[VioryScraper] No video cards found with standard selectors');
            });

            // Extra wait for dynamic content
            await page.waitForTimeout(2000);

            // Extract video data
            const videoElements = await page.$$('a[href*="/watch"], a[href*="/video"], .video-card a, .video-item a');

            for (const el of videoElements.slice(0, maxResults)) {
                try {
                    const href = await el.getAttribute('href');
                    const titleEl = await el.$('[class*="title"], h3, h4, .title, span');
                    const title = titleEl ? await titleEl.textContent() : 'Untitled Video';
                    const imgEl = await el.$('img');
                    const thumbnail = imgEl ? await imgEl.getAttribute('src') : '';
                    const durationEl = await el.$('[class*="duration"], .time, .length');
                    const duration = durationEl ? await durationEl.textContent() : '';

                    if (href) {
                        const fullUrl = href.startsWith('http') ? href : `https://viory.video${href}`;
                        videos.push({
                            title: title?.trim() || 'Video',
                            url: fullUrl,
                            thumbnail: thumbnail || '',
                            duration: duration?.trim() || ''
                        });
                    }
                } catch (e) {
                    // Skip problematic elements
                }
            }

            console.log(`[VioryScraper] Found ${videos.length} videos for "${query}"`);

        } catch (error) {
            console.error('[VioryScraper] Search error:', error.message);
        } finally {
            await page.close();
        }

        return videos;
    }
}

// Singleton instance
let scraperInstance = null;
export async function getVioryScraper() {
    if (!scraperInstance) {
        scraperInstance = new VioryScraper();
    }
    return scraperInstance;
}

export async function searchVioryVideos(query, maxResults = 30) {
    const scraper = await getVioryScraper();
    return await scraper.searchVideos(query, maxResults);
}

export async function closeScraper() {
    if (scraperInstance) {
        await scraperInstance.close();
        scraperInstance = null;
    }
}

export default VioryScraper;
