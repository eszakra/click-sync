import { chromium, Browser, BrowserContext, Page } from 'playwright';

export interface VideoResult {
    title: string;
    url: string;
    thumbnail: string;
    duration: string;
    description?: string;
}

class VioryScraper {
    private browser: Browser | null = null;
    private context: BrowserContext | null = null;

    async initialize(): Promise<void> {
        if (!this.browser) {
            this.browser = await chromium.launch({ headless: true });
            this.context = await this.browser.newContext();
            console.log('[VioryScraper] Browser initialized');
        }
    }

    async searchVideos(query: string, maxResults: number = 6): Promise<VideoResult[]> {
        if (!this.context) {
            await this.initialize();
        }

        // Create a NEW page for this specific search to avoid any caching
        const page = await this.context!.newPage();
        const videos: VideoResult[] = [];

        try {
            // Encode the query for URL
            const encodedQuery = encodeURIComponent(query);
            const searchUrl = `https://www.viory.video/en/videos?q=${encodedQuery}`;

            console.log(`[VioryScraper] Navigating to: ${searchUrl}`);

            // Navigate to the search page
            await page.goto(searchUrl, {
                waitUntil: 'networkidle',
                timeout: 30000
            });

            // Wait for video cards to load
            await page.waitForSelector('a.group[href*="/videos/"]', {
                timeout: 10000
            }).catch(() => {
                console.log('[VioryScraper] No video cards found within timeout');
            });

            // Small delay to ensure all content is loaded
            await page.waitForTimeout(1000);

            // Extract video information
            const videoCards = await page.$$('a.group[href*="/videos/"]');
            console.log(`[VioryScraper] Found ${videoCards.length} video cards`);

            for (let i = 0; i < Math.min(videoCards.length, maxResults); i++) {
                const card = videoCards[i];

                try {
                    // Get the video URL
                    const href = await card.getAttribute('href');
                    const url = href ? `https://www.viory.video${href}` : '';

                    // Get the thumbnail
                    const imgElement = await card.$('img');
                    const thumbnail = imgElement
                        ? (await imgElement.getAttribute('src')) || ''
                        : '';

                    // Get the title from the sibling or nested element
                    let title = '';
                    const titleElement = await card.$('span, p, h3, h4, div.truncate');
                    if (titleElement) {
                        title = await titleElement.innerText() || '';
                    }

                    // If no title found, try to get from the next sibling
                    if (!title) {
                        title = await card.evaluate((el: Element) => {
                            const nextEl = el.nextElementSibling;
                            return nextEl ? nextEl.textContent?.trim() || '' : '';
                        });
                    }

                    // Description extraction
                    let description = '';
                    description = await card.evaluate((el: Element) => {
                        const parent = el.closest('div.grid') ? el.parentElement : null;
                        if (parent) {
                            const paragraphs = parent.querySelectorAll('p, span.text-sm');
                            return Array.from(paragraphs).map(p => p.textContent).join(' ');
                        }
                        return '';
                    });

                    // Extract duration from the card
                    let duration = '';
                    const durationElement = await card.$('span, div');
                    if (durationElement) {
                        const allText = await card.evaluate((el: Element) => {
                            const spans = el.querySelectorAll('span, div');
                            for (const span of spans) {
                                const text = span.textContent?.trim() || '';
                                if (/^\d+:\d+$/.test(text)) {
                                    return text;
                                }
                            }
                            return '';
                        });
                        duration = allText;
                    }

                    if (url && (thumbnail || title)) {
                        videos.push({
                            title: title || `Video ${i + 1}`,
                            url,
                            thumbnail,
                            duration: duration || 'N/A',
                            description: description.trim()
                        });
                    }
                } catch (extractError) {
                    console.error(`[VioryScraper] Error extracting video ${i}:`, extractError);
                }
            }

            console.log(`[VioryScraper] Extracted ${videos.length} videos for query: "${query}"`);

        } catch (error) {
            console.error('[VioryScraper] Search error:', error);
        } finally {
            // IMPORTANT: Close the page after each search to ensure fresh results next time
            await page.close();
        }

        return videos;
    }

    /**
     * Close the browser
     */
    async close(): Promise<void> {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            console.log('[VioryScraper] Browser closed');
        }
    }
}

// Singleton instance for reuse
let scraperInstance: VioryScraper | null = null;

export async function getVioryScraper(): Promise<VioryScraper> {
    if (!scraperInstance) {
        scraperInstance = new VioryScraper();
        await scraperInstance.initialize();
    }
    return scraperInstance;
}

export async function closeVioryScraper(): Promise<void> {
    if (scraperInstance) {
        await scraperInstance.close();
        scraperInstance = null;
    }
}
