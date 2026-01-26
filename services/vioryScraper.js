import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

// Get __dirname equivalent for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Detect if running in packaged Electron app
function getChromiumExecutablePath() {
    try {
        // Check if we're in a packaged Electron app
        const isPackaged = typeof process !== 'undefined' &&
            process.versions &&
            process.versions.electron &&
            process.mainModule &&
            process.mainModule.filename.includes('app.asar');

        if (isPackaged || (process.env.NODE_ENV === 'production' && process.versions.electron)) {
            // In packaged app, use bundled Chromium from resources folder
            const appPath = path.dirname(process.execPath);
            const chromiumPath = path.join(appPath, 'resources', 'playwright-browsers', 'chromium', 'chrome-win64', 'chrome.exe');
            console.log('[VioryScraper] Using bundled Chromium:', chromiumPath);
            return chromiumPath;
        }
    } catch (e) {
        console.log('[VioryScraper] Not in packaged mode, using default Playwright browser');
    }
    return undefined; // Use default Playwright browser
}

class VioryScraper {
    constructor() {
        this.browser = null;
        this.context = null;
        this.initPromise = null;
    }

    async init() {
        if (this.browser) return;

        if (!this.initPromise) {
            this.initPromise = (async () => {
                const executablePath = getChromiumExecutablePath();
                const launchOptions = {
                    headless: true, // New Headless mode
                    channel: 'chromium', // Force using the installed chromium
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--disable-gpu'
                    ]
                };

                if (executablePath) {
                    launchOptions.executablePath = executablePath;
                    delete launchOptions.channel; // If path provided, don't set channel
                }

                this.browser = await chromium.launch(launchOptions);
                this.context = await this.browser.newContext({
                    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                });
            })();
        }

        await this.initPromise;
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
            const searchUrl = `https://www.viory.video/en/videos?search=${encodeURIComponent(query)}`;
            console.log(`[VioryScraper] Searching: ${searchUrl}`);

            // SPEED OPTIMIZATION: networkidle is faster than domcontentloaded + waits
            await page.goto(searchUrl, {
                waitUntil: 'networkidle',
                timeout: 15000 // Reduced from 30s
            });

            // Wait for video grid to appear (reduced timeout)
            await page.waitForSelector('a[href*="/videos/"]', { timeout: 5000 }).catch(() => {
                console.log('[VioryScraper] No videos found with initial wait');
            });

            // SPEED: Reduced wait from 2000ms to 300ms (but keeping all content)
            await page.waitForTimeout(300);

            // SPEED: Keeping 3 scrolls as requested, only reduced wait time
            for (let i = 0; i < 3; i++) {
                await page.evaluate(() => window.scrollBy(0, 500));
                await page.waitForTimeout(100); // Reduced from 500ms to 100ms
            }

