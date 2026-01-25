// vioryDownloader.cjs - Production-Ready Viory Downloader for Electron
// Enhanced with Gemini Vision integration for intelligent video matching
// Refactored with proven fixes: smart matching, checkbox handling, My Content fallback

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

// Priority keywords for smart video matching
const PRIORITY_KEYWORDS = ['speech', 'address', 'statement', 'interview', 'remarks', 'talking', 'speaks', 'announces'];

// Screenshot cache to avoid re-capturing
const screenshotCache = new Map();

class VioryDownloader {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.cookiesPath = null;
        this.downloadsPath = null;
        this.isHeadless = false;
    }

    /**
     * Initialize browser with optional headless mode
     */
    async init(options = {}) {
        let userDataPath;
        try {
            userDataPath = app.getPath('userData');
        } catch (e) {
            // Fallback for testing/Node environment
            userDataPath = path.join(process.env.APPDATA || process.env.HOME, 'ClickSync-Test');
        }

        // Use provided cookies path or default
        if (options.cookiesPath) {
            this.cookiesPath = options.cookiesPath;
        } else {
            this.cookiesPath = path.join(userDataPath, 'viory-cookies.json');
        }

        this.downloadsPath = path.join(userDataPath, 'video-downloads');

        if (!fs.existsSync(this.downloadsPath)) {
            fs.mkdirSync(this.downloadsPath, { recursive: true });
        }

        this.isHeadless = options.headless !== undefined ? options.headless : false;
        console.log(`[VioryDownloader] Initializing browser (headless: ${this.isHeadless})...`);

        // Get chromium path for packaged app
        let executablePath = undefined;
        try {
            const appPath = path.dirname(process.execPath);
            const chromiumPath = path.join(appPath, 'resources', 'playwright-browsers', 'chromium', 'chrome-win64', 'chrome.exe');
            if (fs.existsSync(chromiumPath)) {
                executablePath = chromiumPath;
                console.log('[VioryDownloader] Using bundled Chromium');
            }
        } catch (e) { /* Use system chromium */ }

        this.browser = await chromium.launch({
            headless: this.isHeadless,
            channel: executablePath ? undefined : 'chromium',
            executablePath: executablePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        this.context = await this.browser.newContext({
            viewport: { width: 1400, height: 900 },
            acceptDownloads: true,
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        // Load saved cookies
        if (fs.existsSync(this.cookiesPath)) {
            try {
                const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf-8'));
                await this.context.addCookies(cookies);
                console.log('[VioryDownloader] Loaded saved session');
            } catch (e) {
                console.warn('[VioryDownloader] Could not load cookies:', e.message);
            }
        }

        this.page = await this.context.newPage();
        return true;
    }

    /**
     * Restart browser with new options (e.g., switch to headless mode)
     */
    async restart(options) {
        console.log('[VioryDownloader] Restarting browser with options:', options);
        if (this.browser) {
            await this.close();
        }
        await this.init(options);
    }

    /**
     * Ensure page is available
     */
    async ensurePage() {
        if (!this.page || this.page.isClosed()) {
            console.log('[VioryDownloader] Page missing, re-initializing...');
            await this.init({ headless: this.isHeadless });
        }
        return this.page;
    }

    /**
     * Dismiss popups and overlays
     */
    async dismissPopups() {
        try {
            const page = await this.ensurePage();
            await page.evaluate(() => {
                // Close buttons with X
                document.querySelectorAll('button').forEach(btn => {
                    const text = btn.textContent || '';
                    if (text === '×' || text === 'x' || text === 'X') btn.click();
                });
                // Generic close selectors
                document.querySelectorAll('.popup-close, [aria-label="Close"], .modal-close').forEach(el => el.click());
            });
            await page.waitForTimeout(300);
        } catch (e) {
            // Ignore popup dismissal errors
        }
    }

    /**
     * Check if saved cookies exist and contain session data
     * @returns {boolean} true if cookies file exists with content
     */
    hasSavedSession() {
        try {
            if (fs.existsSync(this.cookiesPath)) {
                const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf-8'));
                // Check if we have substantial cookies (not just tracking cookies)
                const hasSessionCookies = cookies.some(c =>
                    c.name.includes('session') ||
                    c.name.includes('auth') ||
                    c.name.includes('token') ||
                    c.name.includes('user') ||
                    c.domain.includes('viory')
                );
                return cookies.length > 5 && hasSessionCookies;
            }
        } catch (e) {
            console.warn('[VioryDownloader] Error checking saved session:', e.message);
        }
        return false;
    }

    /**
     * Verify if current session is valid (can access protected content)
     * Should be called after init() with cookies loaded
     * @returns {boolean} true if session is valid
     */
    async verifySession() {
        try {
            console.log('[VioryDownloader] Verifying session validity...');
            // OPTIMIZED: Changed from networkidle/20000 to domcontentloaded/15000
            // ORIGINAL: await this.page.goto('https://www.viory.video/en/videos', { waitUntil: 'networkidle', timeout: 20000 });
            await this.page.goto('https://www.viory.video/en/videos', { waitUntil: 'domcontentloaded', timeout: 15000 });
            // OPTIMIZED: Reduced from 1500ms to 800ms
            // ORIGINAL: await this.page.waitForTimeout(1500);
            await this.page.waitForTimeout(800);

            // Check if Sign In button is present (means not logged in)
            const isLoggedOut = await this.page.evaluate(() => {
                return !!document.querySelector('a[href*="signin"]');
            });

            if (!isLoggedOut) {
                console.log('[VioryDownloader] Session is valid!');
                return true;
            }
            console.log('[VioryDownloader] Session expired or invalid');
            return false;
        } catch (e) {
            console.error('[VioryDownloader] Session verification failed:', e.message);
            return false;
        }
    }

    /**
     * Handle login flow with smart detection - polls for login state instead of fixed wait
     * Browser opens visible, waits for user to login (detects automatically)
     * @param {function} onStatusChange - Callback for status updates
     * @returns {boolean} true if logged in successfully
     */
    async handleLoginFlow(onStatusChange = null) {
        console.log('[VioryDownloader] Starting smart login flow...');

        try {
            // Go to videos page
            // OPTIMIZED: Changed from networkidle/60000 to domcontentloaded/30000
            // ORIGINAL: await this.page.goto('https://www.viory.video/en/videos', { waitUntil: 'networkidle', timeout: 60000 });
            await this.page.goto('https://www.viory.video/en/videos', { waitUntil: 'domcontentloaded', timeout: 30000 });
            // OPTIMIZED: Reduced from 1500ms to 1000ms
            // ORIGINAL: await this.page.waitForTimeout(1500);
            await this.page.waitForTimeout(1000);

            // Check if already logged in
            const alreadyLoggedIn = await this.isLoggedIn();
            if (alreadyLoggedIn) {
                console.log('[VioryDownloader] Already logged in!');
                await this.saveCookies();
                if (onStatusChange) onStatusChange({ status: 'logged_in', message: 'Already logged in' });
                return true;
            }

            // Not logged in - wait for user to login with polling
            console.log('[VioryDownloader] Waiting for user to login (polling every 3 seconds)...');
            if (onStatusChange) onStatusChange({ status: 'waiting_login', message: 'Please log in to Viory in the browser window' });

            const maxWaitTime = 5 * 60 * 1000; // 5 minutes max
            const pollInterval = 3000; // Check every 3 seconds
            const startTime = Date.now();

            while (Date.now() - startTime < maxWaitTime) {
                await this.page.waitForTimeout(pollInterval);

                // Check if user has logged in
                const loggedIn = await this.isLoggedIn();
                if (loggedIn) {
                    console.log('[VioryDownloader] Login detected! Saving session...');
                    await this.saveCookies();
                    if (onStatusChange) onStatusChange({ status: 'logged_in', message: 'Successfully logged in' });
                    return true;
                }

                const elapsed = Math.round((Date.now() - startTime) / 1000);
                console.log(`[VioryDownloader] Still waiting for login... (${elapsed}s elapsed)`);
            }

            // Timeout reached
            console.log('[VioryDownloader] Login timeout reached');
            await this.saveCookies(); // Save whatever cookies exist
            if (onStatusChange) onStatusChange({ status: 'timeout', message: 'Login timeout - please try again' });
            return false;
        } catch (e) {
            console.error('[VioryDownloader] Login flow error:', e.message);
            try { await this.saveCookies(); } catch (x) {}
            if (onStatusChange) onStatusChange({ status: 'error', message: e.message });
            return false;
        }
    }

    /**
     * Check if currently logged in to Viory
     * @returns {boolean} true if logged in
     */
    async isLoggedIn() {
        try {
            // Check if Sign In button/link is present (means NOT logged in)
            const isLoggedOut = await this.page.evaluate(() => {
                // Look for sign in links/buttons
                const signInLink = document.querySelector('a[href*="signin"], a[href*="login"]');
                const signInButton = Array.from(document.querySelectorAll('button, a')).find(el => {
                    const text = (el.textContent || '').toLowerCase();
                    return text.includes('sign in') || text.includes('log in') || text.includes('login');
                });
                
                // Also check for user profile indicators (means logged in)
                const profileIndicator = document.querySelector('[class*="avatar"], [class*="profile"], [class*="user-menu"]');
                const myContentLink = document.querySelector('a[href*="my-content"], a[href*="mycontent"]');
                
                // If we have profile indicators, we're logged in
                if (profileIndicator || myContentLink) {
                    return false; // NOT logged out
                }
                
                // If we have sign in button, we're logged out
                return !!(signInLink || signInButton);
            });

            return !isLoggedOut;
        } catch (e) {
            console.warn('[VioryDownloader] Error checking login state:', e.message);
            return false;
        }
    }

    /**
     * Verify session silently in headless mode (for startup check)
     * Creates a temporary headless browser to verify cookies without user seeing anything
     * @returns {{ valid: boolean, needsLogin: boolean }}
     */
    async verifySessionHeadless() {
        console.log('[VioryDownloader] Verifying session silently (headless)...');
        
        // Check if we even have cookies first
        if (!this.hasSavedSession()) {
            console.log('[VioryDownloader] No saved session found');
            return { valid: false, needsLogin: true };
        }

        let tempBrowser = null;
        let tempContext = null;
        let tempPage = null;

        try {
            // Get chromium path
            let executablePath = undefined;
            try {
                const appPath = path.dirname(process.execPath);
                const chromiumPath = path.join(appPath, 'resources', 'playwright-browsers', 'chromium', 'chrome-win64', 'chrome.exe');
                if (fs.existsSync(chromiumPath)) {
                    executablePath = chromiumPath;
                }
            } catch (e) { /* Use system chromium */ }

            // Create temporary headless browser
            tempBrowser = await chromium.launch({
                headless: true,
                channel: executablePath ? undefined : 'chromium',
                executablePath: executablePath,
                args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
            });

            tempContext = await tempBrowser.newContext({
                viewport: { width: 1400, height: 900 },
                userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            });

            // Load saved cookies
            const cookies = JSON.parse(fs.readFileSync(this.cookiesPath, 'utf-8'));
            await tempContext.addCookies(cookies);

            tempPage = await tempContext.newPage();

            // Navigate to Viory and check login state
            // OPTIMIZED: Changed from networkidle/20000 to domcontentloaded/15000
            // ORIGINAL: await tempPage.goto('https://www.viory.video/en/videos', { waitUntil: 'networkidle', timeout: 20000 });
            await tempPage.goto('https://www.viory.video/en/videos', { waitUntil: 'domcontentloaded', timeout: 15000 });
            // OPTIMIZED: Reduced from 1500ms to 800ms
            // ORIGINAL: await tempPage.waitForTimeout(1500);
            await tempPage.waitForTimeout(800);

            // Check if Sign In button is present
            const isLoggedOut = await tempPage.evaluate(() => {
                const signInLink = document.querySelector('a[href*="signin"], a[href*="login"]');
                const signInButton = Array.from(document.querySelectorAll('button, a')).find(el => {
                    const text = (el.textContent || '').toLowerCase();
                    return text.includes('sign in') || text.includes('log in');
                });
                const profileIndicator = document.querySelector('[class*="avatar"], [class*="profile"], [class*="user-menu"]');
                const myContentLink = document.querySelector('a[href*="my-content"], a[href*="mycontent"]');
                
                if (profileIndicator || myContentLink) return false;
                return !!(signInLink || signInButton);
            });

            if (!isLoggedOut) {
                console.log('[VioryDownloader] Session is valid!');
                return { valid: true, needsLogin: false };
            } else {
                console.log('[VioryDownloader] Session expired or invalid');
                return { valid: false, needsLogin: true };
            }
        } catch (e) {
            console.error('[VioryDownloader] Session verification failed:', e.message);
            return { valid: false, needsLogin: true, error: e.message };
        } finally {
            // Clean up temporary browser
            if (tempPage) await tempPage.close().catch(() => {});
            if (tempContext) await tempContext.close().catch(() => {});
            if (tempBrowser) await tempBrowser.close().catch(() => {});
        }
    }

    /**
     * Minimize the browser window (for background operation)
     */
    async minimizeWindow() {
        try {
            if (this.browser && this.page) {
                // Get the CDP session to control the window
                const cdpSession = await this.page.context().newCDPSession(this.page);
                const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
                await cdpSession.send('Browser.setWindowBounds', {
                    windowId,
                    bounds: { windowState: 'minimized' }
                });
                console.log('[VioryDownloader] Browser window minimized');
                return true;
            }
        } catch (e) {
            console.warn('[VioryDownloader] Could not minimize window:', e.message);
        }
        return false;
    }

    /**
     * Restore/show the browser window
     */
    async showWindow() {
        try {
            if (this.browser && this.page) {
                const cdpSession = await this.page.context().newCDPSession(this.page);
                const { windowId } = await cdpSession.send('Browser.getWindowForTarget');
                await cdpSession.send('Browser.setWindowBounds', {
                    windowId,
                    bounds: { windowState: 'normal' }
                });
                console.log('[VioryDownloader] Browser window restored');
                return true;
            }
        } catch (e) {
            console.warn('[VioryDownloader] Could not show window:', e.message);
        }
        return false;
    }

    /**
     * Save cookies to disk
     */
    async saveCookies() {
        const cookies = await this.context.cookies();
        fs.writeFileSync(this.cookiesPath, JSON.stringify(cookies, null, 2));
    }

    /**
     * Search for videos with Deep Analysis (smart matching)
     * Opens top candidates to check VIDEO INFO and SHOT LIST
     * @param {string} query - Search query
     * @param {number} limit - Max results to return
     * @returns {Array} - Array of video objects
     */
    async searchVideos(query, limit = 10) {
        // CRITICAL FIX: Handle undefined/null query
        if (!query || typeof query !== 'string') {
            console.error('[VioryDownloader] Query is undefined or not a string:', query);
            return [];
        }

        console.log('═══════════════════════════════════════════════════════════');
        console.log(`[VioryDownloader] SEARCH REQUEST`);
        console.log(`  Original Query: "${query}"`);

        // Clean query - handle "ON SCREEN: ..." format
        let cleanQuery = query;
        if (query.includes(':')) {
            cleanQuery = query.split(":")[1] || query;
        }
        const finalQuery = cleanQuery.replace(/[^\w\s-]/g, '').trim();

        console.log(`  Cleaned Query:  "${finalQuery}"`);

        if (!finalQuery) {
            console.error('[VioryDownloader] Query is empty after cleaning');
            return [];
        }

        const page = await this.ensurePage();

        try {
            // CORRECT URL format
            const searchUrl = `https://www.viory.video/en/videos?search=${encodeURIComponent(finalQuery)}`;
            console.log(`  Search URL:     ${searchUrl}`);
            console.log('═══════════════════════════════════════════════════════════');

            // Retry loop for search results page
            let searchRetries = 3;
            let searchSuccess = false;

            while (searchRetries > 0 && !searchSuccess) {
                try {
                    // OPTIMIZED: Use domcontentloaded for faster initial response
                    // ORIGINAL: await page.goto(searchUrl, { waitUntil: 'networkidle', timeout: 30000 });
                    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

                    // Check for server errors on search page
                    const isError = await page.evaluate(() => {
                        const title = document.title;
                        const text = document.body.innerText;
                        return title.includes('504') || title.includes('502') ||
                            text.includes('Gateway Time-out') || text.includes('Bad Gateway');
                    });

                    if (isError) throw new Error('Search Page Server Error (504/502)');

                    searchSuccess = true;
                } catch (e) {
                    console.warn(`[VioryDownloader] Search load failed: ${e.message}`);
                    searchRetries--;
                    if (searchRetries > 0) {
                        // OPTIMIZED: Reduced from 3000ms to 1500ms
                        // ORIGINAL: await new Promise(r => setTimeout(r, 3000));
                        console.log(`[VioryDownloader] Retrying search in 1.5s...`);
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
            }

            if (!searchSuccess) {
                console.error('[VioryDownloader] Failed to load search page after 3 attempts');
                return [];
            }

            await this.dismissPopups();

            try {
                // OPTIMIZED: Reduced from 30000ms to 10000ms
                // ORIGINAL: await page.waitForSelector('a[href*="/videos/"]', { timeout: 30000 });
                await page.waitForSelector('a[href*="/videos/"]', { timeout: 10000 });
            } catch (e) {
                console.log('[VioryDownloader] No videos found for query');
                return [];
            }

            // Get candidate URLs (scrape basic info first)
            const candidates = await page.evaluate((maxLimit) => {
                const results = [];
                const allLinks = document.querySelectorAll('a[href*="/videos/"]');
                allLinks.forEach(link => {
                    if (results.length >= maxLimit) return;
                    const href = link.getAttribute('href');
                    if (!href || href.includes('/videos?')) return;
                    const fullUrl = href.startsWith('http') ? href : `https://www.viory.video${href}`;
                    // Avoid duplicates
                    if (!results.find(r => r.url === fullUrl)) {
                        results.push({ url: fullUrl });
                    }
                });
                return results;
            }, 5); // Analyze top 5 videos deeply

            console.log(`[VioryDownloader] Found ${candidates.length} candidates for Deep Analysis...`);

            // DEEP ANALYSIS: Visit each video to get full metadata
            const analyzedVideos = [];

            for (const candidate of candidates) {
                // Add retry logic for individual video analysis
                let retries = 3;
                let success = false;

                while (retries > 0 && !success) {
                    try {
                        console.log(`[VioryDownloader] Analyzing: ${candidate.url} (Attempt ${4 - retries}/3)`);

                        // OPTIMIZED: Reduced from 2000ms to 800ms for rate limiting
                        // ORIGINAL: await new Promise(r => setTimeout(r, 2000));
                        await new Promise(r => setTimeout(r, 800));

                        // OPTIMIZED: Use domcontentloaded instead of networkidle for faster load
                        // ORIGINAL: await page.goto(candidate.url, { waitUntil: 'networkidle', timeout: 30000 });
                        await page.goto(candidate.url, { waitUntil: 'domcontentloaded', timeout: 25000 });

                        // OPTIMIZED: Wait for title selector instead of fixed timeout
                        // This ensures page is ready before proceeding
                        await page.waitForSelector('h1', { timeout: 3000 }).catch(() => {});
                        
                        // OPTIMIZED: Reduced from 1500ms to 600ms for dynamic content
                        // ORIGINAL: await page.waitForTimeout(1500);
                        await page.waitForTimeout(600);

                        // CHECK FOR ERROR PAGES (504, 403, etc)
                        const isError = await page.evaluate(() => {
                            const text = document.body.innerText;
                            const title = document.title;
                            return title.includes('504') || title.includes('502') || title.includes('403') ||
                                text.includes('Gateway Time-out') || text.includes('Bad Gateway') ||
                                text.includes('Access Denied');
                        });

                        if (isError) {
                            throw new Error('Detected Server Error Page (504/502/403)');
                        }

                        success = true;
                    } catch (e) {
                        console.warn(`[VioryDownloader] Failed to load video page: ${e.message}`);
                        retries--;
                        if (retries > 0) {
                            const waitTime = (4 - retries) * 3000;
                            console.log(`[VioryDownloader] Retrying in ${waitTime / 1000}s...`);
                            await new Promise(r => setTimeout(r, waitTime));
                        } else {
                            console.error(`[VioryDownloader] Skipper video after 3 failed attempts: ${candidate.url}`);
                            continue; // Skip to next candidate
                        }
                    }
                }

                if (!success) continue;

                try {

                    const metadata = await page.evaluate(() => {
                        const result = {
                            title: '',
                            description: '',
                            videoInfo: '',
                            shotList: '',
                            mandatoryCredit: '',
                            duration: '',
                            allText: ''
                        };

                        const h1 = document.querySelector('h1');
                        if (h1) result.title = h1.innerText.trim();

                        // Fallback Title Extraction
                        if (!result.title) {
                            const metaTitle = document.querySelector('meta[property="og:title"]');
                            if (metaTitle) result.title = metaTitle.getAttribute('content');
                        }
                        if (!result.title) {
                            result.title = document.title.replace('| Viory', '').trim();
                        }

                        const sections = document.querySelectorAll('div, section, p, span');
                        sections.forEach(section => {
                            const text = section.innerText || '';
                            if (text.includes('VIDEO INFO') || text.includes('Video Info')) {
                                const infoMatch = text.match(/VIDEO INFO[\s\S]*?(?=(SHOT LIST|$))/i);
                                if (infoMatch) result.videoInfo = infoMatch[0].replace(/VIDEO INFO/i, '').trim().substring(0, 800);
                            }
                            if (text.includes('SHOT LIST') || text.includes('Shot List')) {
                                const shotMatch = text.match(/SHOT LIST[\s\S]*/i);
                                if (shotMatch) result.shotList = shotMatch[0].replace(/SHOT LIST/i, '').trim().substring(0, 1000);
                            }
                            // Extract Mandatory credit
                            if (text.includes('Mandatory credit') || text.includes('mandatory credit') || text.includes('MANDATORY CREDIT')) {
                                const creditMatch = text.match(/[Mm]andatory\s*credit\s*[:\s]\s*([^;\/\n]+)/i);
                                if (creditMatch && creditMatch[1]) {
                                    // Clean the credit text - take only the main credit, stop at delimiters
                                    let credit = creditMatch[1].trim();
                                    // Remove any trailing punctuation or extra text after semicolon
                                    credit = credit.replace(/[;].*$/, '').trim();
                                    // Only use if it's reasonable length (not too short or too long)
                                    if (credit.length >= 3 && credit.length <= 100 && !result.mandatoryCredit) {
                                        result.mandatoryCredit = credit;
                                    }
                                }
                            }
                        });

                        const metaDesc = document.querySelector('meta[name="description"]');
                        if (metaDesc) result.description = metaDesc.content;

                        const durationMatch = document.body.innerText.match(/\d+:\d{2}/);
                        if (durationMatch) result.duration = durationMatch[0];

                        result.allText = document.body.innerText.substring(0, 5000);
                        return result;
                    });

                    // FIXED: Calculate score OUTSIDE page.evaluate() where 'this' is valid
                    const score = this.calculateRelevance(finalQuery, metadata);

                    // DEBUG: Log mandatory credit extraction
                    console.log(`   > [DEBUG] mandatoryCredit extracted: "${metadata.mandatoryCredit || '(empty)'}"`);

                    analyzedVideos.push({
                        ...candidate,
                        ...metadata,
                        score
                    });

                    console.log(`   > Score: ${score.total} (Title: "${metadata.title.substring(0, 30)}...")`);
                    if (metadata.mandatoryCredit) {
                        console.log(`   > ✅ MandatoryCredit: "${metadata.mandatoryCredit}"`);
                    } else {
                        console.log(`   > ⚠️ No MandatoryCredit found on this page`);
                    }

                } catch (e) {
                    console.warn(`[VioryDownloader] Failed to analyze ${candidate.url}:`, e.message);
                }
            }

            // Sort by score
            analyzedVideos.sort((a, b) => b.score.total - a.score.total);

            // Filter out low relevance (optional, currently just taking best)
            return analyzedVideos;

        } catch (e) {
            console.error('[VioryDownloader] Search failed:', e.message);
            throw e;
        }
    }

    /**
     * Capture screenshot of video thumbnail/preview
     * @param {string} selector - CSS selector for the element to capture
     * @returns {Buffer|null} Screenshot buffer or null if failed
     */
    async captureScreenshot(selector = null) {
        try {
            const page = await this.ensurePage();

            if (selector) {
                // Capture specific element
                const element = await page.$(selector);
                if (element) {
                    const buffer = await element.screenshot({ type: 'png' });
                    console.log(`[VioryDownloader] Captured element screenshot (${selector})`);
                    return buffer;
                }
            }

            // Fallback: capture video preview area or main content
            const fallbackSelectors = [
                'video',
                '[class*="video-player"]',
                '[class*="preview"]',
                'img[src*="thumb"]',
                '.video-container',
                'main img',
                '.aspect-video'
            ];

            for (const sel of fallbackSelectors) {
                try {
                    const el = await page.$(sel);
                    if (el) {
                        const buffer = await el.screenshot({ type: 'png' });
                        console.log(`[VioryDownloader] Captured screenshot via fallback: ${sel}`);
                        return buffer;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            // Last resort: capture viewport
            console.log('[VioryDownloader] Capturing full viewport screenshot');
            const buffer = await page.screenshot({
                type: 'png',
                clip: { x: 0, y: 100, width: 800, height: 450 } // Approximate video area
            });
            return buffer;

        } catch (error) {
            console.error('[VioryDownloader] Screenshot capture failed:', error.message);
            return null;
        }
    }

    /**
     * Enhanced search with screenshot capture for visual validation
     * @param {string} query - Search query
     * @param {number} limit - Max results
     * @param {Object} options - Additional options
     * @returns {Array} Videos with metadata and screenshots
     */
    async searchVideosWithScreenshots(query, limit = 5, options = {}) {
        const { captureScreenshots = true, blockAnalysis = null } = options;

        // First do the regular search
        const videos = await this.searchVideos(query, limit);

        if (!captureScreenshots || videos.length === 0) {
            return videos;
        }

        console.log(`[VioryDownloader] Capturing screenshots for ${videos.length} videos...`);

        const page = await this.ensurePage();

        for (let i = 0; i < videos.length; i++) {
            const video = videos[i];

            // Check cache first
            if (screenshotCache.has(video.url)) {
                video.screenshot = screenshotCache.get(video.url);
                console.log(`[VioryDownloader] Using cached screenshot for video ${i + 1}`);
                continue;
            }

            try {
                // Navigate to video page if not already there
                const currentUrl = page.url();
                if (!currentUrl.includes(video.url.split('/').pop())) {
                    await page.goto(video.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
                    await page.waitForTimeout(1500);
                }

                // Capture screenshot
                const screenshot = await this.captureScreenshot();
                if (screenshot) {
                    video.screenshot = screenshot;
                    video.screenshotBase64 = screenshot.toString('base64');
                    screenshotCache.set(video.url, screenshot);
                    console.log(`[VioryDownloader] Screenshot captured for video ${i + 1}: ${video.title?.substring(0, 30)}...`);
                }

                // Small delay between captures
                if (i < videos.length - 1) {
                    await page.waitForTimeout(500);
                }

            } catch (error) {
                console.warn(`[VioryDownloader] Failed to capture screenshot for video ${i + 1}:`, error.message);
                video.screenshot = null;
            }
        }

        return videos;
    }

    /**
     * Search with AI-powered queries (uses script analyzer queries)
     * @param {Array} queries - Array of search queries to try (from scriptAnalyzer)
     * @param {Object} blockAnalysis - Block analysis with visual_targets
     * @param {Object} options - Search options
     * @returns {Object} Best videos found
     */
    async searchWithSmartQueries(queries, blockAnalysis, options = {}) {
        const {
            maxVideosPerQuery = 3,
            captureScreenshots = true,
            onProgress = () => {}
        } = options;

        const allVideos = [];
        const seenUrls = new Set();
        const successfulQueries = [];

        console.log(`[VioryDownloader] Smart search with ${queries.length} queries...`);

        for (let i = 0; i < queries.length; i++) {
            const query = queries[i];

            onProgress({
                type: 'searching',
                query,
                attemptNum: i + 1,
                totalQueries: queries.length,
                message: `Buscando: "${query}"`
            });

            try {
                const videos = await this.searchVideosWithScreenshots(
                    query,
                    maxVideosPerQuery,
                    { captureScreenshots, blockAnalysis }
                );

                if (videos && videos.length > 0) {
                    let addedCount = 0;

                    for (const video of videos) {
                        if (!seenUrls.has(video.url)) {
                            seenUrls.add(video.url);
                            video.sourceQuery = query;
                            video.queryIndex = i;
                            allVideos.push(video);
                            addedCount++;
                        }
                    }

                    if (addedCount > 0) {
                        successfulQueries.push(query);
                        onProgress({
                            type: 'found',
                            query,
                            videoCount: addedCount,
                            totalSoFar: allVideos.length,
                            attemptNum: i + 1
                        });
                    }
                }

                // Delay between queries
                if (i < queries.length - 1) {
                    await new Promise(r => setTimeout(r, 1000));
                }

            } catch (error) {
                console.error(`[VioryDownloader] Query "${query}" failed:`, error.message);
                onProgress({
                    type: 'error',
                    query,
                    error: error.message,
                    attemptNum: i + 1
                });
            }
        }

        return {
            videos: allVideos,
            successfulQueries,
            totalFound: allVideos.length
        };
    }

    /**
     * Clear screenshot cache (call periodically to free memory)
     */
    clearScreenshotCache() {
        const size = screenshotCache.size;
        screenshotCache.clear();
        console.log(`[VioryDownloader] Cleared ${size} cached screenshots`);
    }

    /**
     * Calculate relevance score based on query and metadata
     */
    calculateRelevance(query, metadata) {
        let score = 0;
        const queryLower = query.toLowerCase();
        const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

        // Combine all text
        const content = (
            (metadata.title || '') + ' ' +
            (metadata.description || '') + ' ' +
            (metadata.videoInfo || '') + ' ' +
            (metadata.shotList || '')
        ).toLowerCase();

        // Check exact match
        if (content.includes(queryLower)) score += 30;

        // Check keywords
        let matched = 0;
        queryWords.forEach(word => {
            if (content.includes(word)) {
                score += 10;
                matched++;

                // Extra points if in title
                if ((metadata.title || '').toLowerCase().includes(word)) score += 10;
            }
        });

        // Context keywords (user preferences)
        PRIORITY_KEYWORDS.forEach(kw => {
            if (content.includes(kw)) score += 5;
        });

        // Penalties (e.g. if it's too short or malformed)
        if (!metadata.title) score -= 20;

        return { total: score, matched };
    }

    // Deprecated: simple selection (replaced by searchVideos deep analysis)
    selectBestVideos(videos, query, limit) {
        return videos;
    }

    /**
     * Download a video with checkbox handling, "preparing video" detection, and My Content fallback
     */
    async downloadVideo(videoUrl, onProgress) {
        console.log(`[VioryDownloader] Opening video: ${videoUrl}`);

        // Store video title for matching in My Content
        let videoTitle = '';

        try {
            // OPTIMIZED: Changed from networkidle/30000 to domcontentloaded/25000
            // ORIGINAL: await this.page.goto(videoUrl, { waitUntil: 'networkidle', timeout: 30000 });
            await this.page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            // OPTIMIZED: Wait for button selector instead of fixed 2000ms timeout
            // ORIGINAL: await this.page.waitForTimeout(2000);
            await this.page.waitForSelector('button', { timeout: 5000 }).catch(() => {});
            await this.page.waitForTimeout(800);
            await this.dismissPopups();

            // Extract video title for later matching
            videoTitle = await this.page.evaluate(() => {
                const h1 = document.querySelector('h1');
                return h1 ? h1.innerText.trim() : '';
            });
            console.log(`[VioryDownloader] Video title: "${videoTitle.substring(0, 50)}..."`);

            // Scroll to show download button
            await this.page.evaluate(() => window.scrollBy(0, 300));
            // OPTIMIZED: Reduced from 500ms to 200ms
            // ORIGINAL: await this.page.waitForTimeout(500);
            await this.page.waitForTimeout(200);

            // STEP 1: Click initial Download button to open modal
            console.log('[VioryDownloader] Clicking Download button to open modal...');
            const openedModal = await this.page.evaluate(() => {
                const btns = Array.from(document.querySelectorAll('button'));
                const dlBtn = btns.find(b => {
                    const text = b.textContent || '';
                    return text.includes('Download') &&
                        !text.includes('MP4') &&
                        !text.includes('720') &&
                        !text.includes('360');
                });
                if (dlBtn) {
                    dlBtn.click();
                    return true;
                }
                return false;
            });

            if (!openedModal) {
                console.log('[VioryDownloader] Could not find Download button');
            }

            // OPTIMIZED: Reduced from 2000ms to 1000ms
            // ORIGINAL: await this.page.waitForTimeout(2000);
            await this.page.waitForTimeout(1000);

            // STEP 2: Wait for modal to appear
            console.log('[VioryDownloader] Waiting for download modal...');
            try {
                await this.page.waitForSelector('input[type="checkbox"]', { timeout: 5000 });
            } catch (e) {
                console.log('[VioryDownloader] No checkbox found, trying direct download...');
            }

            // STEP 3: Handle restrictions checkbox (CRITICAL)
            console.log('[VioryDownloader] Handling restrictions checkbox...');
            const checkboxResult = await this.handleRestrictionsCheckbox();
            console.log(`[VioryDownloader] Checkbox result: ${checkboxResult}`);

            // OPTIMIZED: Reduced from 500ms to 250ms
            // ORIGINAL: await this.page.waitForTimeout(500);
            await this.page.waitForTimeout(250);

            // STEP 4: Set up download listener BEFORE clicking
            const downloadPromise = this.page.waitForEvent('download', { timeout: 15000 }).catch(() => null);

            // STEP 5: Click the modal's submit/download button
            console.log('[VioryDownloader] Clicking modal submit button...');
            const clickedSubmit = await this.page.evaluate(() => {
                const modal = document.querySelector('[role="dialog"], .modal, [class*="modal"], [class*="Modal"]') || document.body;
                const btns = Array.from(modal.querySelectorAll('button'));

                let submitBtn = btns.find(b => {
                    const text = (b.textContent || '').toLowerCase();
                    return (text.includes('download') || text.includes('confirm') || text.includes('submit')) &&
                        !b.disabled;
                });

                if (!submitBtn) {
                    submitBtn = btns.find(b => {
                        const classes = b.className || '';
                        return (classes.includes('primary') || classes.includes('submit') || classes.includes('bg-blue') || classes.includes('bg-indigo')) &&
                            !b.disabled;
                    });
                }

                if (!submitBtn) {
                    submitBtn = btns.find(b => {
                        const text = (b.textContent || '').toLowerCase();
                        return text.includes('download') && !b.disabled;
                    });
                }

                if (!submitBtn && btns.length > 0) {
                    submitBtn = btns[btns.length - 1];
                }

                if (submitBtn) {
                    submitBtn.click();
                    return { clicked: true, text: submitBtn.textContent };
                }
                return { clicked: false };
            });

            console.log(`[VioryDownloader] Submit button result:`, clickedSubmit);

            // STEP 6: Wait a moment and check if "preparing" modal appeared
            // OPTIMIZED: Reduced from 2000ms to 1200ms
            // ORIGINAL: await this.page.waitForTimeout(2000);
            await this.page.waitForTimeout(1200);

            // Check for "We are preparing your video" modal
            const preparingModal = await this.checkForPreparingModal();

            if (preparingModal.isPreparing) {
                console.log('[VioryDownloader] Detected "Preparing video" modal - video needs watermarking');
                if (onProgress) onProgress({ status: 'preparing', message: 'Video is being prepared with watermark...' });

                // Click "Go to My content" button if available
                if (preparingModal.hasGoToMyContent) {
                    console.log('[VioryDownloader] Clicking "Go to My content" button...');
                    await this.page.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button, a'));
                        const myContentBtn = btns.find(b => {
                            const text = (b.textContent || '').toLowerCase();
                            return text.includes('my content') || text.includes('go to my');
                        });
                        if (myContentBtn) myContentBtn.click();
                    });
                    // OPTIMIZED: Reduced from 2000ms to 1000ms
                    // ORIGINAL: await this.page.waitForTimeout(2000);
                    await this.page.waitForTimeout(1000);
                }

                // Go to My Content and wait for the video
                return await this.downloadFromMyContent(onProgress, videoTitle);
            }

            // Wait for download (with shorter timeout since we already checked for preparing modal)
            const download = await downloadPromise;

            if (download) {
                // Direct download started
                const filename = download.suggestedFilename();
                const savePath = path.join(this.downloadsPath, filename);
                console.log(`[VioryDownloader] Downloading: ${filename}`);

                if (onProgress) onProgress({ status: 'downloading', filename });
                await download.saveAs(savePath);
                await this.saveCookies();

                console.log(`[VioryDownloader] Saved: ${savePath}`);
                return { success: true, path: savePath, filename };
            } else {
                // Download didn't start - try My Content fallback
                console.log('[VioryDownloader] Direct download not started, checking My Content...');
                return await this.downloadFromMyContent(onProgress, videoTitle);
            }

        } catch (error) {
            console.error('[VioryDownloader] Download failed:', error.message);
            // Fallback to My Content
            try {
                return await this.downloadFromMyContent(onProgress, videoTitle);
            } catch (fallbackError) {
                console.error('[VioryDownloader] My Content fallback also failed:', fallbackError.message);
                throw error;
            }
        }
    }

    /**
     * Check if "We are preparing your video" modal is displayed
     */
    async checkForPreparingModal() {
        try {
            const result = await this.page.evaluate(() => {
                const pageText = document.body.innerText.toLowerCase();
                const isPreparing = pageText.includes('preparing your video') ||
                    pageText.includes('we are preparing') ||
                    pageText.includes('it\'ll take a few minutes') ||
                    pageText.includes('will receive an email');

                // Check for "Go to My content" button/link
                const btns = Array.from(document.querySelectorAll('button, a'));
                const hasGoToMyContent = btns.some(b => {
                    const text = (b.textContent || '').toLowerCase();
                    return text.includes('my content') || text.includes('go to my');
                });

                // Check for "Continue" button (means preparing modal is open)
                const hasContinue = btns.some(b => {
                    const text = (b.textContent || '').toLowerCase();
                    return text === 'continue' || text.includes('continue');
                });

                return {
                    isPreparing: isPreparing || (hasGoToMyContent && hasContinue),
                    hasGoToMyContent,
                    hasContinue
                };
            });

            if (result.isPreparing) {
                console.log('[VioryDownloader] Preparing modal detected:', result);
            }

            return result;
        } catch (e) {
            return { isPreparing: false, hasGoToMyContent: false, hasContinue: false };
        }
    }

    /**
     * Handle restrictions checkbox with Playwright native methods (more reliable)
     */
    async handleRestrictionsCheckbox() {
        try {
            // OPTIMIZED: Reduced from 500ms to 300ms for modal stabilization
            // ORIGINAL: await this.page.waitForTimeout(500);
            await this.page.waitForTimeout(300);

            // Try to find checkbox using multiple selectors
            const checkboxSelectors = [
                'input[type="checkbox"]',
                'label:has-text("understand") input[type="checkbox"]',
                'label:has-text("restrictions") input[type="checkbox"]',
                '[class*="checkbox"]'
            ];

            let checkbox = null;

            // Try each selector
            for (const selector of checkboxSelectors) {
                try {
                    const locator = this.page.locator(selector).first();
                    const count = await locator.count();
                    if (count > 0) {
                        checkbox = locator;
                        console.log(`[VioryDownloader] Found checkbox with: ${selector}`);
                        break;
                    }
                } catch (e) {
                    // Try next selector
                }
            }

            if (!checkbox) {
                console.log('[VioryDownloader] No checkbox found in modal');
                return 'not_found';
            }

            // Check if already checked
            const isChecked = await checkbox.isChecked().catch(() => false);
            if (isChecked) {
                console.log('[VioryDownloader] Checkbox already checked');
                return 'already_checked';
            }

            // Strategy 1: Click the checkbox directly with force
            // OPTIMIZED: Reduced timeout from 3000ms to 2000ms, wait from 300ms to 150ms
            // ORIGINAL: timeout: 3000, waitForTimeout(300)
            try {
                await checkbox.click({ force: true, timeout: 2000 });
                await this.page.waitForTimeout(150);
                const checked1 = await checkbox.isChecked().catch(() => false);
                if (checked1) {
                    console.log('[VioryDownloader] Checkbox: success with direct click');
                    return 'success_direct';
                }
            } catch (e) {
                console.log('[VioryDownloader] Direct checkbox click failed:', e.message);
            }

            // Strategy 2: Click the parent label
            // OPTIMIZED: Same reductions as Strategy 1
            try {
                const label = this.page.locator('label:has-text("restrictions"), label:has-text("understand")').first();
                const labelCount = await label.count();
                if (labelCount > 0) {
                    await label.click({ force: true, timeout: 2000 });
                    await this.page.waitForTimeout(150);
                    const checked2 = await checkbox.isChecked().catch(() => false);
                    if (checked2) {
                        console.log('[VioryDownloader] Checkbox: success with label click');
                        return 'success_label';
                    }
                }
            } catch (e) {
                console.log('[VioryDownloader] Label click failed:', e.message);
            }

            // Strategy 3: Use JavaScript to force check
            // OPTIMIZED: Reduced wait from 300ms to 150ms
            try {
                await this.page.evaluate(() => {
                    const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'));
                    const restrictionsCb = checkboxes.find(cb => {
                        const container = cb.closest('div') || cb.closest('label') || document.body;
                        const text = container.innerText || '';
                        return text.toLowerCase().includes('understand') || text.toLowerCase().includes('restrictions');
                    }) || checkboxes[0];

                    if (restrictionsCb && !restrictionsCb.checked) {
                        restrictionsCb.checked = true;
                        restrictionsCb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                        restrictionsCb.dispatchEvent(new Event('change', { bubbles: true }));
                        restrictionsCb.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                });
                await this.page.waitForTimeout(150);
                const checked3 = await checkbox.isChecked().catch(() => false);
                if (checked3) {
                    console.log('[VioryDownloader] Checkbox: success with JS force');
                    return 'success_forced';
                }
            } catch (e) {
                console.log('[VioryDownloader] JS force check failed:', e.message);
            }

            // Strategy 4: Try clicking anywhere on the checkbox's row/container
            // OPTIMIZED: Same reductions
            try {
                const container = this.page.locator('div:has(input[type="checkbox"]):has-text("restrictions")').first();
                const containerCount = await container.count();
                if (containerCount > 0) {
                    await container.click({ force: true, timeout: 2000 });
                    await this.page.waitForTimeout(150);
                    return 'success_container';
                }
            } catch (e) {
                console.log('[VioryDownloader] Container click failed:', e.message);
            }

            return 'failed';
        } catch (error) {
            console.error('[VioryDownloader] Checkbox handling error:', error.message);
            return 'error';
        }
    }

    /**
     * Download video from My Content page (fallback)
     * @param {Function} onProgress - Progress callback
     * @param {string} targetVideoTitle - Optional title to match (for better identification)
     */
    async downloadFromMyContent(onProgress, targetVideoTitle = '') {
        console.log('[VioryDownloader] Navigating to My Content page...');
        console.log(`[VioryDownloader] Looking for video: "${(targetVideoTitle || '').substring(0, 50)}..."`);

        // OPTIMIZED: Changed from networkidle/30000 to domcontentloaded/25000
        // ORIGINAL: await this.page.goto('https://www.viory.video/en/user', { waitUntil: 'networkidle', timeout: 30000 });
        await this.page.goto('https://www.viory.video/en/user', {
            waitUntil: 'domcontentloaded',
            timeout: 25000
        });
        // OPTIMIZED: Wait for button selector + reduced from 3000ms to 1500ms
        // ORIGINAL: await this.page.waitForTimeout(3000);
        await this.page.waitForSelector('button', { timeout: 5000 }).catch(() => {});
        await this.page.waitForTimeout(1500);

        // Extract keywords from target title for matching
        const targetTitleLower = (targetVideoTitle || '').toLowerCase();
        const targetKeywords = targetTitleLower
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3 && !['video', 'viory', 'download'].includes(w))
            .slice(0, 5);

        console.log(`[VioryDownloader] Target keywords: [${targetKeywords.join(', ')}]`);

        // Helper function to check if a title matches our target
        const titleMatchesTarget = (title) => {
            if (!targetVideoTitle || targetKeywords.length === 0) return true; // No target = accept any
            const titleLower = (title || '').toLowerCase();
            const matchCount = targetKeywords.filter(kw => titleLower.includes(kw)).length;
            const minRequired = Math.min(2, targetKeywords.length);
            return matchCount >= minRequired;
        };

        let attempts = 0;
        // OPTIMIZED: Increased from 36 to 45 to compensate for faster polling
        // ORIGINAL: const maxAttempts = 36; // 3 minutes max (5 sec intervals)
        const maxAttempts = 45; // ~3 minutes with adaptive polling (2.5s then 4s intervals)

        while (attempts < maxAttempts) {
            // Scan ALL video cards in My Content page (including those still preparing)
            const contentInfo = await this.page.evaluate(() => {
                const videos = [];

                // Find all video cards by looking for "Video • ID" text pattern
                // This catches ALL videos, not just those with download buttons ready
                const allElements = document.querySelectorAll('*');
                const videoCards = [];

                allElements.forEach(el => {
                    const text = el.innerText || '';
                    // Look for video ID pattern and make sure it's a container (not too deep)
                    if (text.includes('Video') && text.includes('ID a') && el.children.length > 0) {
                        // Check if this element has either a download button OR preparing text
                        const hasDownloadBtn = text.toLowerCase().includes('download') && text.toLowerCase().includes('1080p');
                        const isPreparing = text.toLowerCase().includes('preparing') || text.toLowerCase().includes('cancel request');

                        if (hasDownloadBtn || isPreparing) {
                            // Make sure we don't add parent elements of already added cards
                            const isParentOfExisting = videoCards.some(card => el.contains(card));
                            const isChildOfExisting = videoCards.some(card => card.contains(el));

                            if (!isParentOfExisting && !isChildOfExisting) {
                                videoCards.push(el);
                            } else if (isParentOfExisting) {
                                // Replace with smaller (more specific) element
                                const idx = videoCards.findIndex(card => el.contains(card));
                                // Keep the smaller one
                            }
                        }
                    }
                });

                // Process each video card
                videoCards.forEach((card, index) => {
                    const cardText = card.innerText || '';
                    const lines = cardText.split('\n').map(l => l.trim()).filter(l => l);

                    let title = '';
                    let videoId = '';
                    let isReady = false;
                    let isPreparing = false;

                    for (const line of lines) {
                        // Extract video ID
                        if (line.includes('ID a') || line.match(/ID\s+a\d+/)) {
                            videoId = line;
                        }
                        // Check status
                        if (line.toLowerCase().includes('download') && line.toLowerCase().includes('1080p')) {
                            isReady = true;
                        }
                        if (line.toLowerCase().includes('preparing') || line.toLowerCase().includes('cancel request')) {
                            isPreparing = true;
                        }
                        // Extract title (not metadata lines)
                        if (!title &&
                            line.length > 15 &&
                            !line.startsWith('Video') &&
                            !line.toLowerCase().includes('download') &&
                            !line.toLowerCase().includes('1080p') &&
                            !line.toLowerCase().includes('preparing') &&
                            !line.toLowerCase().includes('cancel') &&
                            !line.includes('ID a')) {
                            title = line;
                        }
                    }

                    if (title || videoId) {
                        videos.push({
                            index,
                            title: title.substring(0, 250),
                            videoId,
                            isReady,        // Has "Download 1080p, mp4, Branded" button
                            isPreparing,    // Shows "Preparing to download..."
                            cardIndex: index
                        });
                    }
                });

                // Sort by position (first = most recent)
                // Note: videoCards are already in DOM order

                return {
                    videos,
                    totalVideos: videos.length,
                    hasAnyPreparing: videos.some(v => v.isPreparing),
                    hasAnyReady: videos.some(v => v.isReady)
                };
            });

            console.log(`[VioryDownloader] Found ${contentInfo.totalVideos} videos in My Content`);
            console.log(`[VioryDownloader] Status: ${contentInfo.hasAnyReady ? 'Some ready' : 'None ready'}, ${contentInfo.hasAnyPreparing ? 'Some preparing' : 'None preparing'}`);

            // Log all videos found with their status
            contentInfo.videos.forEach((v, i) => {
                const status = v.isReady ? '✓ READY' : (v.isPreparing ? '⏳ PREPARING' : '? UNKNOWN');
                console.log(`[VioryDownloader]   ${i + 1}. [${status}] "${(v.title || 'No title').substring(0, 50)}..."`);
            });

            if (contentInfo.totalVideos > 0) {
                // Find the video that matches our target
                let matchingVideo = null;

                for (let i = 0; i < contentInfo.videos.length; i++) {
                    const video = contentInfo.videos[i];
                    if (titleMatchesTarget(video.title)) {
                        matchingVideo = video;
                        console.log(`[VioryDownloader] ✓ Match found at position ${i + 1}: "${video.title.substring(0, 50)}..."`);
                        break;
                    }
                }

                if (matchingVideo) {
                    // Check if matching video is READY or still PREPARING
                    if (matchingVideo.isPreparing && !matchingVideo.isReady) {
                        // Video is still preparing - WAIT for it, don't download anything else!
                        console.log(`[VioryDownloader] ⏳ Matching video is still preparing. Waiting...`);
                        console.log(`[VioryDownloader] Target: "${matchingVideo.title.substring(0, 50)}..."`);

                        if (onProgress) {
                            onProgress({
                                status: 'processing',
                                message: `Video preparing... (${attempts + 1}/${maxAttempts})`,
                                attempt: attempts + 1,
                                maxAttempts
                            });
                        }

                        // OPTIMIZED: Adaptive polling - faster at start, slower later
                        // ORIGINAL: await this.page.waitForTimeout(5000); (fixed 5s)
                        // First 6 attempts (~15-18s): poll every 2.5s, then every 4s
                        const pollDelay = attempts < 6 ? 2500 : 4000;
                        await this.page.waitForTimeout(pollDelay);
                        // OPTIMIZED: Changed from networkidle to domcontentloaded
                        // ORIGINAL: await this.page.reload({ waitUntil: 'networkidle' }).catch(() => {});
                        await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                        await this.page.waitForTimeout(800);
                        attempts++;
                        continue; // Go back to start of while loop
                    }

                    if (matchingVideo.isReady) {
                        // Video is ready - download it!
                        console.log(`[VioryDownloader] ✓ Matching video is READY. Downloading...`);

                        const downloadPromise = this.page.waitForEvent('download', { timeout: 60000 }).catch(() => null);

                        // Find and click the download button for THIS specific video by title
                        const clicked = await this.page.evaluate((targetTitle) => {
                            // Find all video cards with download buttons
                            const buttons = Array.from(document.querySelectorAll('button')).filter(btn => {
                                const text = (btn.textContent || '').toLowerCase();
                                return text.includes('download') && text.includes('1080p');
                            });

                            // Find the button whose parent container has the matching title
                            for (const btn of buttons) {
                                let container = btn.parentElement;
                                for (let i = 0; i < 6 && container; i++) {
                                    if (container.innerText && container.innerText.includes(targetTitle.substring(0, 50))) {
                                        btn.click();
                                        return { clicked: true, buttonText: btn.textContent.trim() };
                                    }
                                    container = container.parentElement;
                                }
                            }

                            // Fallback: click first download button (should match if our logic is correct)
                            if (buttons.length > 0) {
                                buttons[0].click();
                                return { clicked: true, buttonText: buttons[0].textContent.trim(), fallback: true };
                            }

                            return { clicked: false };
                        }, matchingVideo.title);

                        if (clicked.clicked) {
                            console.log(`[VioryDownloader] Clicked: "${clicked.buttonText}"${clicked.fallback ? ' (fallback)' : ''}`);
                            if (onProgress) onProgress({ status: 'downloading', message: 'Downloading from My Content...' });

                            const download = await downloadPromise;
                            if (download) {
                                const filename = download.suggestedFilename();
                                const savePath = path.join(this.downloadsPath, filename);

                                if (onProgress) onProgress({ status: 'saving', filename });
                                await download.saveAs(savePath);
                                await this.saveCookies();

                                console.log(`[VioryDownloader] ✓ Downloaded: ${savePath}`);
                                return {
                                    success: true,
                                    path: savePath,
                                    filename,
                                    fromMyContent: true,
                                    videoTitle: matchingVideo.title
                                };
                            }
                        }
                    }
                } else {
                    // No matching video found in the list
                    console.log(`[VioryDownloader] ✗ No matching video found. Keywords: [${targetKeywords.join(', ')}]`);

                    // Check if we should keep waiting (video might still be processing)
                    if (contentInfo.hasAnyPreparing) {
                        console.log(`[VioryDownloader] Some videos still preparing, waiting...`);
                    } else if (attempts < 6) {
                        // Wait a bit for the new video to appear (first 30 seconds)
                        console.log(`[VioryDownloader] Waiting for new video to appear... (attempt ${attempts + 1})`);
                    } else {
                        // After 30 seconds, if no match found, fail fast
                        console.error(`[VioryDownloader] ✗ Target video not found in My Content after ${attempts * 5}s`);
                        throw new Error(`Target video not found in My Content. Expected keywords: [${targetKeywords.join(', ')}]. Available videos don't match.`);
                    }
                }
            } else if (contentInfo.hasAnyPreparing) {
                console.log(`[VioryDownloader] No videos ready yet, still processing... (attempt ${attempts + 1}/${maxAttempts})`);
                if (onProgress) {
                    onProgress({
                        status: 'processing',
                        message: `Video being prepared... (${attempts + 1}/${maxAttempts})`,
                        attempt: attempts + 1,
                        maxAttempts
                    });
                }
            } else {
                console.log(`[VioryDownloader] No videos found and not processing (attempt ${attempts + 1})`);
            }

            // OPTIMIZED: Adaptive polling - faster at start, slower later
            // ORIGINAL: await this.page.waitForTimeout(5000); (fixed 5s interval)
            const pollDelay = attempts < 6 ? 2500 : 4000;
            await this.page.waitForTimeout(pollDelay);
            // OPTIMIZED: Changed from networkidle to domcontentloaded
            // ORIGINAL: await this.page.reload({ waitUntil: 'networkidle' }).catch(() => {});
            await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
            await this.page.waitForTimeout(800);
            attempts++;
        }

        console.error('[VioryDownloader] ✗ Timed out waiting for matching video');
        throw new Error('Timed out waiting for matching video in My Content. The video may still be processing.');
    }

    /**
     * Close browser and save session
     */
    async close() {
        if (this.context) {
            await this.saveCookies();
        }
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            this.page = null;
        }
    }

    async minimize() {
        if (!this.page) return;
        try {
            const session = await this.context.newCDPSession(this.page);
            const { windowId } = await session.send('Browser.getWindowForTarget');
            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
        } catch (e) { console.error('Minimize failed', e); }
    }

    async maximize() {
        if (!this.page) return;
        try {
            const session = await this.context.newCDPSession(this.page);
            const { windowId } = await session.send('Browser.getWindowForTarget');
            await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'maximized' } });
        } catch (e) { console.error('Maximize failed', e); }
    }

    async show() {
        if (this.page) {
            try {
                const session = await this.context.newCDPSession(this.page);
                const { windowId } = await session.send('Browser.getWindowForTarget');
                await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
                await this.page.bringToFront();
            } catch (e) { console.error('Show failed', e); }
        }
    }
}

module.exports = { VioryDownloader };
