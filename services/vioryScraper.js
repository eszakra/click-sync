
/**
 * Viory Video Scraper
 * Compatible with Vercel Serverless (using @sparticuz/chromium) and Local Dev (puppeteer)
 */
class VioryScraper {
    constructor() {
        this.browser = null;
    }

    async initialize() {
        if (this.browser) return;

        console.log('[VioryScraper] Launching browser...');

        try {
            // Check if running on Vercel
            const isVercel = process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_VERSION;

            if (isVercel) {
                console.log('[VioryScraper] Using Vercel/Sparticuz Chromium');
                const chromium = await import('@sparticuz/chromium').then(m => m.default);
                const puppeteer = await import('puppeteer-core').then(m => m.default);

                // Configure Sparticuz
                chromium.setGraphicsMode = false;

                this.browser = await puppeteer.launch({
                    args: chromium.args,
                    defaultViewport: chromium.defaultViewport,
                    executablePath: await chromium.executablePath(),
                    headless: chromium.headless,
                    ignoreHTTPSErrors: true,
                });

            } else {
                console.log('[VioryScraper] Using Local Puppeteer');
                const puppeteer = await import('puppeteer').then(m => m.default);
                this.browser = await puppeteer.launch({
                    headless: true, // "new" is deprecated but true works
                    args: ['--no-sandbox', '--disable-setuid-sandbox']
                });
            }

            console.log('[VioryScraper] Browser initialized');

        } catch (error) {
            console.error('[VioryScraper] Failed to launch browser:', error);
            throw error;
        }
    }

    async searchVideos(query, maxResults = 6) {
        if (!this.browser) await this.initialize();

        let page = null;
        const videos = [];

        try {
            page = await this.browser.newPage();

            // Block images/styles to speed up
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const type = req.resourceType();
                if (type === 'image' || type === 'stylesheet' || type === 'font') {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            const encodedQuery = encodeURIComponent(query);
            const searchUrl = `https://www.viory.video/en/videos?search=${encodedQuery}`;

            console.log(`[VioryScraper] Searching for: "${query}"`);

            await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });

            // Wait for results
            try {
                // Viory cards usually have href containing /videos/
                await page.waitForSelector('a[href*="/videos/"]', { timeout: 10000 });
            } catch (e) {
                console.log('[VioryScraper] No results found or timeout');
                return [];
            }

            // Extract data
            const results = await page.$$eval('a[href*="/videos/"]', (cards, max) => {
                return cards.slice(0, max).map(card => {
                    const href = card.getAttribute('href');
                    const url = href ? `https://www.viory.video${href}` : '';

                    // Attempt to find thumbnail (img src)
                    const img = card.querySelector('img');
                    const thumbnail = img ? img.src : '';

                    // Attempt to find title (any text inside?)
                    // Viory layout: Card -> ... -> Title
                    // We extract all text and assume title is the longest string or specific class
                    // Fallback to textContent
                    const title = card.innerText.split('\n').find(line => line.length > 5) || card.innerText || 'Untitled';

                    // Duration usually MM:SS
                    const text = card.innerText;
                    const durMatch = text.match(/\d+:\d+/);
                    const duration = durMatch ? durMatch[0] : 'N/A';

                    return { title, url, thumbnail, duration };
                });
            }, maxResults);

            // Filter bad results
            videos.push(...results.filter(v => v.url && v.title));

            console.log(`[VioryScraper] Found ${videos.length} videos`);

        } catch (error) {
            console.error('[VioryScraper] Error:', error);
        } finally {
            if (page) await page.close();
        }

        return videos;
    }

    async close() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }
}

// Singleton
let scraperInstance = null;

export async function getVioryScraper() {
    if (!scraperInstance) {
        scraperInstance = new VioryScraper();
    }
    return scraperInstance;
}

export async function closeVioryScraper() {
    if (scraperInstance) {
        await scraperInstance.close();
        scraperInstance = null;
    }
}