            // Extract video data
            const extractedVideos = await page.evaluate(() => {
                const results = [];
                // Find potential video items (broad selector to catch all types of layouts)
                // Viory typically uses a.group or div containers
                const allLinks = document.querySelectorAll('a[href*="/videos/"]');
                console.log(`Found ${allLinks.length} video links`);

                allLinks.forEach(link => {
                    try {
                        const href = link.getAttribute('href');
                        if (!href || href.includes('/videos?')) return; // Skip search links

                        // Get the parent card container (usually the link itself for a.group, or parent div)
                        const card = link.closest('div.group') || link.parentElement || link;

                        // --- TITLE EXTRACTION ---
                        let title = '';
                        // Priority 1: H3/H4 headers inside the card
                        const headers = card.querySelectorAll('h3, h4');
                        if (headers.length > 0) title = headers[0].textContent?.trim();

                        // Priority 2: Truncated text divs (common in Viory)
                        if (!title) {
                            const truncates = card.querySelectorAll('.truncate, .line-clamp-2');
                            if (truncates.length > 0) {
                                // Filter out duration like "00:50"
                                for (const t of truncates) {
                                    const txt = t.textContent?.trim();
                                    if (txt && txt.length > 10 && !txt.match(/^\d+:\d+$/)) {
                                        title = txt;
                                        break;
                                    }
                                }
                            }
                        }

                        // Priority 3: Any text paragraphs
                        if (!title) {
                            const paras = card.querySelectorAll('p, span');
                            for (const p of paras) {
                                const txt = p.textContent?.trim();
                                if (txt && txt.length > 15 && !txt.match(/^\d+:\d+$/) && !txt.includes('POOL')) {
                                    title = txt;
                                    break;
                                }
                            }
                        }

                        // Priority 4: URL Slug Fallback (VERY RELIABLE)
                        if (!title && href) {
                            const slug = href.split('/').pop()?.split('?')[0] || '';
                            title = slug.replace(/-/g, ' ').replace(/_/g, ' ');
                            title = title.replace(/\b\w/g, c => c.toUpperCase()); // Capitalize
                        }


                        // --- DESCRIPTION EXTRACTION (NEW) ---
                        // Often below the title in gray text
                        let description = '';
                        const allText = card.innerText || card.textContent || '';
                        // Simple heuristic: Take all text that ISN'T the title
                        if (title && allText.length > title.length + 20) {
                            description = allText.replace(title, '').trim();
                            // Clean up duration/POOL artifacts
                            description = description.replace(/^\d+:\d+\s*/, '').replace(/POOL\s*/, '').substring(0, 300);
                        }


                        // Find thumbnail
                        let thumbnail = '';
                        const img = card.querySelector('img') || link.querySelector('img');
                        if (img) {
                            // Handle lazy loading attributes
                            thumbnail = img.src || img.getAttribute('data-src') || img.getAttribute('srcset')?.split(' ')[0] || '';
                        }

                        // Find duration
                        let duration = '';
                        const durationMatch = (card.textContent || '').match(/\d+:\d{2}/);
                        if (durationMatch) {
                            duration = durationMatch[0];
                        }

                        // Build full URL
                        const fullUrl = href.startsWith('http') ? href : `https://www.viory.video${href}`;

                        if (fullUrl.includes('/videos/') && !fullUrl.includes('/videos?')) {
                            results.push({
                                title: title || 'Deep Search Result',
                                url: fullUrl,
                                thumbnail: thumbnail,
                                duration: duration || 'N/A',
                                description: description || ''
                            });
                        }
                    } catch (e) {
                        // Skip problematic
                    }
                });

                return results;
            });


            // Deduplicate by URL
            const seen = new Set();
            for (const video of extractedVideos) {
                if (!seen.has(video.url)) {
                    seen.add(video.url);
                    videos.push(video);
                }
            }

            // --- SORT BY RELEVANCE ---
            if (query) {
                const queryWords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
                videos.sort((a, b) => {
                    const score = (item) => {
                        let points = 0;
                        const text = (item.title + ' ' + (item.description || '')).toLowerCase();
                        // Exact phrase match
                        if (text.includes(query.toLowerCase())) points += 10;
                        // Word matches
                        queryWords.forEach(word => {
                            if (text.includes(word)) points += 2;
                            if (item.title.toLowerCase().includes(word)) points += 3; // Title weight
                        });
                        return points;
                    };
                    return score(b) - score(a);
                });
            }

            console.log(`[VioryScraper] Found ${videos.length} videos for "${query}"`);

            // Limit results after sort
            return videos.slice(0, maxResults);

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

export async function searchVioryVideos(query, maxResults = 30) {
    if (!scraperInstance) {
        scraperInstance = new VioryScraper();
    }
    return await scraperInstance.searchVideos(query, maxResults);
}

export async function closeScraper() {
    if (scraperInstance) {
        await scraperInstance.close();
        scraperInstance = null;
    }
}

export async function getVioryScraper() {
    if (!scraperInstance) {
        scraperInstance = new VioryScraper();
    }
    return scraperInstance;
}

export default VioryScraper;
