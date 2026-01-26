// vioryDownloader.cjs - Production-Ready Viory Downloader for Electron
// Enhanced with Gemini Vision integration for intelligent video matching
// Refactored with proven fixes: smart matching, checkbox handling, My Content fallback

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { GoogleGenerativeAI } = require('@google/generative-ai');

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
            args: [
                '--no-sandbox', 
                '--disable-setuid-sandbox', 
                '--disable-dev-shm-usage',
                '--start-minimized',
                // RAM optimization flags
                '--disable-gpu',                          // Disable GPU (not needed for scraping)
                '--disable-software-rasterizer',          // Reduce memory usage
                '--disable-extensions',                   // No extensions needed
                '--disable-background-networking',        // Reduce background activity
                '--disable-default-apps',                 // No default apps
                '--disable-sync',                         // No sync needed
                '--disable-translate',                    // No translation needed
                '--metrics-recording-only',               // Minimal metrics
                '--mute-audio',                           // No audio needed
                '--no-first-run',                         // Skip first run
                '--safebrowsing-disable-auto-update',     // No safe browsing updates
                '--js-flags=--max-old-space-size=2048'    // Limit JS heap to 2GB
            ]
        });
        console.log('[VioryDownloader] Browser launched with RAM optimization flags');

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
            // Go to videos page to check login state
            await this.page.goto('https://www.viory.video/en/videos', { waitUntil: 'domcontentloaded', timeout: 30000 });
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
                    // STEP 1: Expand "Shot list" section (required to access content)
                    const shotListExpanded = await page.evaluate(() => {
                        const allElements = document.querySelectorAll('*');
                        for (const el of allElements) {
                            if (el.childNodes.length === 1 && el.textContent.trim() === 'Shot list') {
                                // Found the header, look for the next button sibling
                                let sibling = el.nextElementSibling;
                                if (sibling && sibling.tagName === 'BUTTON') {
                                    sibling.click();
                                    return true;
                                }
                                // Or check parent's next sibling
                                const parent = el.parentElement;
                                if (parent) {
                                    sibling = parent.nextElementSibling;
                                    if (sibling && sibling.tagName === 'BUTTON') {
                                        sibling.click();
                                        return true;
                                    }
                                }
                            }
                        }
                        return false;
                    });
                    
                    if (shotListExpanded) {
                        await page.waitForTimeout(500); // Wait for expansion animation
                    }

                    // STEP 2: Extract metadata
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

                        // TITLE - from H1 with fallbacks
                        const h1 = document.querySelector('h1');
                        if (h1) result.title = h1.innerText.trim();

                        if (!result.title) {
                            const metaTitle = document.querySelector('meta[property="og:title"]');
                            if (metaTitle) result.title = metaTitle.getAttribute('content');
                        }
                        if (!result.title) {
                            result.title = document.title.replace('| Viory', '').replace('| Video Viory', '').trim();
                        }

                        // Get full page text
                        const bodyText = document.body.innerText;
                        result.allText = bodyText.substring(0, 5000);

                        // VIDEO INFO - Extract paragraphs between title and "Shot list"
                        const shotListIndex = bodyText.indexOf('Shot list');
                        if (shotListIndex !== -1) {
                            const titleIndex = bodyText.indexOf(result.title);
                            if (titleIndex !== -1) {
                                let videoInfoRaw = bodyText.substring(titleIndex + result.title.length, shotListIndex);
                                // Clean up navigation/UI text
                                videoInfoRaw = videoInfoRaw
                                    .replace(/Download video/gi, '')
                                    .replace(/Link copied!/gi, '')
                                    .replace(/Copy Link/gi, '')
                                    .replace(/\d{1,2}:\d{2}\s*(GMT|UTC)?[+-]?\d{0,4}/g, '')
                                    .trim();
                                
                                // Extract meaningful paragraphs (more than 50 chars)
                                const paragraphs = videoInfoRaw.split(/\n+/).filter(p => p.trim().length > 50);
                                result.videoInfo = paragraphs.slice(0, 6).join('\n\n').substring(0, 2000);
                            }
                        }

                        // SHOT LIST - Simple extraction between "Shot list" and "Meta data"
                        if (shotListIndex !== -1) {
                            const metaDataIndex = bodyText.indexOf('Meta data');
                            if (metaDataIndex !== -1 && metaDataIndex > shotListIndex) {
                                let shotText = bodyText.substring(shotListIndex + 9, metaDataIndex).trim();
                                // Remove any "Expand"/"Collapse" text at the start
                                shotText = shotText.replace(/^(Expand|Collapse)\s*/i, '').trim();
                                
                                if (shotText.length > 20) {
                                    result.shotList = shotText.substring(0, 2000);
                                }
                            }
                        }
                        
                        // Fallback: Look for shot type patterns if no content found
                        if (!result.shotList || result.shotList.length < 30) {
                            const patterns = [
                                /VARIOUS[,:\s]+[^\n]{10,300}/gi,
                                /SOT[,:\s]+[^\n]{10,300}/gi,
                                /[WMC]\/S[,:\s]+[^\n]{5,200}/gi
                            ];
                            for (const pattern of patterns) {
                                const matches = bodyText.match(pattern);
                                if (matches && matches.length > 0) {
                                    result.shotList = matches.join('\n').substring(0, 2000);
                                    break;
                                }
                            }
                        }

                        // MANDATORY CREDIT
                        // Extract only the credit name, not usage restrictions
                        // Examples: "World Economic Forum; News use only" → "World Economic Forum"
                        //           "World Economic Forum/News use only" → "World Economic Forum"
                        //           "Palazzo Chigi" → "Palazzo Chigi"
                        const creditMatch = bodyText.match(/[Mm]andatory\s*credit[:\s]+([^\n]+)/);
                        if (creditMatch && creditMatch[1]) {
                            let credit = creditMatch[1].trim();
                            // Remove everything after common separators (restrictions, usage info, etc.)
                            credit = credit.replace(/[;].*$/, '').trim();       // Remove after semicolon ;
                            credit = credit.replace(/\/[A-Z].*$/i, '').trim();  // Remove after /UpperCase (like /News)
                            credit = credit.replace(/\s*\/-.*$/, '').trim();    // Remove after /-
                            credit = credit.replace(/\s*\/\s*-.*$/, '').trim(); // Remove after / -
                            credit = credit.replace(/\s+-\s+.*$/, '').trim();   // Remove after " - " 
                            // Clean up any trailing punctuation or slashes
                            credit = credit.replace(/[.,;:\/]+$/, '').trim();
                            if (credit.length >= 3 && credit.length <= 100) {
                                result.mandatoryCredit = credit;
                            }
                        }

                        // DURATION - from Meta data section
                        const durationMatch = bodyText.match(/Duration[\s:]*(\d{1,2}:\d{2})/i);
                        if (durationMatch) {
                            result.duration = durationMatch[1];
                        } else {
                            const simpleDuration = bodyText.match(/\d{1,2}:\d{2}/);
                            if (simpleDuration) result.duration = simpleDuration[0];
                        }

                        // Extract description from meta
                        const metaDesc = document.querySelector('meta[name="description"]');
                        if (metaDesc) result.description = metaDesc.content;

                        return result;
                    });

                    // Calculate score
                    const score = this.calculateRelevance(finalQuery, metadata);

                    analyzedVideos.push({
                        ...candidate,
                        ...metadata,
                        score
                    });

                    // Log extracted metadata
                    console.log(`   > Score: ${score.total} | Title: "${metadata.title.substring(0, 40)}..."`);
                    console.log(`   > VideoInfo: ${metadata.videoInfo ? `${metadata.videoInfo.length} chars` : '(empty)'}`);
                    console.log(`   > ShotList: ${metadata.shotList ? `${metadata.shotList.length} chars` : '(empty)'}`);
                    if (metadata.shotList) {
                        console.log(`   > 📋 Shot preview: "${metadata.shotList.substring(0, 100)}..."`);
                    }
                    if (metadata.mandatoryCredit) {
                        console.log(`   > ✅ MandatoryCredit: "${metadata.mandatoryCredit}"`);
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
     * INTELLIGENT VIDEO SEARCH PIPELINE
     * Complete 6-stage pipeline with Gemini analysis and visual validation
     * Exact copy of test-intelligent-search.cjs logic that produced good results
     * 
     * @param {string} headline - News segment headline
     * @param {string} text - News segment text/description
     * @param {string} geminiApiKey - Gemini API key
     * @param {Object} options - Search options
     * @param {Buffer} options.segmentFrame - Optional screenshot/frame from the segment
     * @returns {Object} Best matching video with full analysis
     */
    async intelligentSearch(headline, text, geminiApiKey, options = {}) {
        const {
            maxQueries = 5,
            maxVideosToAnalyze = 5,
            topNForVisualValidation = 3,
            segmentFrame = null,  // Screenshot from the news segment
            onProgress = () => {}
        } = options;

        console.log('\n' + '='.repeat(70));
        console.log('INTELLIGENT VIDEO SEARCH PIPELINE');
        console.log('='.repeat(70));
        console.log(`Headline: "${headline}"`);

        const results = {
            analysis: null,
            videos: [],
            winner: null,
            timings: {}
        };

        const startTotal = Date.now();

        try {
            // ================================================================
            // STAGE 1: GEMINI ANALYSIS - Generate smart queries
            // ================================================================
            console.log('\n[STAGE 1] Gemini Analysis...');
            onProgress({ stage: 1, message: 'Analyzing segment with Gemini...' });
            const startStage1 = Date.now();

            const genAI = new GoogleGenerativeAI(geminiApiKey);
            // Use gemini-3-flash for text/query generation (smarter)
            const textModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
            // Use gemini-2.5-flash for vision/image analysis (optimized for images)
            const visionModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

            const analysisPrompt = `You are an expert news video researcher. Analyze this news segment to find the best matching B-roll footage.

SEGMENT TO ANALYZE:
Headline: "${headline}"
Text: "${text}"

TASK: Generate search queries that will find RELEVANT VIDEO FOOTAGE on a news video platform.

IMPORTANT RULES:
1. Focus on the MAIN VISUAL SUBJECT - what should viewers SEE in the video
2. Generate queries from MOST SPECIFIC to MOST GENERIC
3. Each query should be 1-3 words (platform search works better with short queries)
4. Include the country name in relevant queries

PERSON DETECTION - CRITICAL:
- Identify if there is an IMPORTANT PERSON mentioned (politician, leader, celebrity, executive, etc.)
- If a specific person is mentioned by name, they should appear in the B-roll footage
- Set "has_important_person" to true if footage MUST show a specific person
- Set "person_name" to the full name of the person who must appear
- Set "person_description" to describe how they look or their role (e.g., "older man with white hair", "female politician")

OUTPUT JSON ONLY:
{
  "main_subject": "What the video should primarily show",
  "country": "Primary country involved",
  "has_important_person": true/false,
  "person_name": "Full name of person who must appear (or null)",
  "person_description": "Description of the person's appearance/role (or null)",
  "key_visuals": ["visual1", "visual2", "visual3"],
  "must_show": ["essential element 1", "essential element 2"],
  "avoid": ["what would be wrong"],
  "queries": ["query1", "query2", "query3", "query4", "query5", "query6", "query7", "query8"]
}`;

            const analysisResult = await textModel.generateContent(analysisPrompt);
            const analysisText = analysisResult.response.text().replace(/```json\n?|```/g, '').trim();
            const analysis = JSON.parse(analysisText);
            results.analysis = analysis;

            results.timings.stage1 = Date.now() - startStage1;
            console.log(`   Main Subject: ${analysis.main_subject}`);
            console.log(`   Country: ${analysis.country}`);
            console.log(`   Key Visuals: ${analysis.key_visuals?.join(', ')}`);
            console.log(`   Must Show: ${analysis.must_show?.join(', ')}`);
            console.log(`   Queries: ${analysis.queries?.join(', ')}`);
            
            // Log person detection
            if (analysis.has_important_person) {
                console.log(`   [PERSON DETECTED] ${analysis.person_name}`);
                console.log(`   [PERSON DESCRIPTION] ${analysis.person_description}`);
            } else {
                console.log(`   [NO SPECIFIC PERSON] Looking for general footage`);
            }
            console.log(`   Time: ${results.timings.stage1}ms`);

            // Send detailed AI analysis to UI with person detection info
            const personInfo = analysis.has_important_person 
                ? `[PERSONA: ${analysis.person_name}] ` 
                : '[FOOTAGE GENERAL] ';
            
            onProgress({ 
                stage: 1, 
                message: `${personInfo}Subject: "${analysis.main_subject}" | Looking for: ${analysis.key_visuals?.slice(0, 2).join(', ')}`,
                analysis: analysis,
                personDetected: analysis.has_important_person,
                personName: analysis.person_name,
                personDescription: analysis.person_description
            });

            // ================================================================
            // STAGE 1.5: PERSON IDENTIFICATION IN SEGMENT FRAME (if provided)
            // Simple check: Is this [person_name]? Yes/No
            // ================================================================
            let segmentPersonConfirmed = null;  // null = no frame, true = person confirmed, false = not that person or no person
            
            if (segmentFrame && analysis.has_important_person && analysis.person_name) {
                console.log('\n[STAGE 1.5] Person Identification in Segment...');
                console.log(`   Checking if segment shows: ${analysis.person_name}`);
                onProgress({ stage: 1.5, message: `Verificando si el segmento muestra a ${analysis.person_name}...` });
                const startStage15 = Date.now();
                
                try {
                    // Simple direct question: Is this person X?
                    const identifyPrompt = `Look at this image. Is the person shown "${analysis.person_name}"?

Answer with JSON only:
{
  "is_this_person": true/false,
  "confidence": 0.0-1.0,
  "who_is_shown": "Name of person if you can identify them, or 'unknown'"
}`;

                    const identifyResult = await visionModel.generateContent([
                        { inlineData: { mimeType: 'image/png', data: segmentFrame.toString('base64') } },
                        identifyPrompt
                    ]);

                    const identifyText = identifyResult.response.text().replace(/```json\n?|```/g, '').trim();
                    const identification = JSON.parse(identifyText);
                    
                    segmentPersonConfirmed = identification.is_this_person === true && identification.confidence >= 0.7;
                    
                    results.segmentPersonCheck = {
                        expectedPerson: analysis.person_name,
                        isConfirmed: segmentPersonConfirmed,
                        confidence: identification.confidence,
                        actualPerson: identification.who_is_shown
                    };

                    results.timings.stage15 = Date.now() - startStage15;
                    
                    // Log result
                    if (segmentPersonConfirmed) {
                        console.log(`   [CONFIRMADO] El segmento muestra a ${analysis.person_name} (${(identification.confidence * 100).toFixed(0)}% seguro)`);
                    } else {
                        console.log(`   [NO CONFIRMADO] No es ${analysis.person_name}. Detectado: ${identification.who_is_shown}`);
                    }
                    console.log(`   Time: ${results.timings.stage15}ms`);

                    // Send to UI
                    onProgress({ 
                        stage: 1.5, 
                        message: segmentPersonConfirmed 
                            ? `[CONFIRMADO] Segmento muestra a ${analysis.person_name} - B-roll debe mostrar la misma persona`
                            : `[INFO] Persona en segmento: ${identification.who_is_shown || 'no identificada'}`,
                        personConfirmed: segmentPersonConfirmed,
                        expectedPerson: analysis.person_name,
                        detectedPerson: identification.who_is_shown,
                        confidence: identification.confidence
                    });

                } catch (error) {
                    console.error(`   Person identification failed: ${error.message}`);
                    onProgress({ 
                        stage: 1.5, 
                        message: `Identificacion fallida: ${error.message?.substring(0, 50)}`,
                        error: true
                    });
                }
            } else if (segmentFrame) {
                console.log('\n[STAGE 1.5] Skipped - No specific person to verify');
                onProgress({ stage: 1.5, message: 'No hay persona especifica que verificar - usando matching de footage' });
            } else {
                console.log('\n[STAGE 1.5] Skipped - No segment frame provided');
                onProgress({ stage: 1.5, message: 'Sin frame del segmento - usando solo analisis de texto' });
            }

            // Store for use in Stage 5
            results.segmentPersonConfirmed = segmentPersonConfirmed;

            // ================================================================
            // STAGE 2: VIORY SEARCH - Search with generated queries
            // ================================================================
            console.log('\n[STAGE 2] Viory Search...');
            const startStage2 = Date.now();

            const page = await this.ensurePage();
            const allVideos = [];
            const seenUrls = new Set();
            const country = (analysis.country || '').toLowerCase();
            const queriesToUse = analysis.queries.slice(0, maxQueries);
            
            onProgress({ stage: 2, message: `Searching with ${queriesToUse.length} queries...` });

            // Track which query index each video came from (lower = more specific = higher priority)
            let queryIndex = 0;
            
            for (const query of queriesToUse) {
                console.log(`   Searching: "${query}"`);
                onProgress({ stage: 2, message: `Searching: "${query}"` });

                try {
                    const searchUrl = `https://www.viory.video/en/videos?search=${encodeURIComponent(query)}`;
                    console.log(`      URL: ${searchUrl}`);
                    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });
                    console.log(`      Page loaded`);

                    try {
                        await page.waitForSelector('a[href*="/videos/"]', { timeout: 8000 });
                        console.log(`      Found video links`);
                    } catch (e) {
                        console.log(`      No results for "${query}" (selector timeout)`);
                        const pageContent = await page.evaluate(() => document.body.innerText.substring(0, 500));
                        console.log(`      Page content preview: ${pageContent.substring(0, 200)}...`);
                        queryIndex++;
                        continue;
                    }

                    await page.waitForTimeout(500);

                    // Get results with titles
                    const searchResults = await page.evaluate(() => {
                        const videos = [];
                        const links = document.querySelectorAll('a[href*="/videos/"]');
                        
                        links.forEach(link => {
                            const href = link.getAttribute('href');
                            if (!href || href.endsWith('/videos') || href.endsWith('/videos/') || href.includes('?')) return;
                            
                            const container = link.closest('article, [class*="card"], div');
                            let title = '';
                            const h2 = container?.querySelector('h2, h3');
                            if (h2) title = h2.innerText.trim();
                            if (!title) title = link.innerText.trim().split('\n')[0];
                            
                            const fullUrl = href.startsWith('http') ? href : `https://www.viory.video${href}`;
                            
                            if (title && !videos.some(v => v.url === fullUrl)) {
                                videos.push({ url: fullUrl, title: title.substring(0, 200) });
                            }
                        });
                        
                        return videos.slice(0, 8);
                    });

                    console.log(`      Found ${searchResults.length} results`);
                    
                    // Debug: show first few results
                    if (searchResults.length > 0) {
                        console.log(`      First results: ${searchResults.slice(0, 3).map(v => v.title.substring(0, 40)).join(', ')}`);
                    }

                    // ADD ALL RESULTS - no filtering here, let text scoring decide
                    // But mark with queryIndex for priority (first query = most specific)
                    for (const video of searchResults) {
                        if (!seenUrls.has(video.url)) {
                            seenUrls.add(video.url);
                            allVideos.push({ 
                                ...video, 
                                sourceQuery: query,
                                queryPriority: queryIndex  // 0 = first query = highest priority
                            });
                        }
                    }
                } catch (error) {
                    console.error(`      Search error: ${error.message}`);
                }
                queryIndex++;
            }
            
            // SORT BY QUERY PRIORITY - videos from first (most specific) query come first
            allVideos.sort((a, b) => a.queryPriority - b.queryPriority);
            console.log(`   Sorted ${allVideos.length} videos by query priority`);

            results.timings.stage2 = Date.now() - startStage2;
            console.log(`   Total unique videos: ${allVideos.length}`);
            console.log(`   Time: ${results.timings.stage2}ms`);

            if (allVideos.length === 0) {
                console.log('   No videos found!');
                return results;
            }

            // ================================================================
            // STAGE 3: DEEP VIDEO ANALYSIS - Extract metadata + screenshots
            // ================================================================
            console.log('\n[STAGE 3] Deep Video Analysis...');
            onProgress({ stage: 3, message: `Extracting metadata from ${Math.min(allVideos.length, maxVideosToAnalyze)} videos...` });
            const startStage3 = Date.now();

            const videosToAnalyze = allVideos.slice(0, maxVideosToAnalyze);

            for (let i = 0; i < videosToAnalyze.length; i++) {
                const video = videosToAnalyze[i];
                const shortTitle = (video.title || '').substring(0, 40);
                console.log(`   [${i + 1}/${videosToAnalyze.length}] ${shortTitle}...`);
                onProgress({ 
                    stage: 3, 
                    message: `[${i + 1}/${videosToAnalyze.length}] Extracting: "${shortTitle}..."`,
                    current: i + 1,
                    total: videosToAnalyze.length
                });

                try {
                    await page.goto(video.url, { waitUntil: 'networkidle', timeout: 25000 });
                    await page.waitForSelector('h1', { timeout: 5000 }).catch(() => {});
                    await page.waitForTimeout(800);

                    // Expand Shot list section
                    const shotListExpanded = await page.evaluate(() => {
                        const allElements = document.querySelectorAll('*');
                        for (const el of allElements) {
                            if (el.childNodes.length === 1 && el.textContent.trim() === 'Shot list') {
                                let sibling = el.nextElementSibling;
                                if (sibling && sibling.tagName === 'BUTTON') {
                                    sibling.click();
                                    return true;
                                }
                                const parent = el.parentElement;
                                if (parent) {
                                    sibling = parent.nextElementSibling;
                                    if (sibling && sibling.tagName === 'BUTTON') {
                                        sibling.click();
                                        return true;
                                    }
                                }
                            }
                        }
                        return false;
                    });
                    
                    if (shotListExpanded) {
                        console.log(`      Shot list expanded`);
                        await page.waitForTimeout(500);
                    }

                    // Extract metadata - EXACT COPY FROM TEST
                    const metadata = await page.evaluate(() => {
                        const result = {
                            title: '',
                            videoInfo: '',
                            shotList: '',
                            mandatoryCredit: '',
                            duration: '',
                            allText: ''
                        };

                        // TITLE
                        const h1 = document.querySelector('h1');
                        if (h1) result.title = h1.innerText.trim();
                        if (!result.title) {
                            const ogTitle = document.querySelector('meta[property="og:title"]');
                            if (ogTitle) result.title = ogTitle.getAttribute('content');
                        }
                        if (!result.title) {
                            result.title = document.title.replace(/\s*\|.*$/, '').trim();
                        }

                        // Get full page text
                        const bodyText = document.body.innerText;
                        result.allText = bodyText.substring(0, 8000);

                        // VIDEO INFO
                        const titleEndIndex = bodyText.indexOf(result.title) + result.title.length;
                        const shotListIndex = bodyText.indexOf('Shot list');
                        
                        if (titleEndIndex > 0) {
                            let infoEndIndex = shotListIndex > titleEndIndex ? shotListIndex : bodyText.length;
                            infoEndIndex = Math.min(infoEndIndex, titleEndIndex + 4000);
                            
                            let videoInfoRaw = bodyText.substring(titleEndIndex, infoEndIndex);
                            videoInfoRaw = videoInfoRaw
                                .replace(/^[\s\S]*?(Videos|Download video)[\s\n]*/i, '')
                                .replace(/\d{1,2}:\d{2}\s*(GMT|UTC)?[+-]?\d{0,4}/g, '')
                                .replace(/^(En|Videos|Live events|Pricing|About|Search)[\s\n]*/gm, '')
                                .replace(/FOR SUBSCRIBERS ONLY/gi, '')
                                .trim();
                            
                            const sentences = videoInfoRaw.split(/\n+/).filter(s => {
                                const trimmed = s.trim();
                                return trimmed.length > 50 && 
                                       !trimmed.startsWith('©') &&
                                       !trimmed.includes('cookie') &&
                                       !trimmed.includes('Terms of');
                            });
                            
                            result.videoInfo = sentences.slice(0, 6).join('\n\n').substring(0, 2500);
                        }

                        // SHOT LIST - between "Shot list" and "Meta data"
                        if (shotListIndex !== -1) {
                            const metaDataIndex = bodyText.indexOf('Meta data');
                            if (metaDataIndex !== -1 && metaDataIndex > shotListIndex) {
                                let shotText = bodyText.substring(shotListIndex + 9, metaDataIndex).trim();
                                shotText = shotText.replace(/^(Expand|Collapse)\s*/i, '').trim();
                                if (shotText.length > 20) {
                                    result.shotList = shotText.substring(0, 2000);
                                }
                            }
                        }

                        // DURATION
                        const durMatch = bodyText.match(/Duration[\s:]*(\d{1,2}:\d{2})/i);
                        if (durMatch) result.duration = durMatch[1];

                        // MANDATORY CREDIT
                        // Extract only the credit name, not usage restrictions
                        const creditMatch = bodyText.match(/[Mm]andatory\s*credit[:\s]+([^\n]+)/);
                        if (creditMatch && creditMatch[1]) {
                            let credit = creditMatch[1].trim();
                            // Remove everything after common separators
                            credit = credit.replace(/[;].*$/, '').trim();
                            credit = credit.replace(/\/[A-Z].*$/i, '').trim();
                            credit = credit.replace(/\s*\/-.*$/, '').trim();
                            credit = credit.replace(/\s*\/\s*-.*$/, '').trim();
                            credit = credit.replace(/\s+-\s+.*$/, '').trim();
                            credit = credit.replace(/[.,;:\/]+$/, '').trim();
                            if (credit.length >= 3 && credit.length <= 100) {
                                result.mandatoryCredit = credit;
                            }
                        }

                        return result;
                    });

                    Object.assign(video, metadata);

                    // Capture screenshot
                    try {
                        const videoArea = await page.$('video, [class*="player"], [class*="video-container"], main img');
                        if (videoArea) {
                            const box = await videoArea.boundingBox();
                            if (box && box.width > 200) {
                                video.screenshot = await videoArea.screenshot({ type: 'png' });
                            }
                        }
                        if (!video.screenshot) {
                            video.screenshot = await page.screenshot({
                                type: 'png',
                                clip: { x: 300, y: 80, width: 900, height: 500 }
                            });
                        }
                        console.log(`      Screenshot captured`);
                    } catch (e) {
                        console.log(`      Screenshot failed`);
                    }

                    console.log(`      VideoInfo: ${video.videoInfo ? `${video.videoInfo.length} chars` : 'empty'}`);
                    console.log(`      ShotList: ${video.shotList ? `${video.shotList.length} chars` : 'empty'}`);
                    if (video.shotList) {
                        console.log(`      Shot preview: "${video.shotList.substring(0, 100)}..."`);
                    }

                } catch (error) {
                    console.error(`      Error: ${error.message}`);
                }
            }

            results.timings.stage3 = Date.now() - startStage3;
            console.log(`   Time: ${results.timings.stage3}ms`);

            // ================================================================
            // STAGE 4: TEXT SCORING - EXACT COPY FROM TEST
            // ================================================================
            console.log('\n[STAGE 4] Text Scoring...');
            onProgress({ stage: 4, message: `Scoring ${videosToAnalyze.length} videos by text relevance...` });
            const startStage4 = Date.now();

            for (const video of videosToAnalyze) {
                let score = 0;
                const content = (
                    (video.title || '') + ' ' +
                    (video.videoInfo || '') + ' ' +
                    (video.shotList || '') + ' ' +
                    (video.allText || '')
                ).toLowerCase();

                const titleLower = (video.title || '').toLowerCase();

                // ============================================
                // FOOTAGE/CONTEXT MATCHING (when no specific person)
                // ============================================
                
                // MAIN SUBJECT MATCH - Most important for footage
                if (analysis.main_subject && !analysis.has_important_person) {
                    const subjectWords = analysis.main_subject.toLowerCase().split(' ').filter(w => w.length > 3);
                    let subjectMatches = 0;
                    subjectWords.forEach(word => {
                        if (content.includes(word)) subjectMatches++;
                    });
                    if (subjectMatches >= 3) {
                        score += 40; // Strong subject match
                        console.log(`      [TEMA FUERTE] ${subjectMatches} palabras del tema encontradas`);
                    } else if (subjectMatches >= 2) {
                        score += 25;
                        console.log(`      [TEMA PARCIAL] ${subjectMatches} palabras del tema encontradas`);
                    } else if (subjectMatches >= 1) {
                        score += 10;
                    }
                }

                // Country match (important)
                if (country && content.includes(country)) {
                    score += 20;
                    if (titleLower.includes(country)) score += 10;
                    console.log(`      [PAIS] "${country}" encontrado`);
                }

                // Key visuals match - MORE WEIGHT for footage
                let keyVisualsMatched = 0;
                (analysis.key_visuals || []).forEach(visual => {
                    const visualLower = visual.toLowerCase();
                    if (content.includes(visualLower)) {
                        score += 20; // Increased from 15
                        keyVisualsMatched++;
                    }
                    // Also check individual words for compound visuals like "military convoy"
                    const visualWords = visualLower.split(' ').filter(w => w.length > 3);
                    visualWords.forEach(word => {
                        if (content.includes(word) && !content.includes(visualLower)) {
                            score += 8;
                        }
                    });
                });
                if (keyVisualsMatched > 0) {
                    console.log(`      [VISUAL] ${keyVisualsMatched} key_visuals encontrados`);
                }

                // Must show match - CRITICAL for footage context
                let mustShowMatched = 0;
                (analysis.must_show || []).forEach(item => {
                    const itemLower = item.toLowerCase();
                    if (content.includes(itemLower)) {
                        score += 30; // Full phrase match - very important
                        mustShowMatched++;
                    } else {
                        const words = itemLower.split(' ').filter(w => w.length > 3);
                        const matchedWords = words.filter(w => content.includes(w));
                        if (matchedWords.length >= 2) {
                            score += 20;
                            mustShowMatched++;
                        } else if (matchedWords.length === 1) {
                            score += 10;
                        }
                    }
                });
                if (mustShowMatched > 0) {
                    console.log(`      [MUST_SHOW] ${mustShowMatched} elementos requeridos encontrados`);
                }

                // Context-specific keywords (expanded beyond military)
                const contextKeywords = {
                    military: ['missile', 'drone', 'convoy', 'military', 'irgc', 'weapon', 'armed', 'forces', 'tank', 'soldier', 'troops', 'artillery', 'bombing', 'strike', 'attack', 'defense'],
                    disaster: ['earthquake', 'flood', 'tsunami', 'hurricane', 'tornado', 'wildfire', 'fire', 'rescue', 'survivors', 'debris', 'destruction', 'damage', 'emergency'],
                    protest: ['protest', 'demonstration', 'rally', 'march', 'riot', 'clash', 'police', 'tear gas', 'crowd', 'banner', 'activists'],
                    economy: ['trade', 'tariff', 'economy', 'market', 'stock', 'inflation', 'gdp', 'export', 'import', 'deal', 'agreement', 'summit'],
                    politics: ['election', 'vote', 'parliament', 'congress', 'senate', 'minister', 'president', 'government', 'policy', 'law', 'bill']
                };
                
                // Check all context categories
                let contextBonus = 0;
                Object.values(contextKeywords).flat().forEach(kw => {
                    if (content.includes(kw) && analysis.main_subject?.toLowerCase().includes(kw)) {
                        contextBonus += 5; // Bonus only if keyword is relevant to the topic
                    }
                });
                if (contextBonus > 0) {
                    score += Math.min(contextBonus, 25); // Cap at 25
                }

                // Penalty for wrong content - only if clearly different topic
                const wrongContent = ['zelensky', 'ukraine', 'russia', 'putin', 'biden', 'trump', 'gaza', 'israel', 'iran', 'china'];
                wrongContent.forEach(wrong => {
                    if (titleLower.includes(wrong) && !analysis.main_subject?.toLowerCase().includes(wrong) && !content.includes(analysis.main_subject?.toLowerCase().split(' ')[0] || '')) {
                        score -= 25;
                        console.log(`      [PENALIDAD] "${wrong}" en titulo pero no relacionado al tema`);
                    }
                });

                // PERSON NAME MATCH - If segment mentions a person, check if video has that person
                let personMatchInText = false;
                if (analysis.has_important_person && analysis.person_name) {
                    const personNameLower = analysis.person_name.toLowerCase();
                    const nameParts = personNameLower.split(' ').filter(p => p.length >= 2); // Allow 2+ chars (for "He")
                    
                    // Check for FULL name match first (highest priority)
                    if (content.includes(personNameLower)) {
                        score += 60; // HUGE bonus for full name match
                        personMatchInText = true;
                        console.log(`      [PERSONA EXACTA] "${analysis.person_name}" encontrado completo`);
                    } 
                    // Check for surname/lastname match (usually last part of name)
                    else if (nameParts.length > 1) {
                        const lastName = nameParts[nameParts.length - 1]; // Last part is usually surname
                        if (lastName.length >= 3 && content.includes(lastName)) {
                            score += 50; // Big bonus for surname match
                            personMatchInText = true;
                            console.log(`      [PERSONA APELLIDO] "${lastName}" encontrado en video`);
                        }
                    }
                    // Check for any significant name part
                    else {
                        const significantPart = nameParts.find(p => p.length >= 3 && content.includes(p));
                        if (significantPart) {
                            score += 40;
                            personMatchInText = true;
                            console.log(`      [PERSONA PARCIAL] "${significantPart}" encontrado en video`);
                        }
                    }
                    
                    // PENALTY if looking for specific person but video doesn't have them
                    if (!personMatchInText) {
                        score -= 20; // Penalty for missing the required person
                        console.log(`      [SIN PERSONA] "${analysis.person_name}" NO encontrado - penalidad`);
                    }
                }

                video.textScore = { score: Math.max(0, Math.min(100, score)), personMatchInText };
                console.log(`   Score ${video.textScore.score}${personMatchInText ? ' [PERSONA]' : ''}: "${video.title.substring(0, 50)}..."`);
            }

            // Sort by text score
            videosToAnalyze.sort((a, b) => b.textScore.score - a.textScore.score);

            results.timings.stage4 = Date.now() - startStage4;
            console.log(`   Time: ${results.timings.stage4}ms`);

            // Send top 3 scores to UI
            const top3 = videosToAnalyze.slice(0, 3);
            onProgress({ 
                stage: 4, 
                message: `Top scores: ${top3.map(v => v.textScore.score).join(', ')} | Best: "${(top3[0]?.title || '').substring(0, 35)}..."`,
                topScores: top3.map(v => ({ title: v.title?.substring(0, 30), score: v.textScore.score }))
            });

            // ================================================================
            // STAGE 5: VISUAL VALIDATION with Gemini Vision
            // SIMPLIFIED: Direct person check or footage relevance
            // ================================================================
            console.log('\n[STAGE 5] Visual Validation with Gemini Vision...');
            
            // Check if we need to match a specific person (confirmed in segment)
            const requiresPersonMatch = results.segmentPersonConfirmed === true && analysis.person_name;
            const personToMatch = analysis.person_name;
            
            if (requiresPersonMatch) {
                console.log(`   [MODO PERSONA] Buscando videos que muestren a: ${personToMatch}`);
            } else {
                console.log(`   [MODO FOOTAGE] Buscando videos relevantes al tema`);
            }
            
            onProgress({ 
                stage: 5, 
                message: requiresPersonMatch 
                    ? `Buscando B-roll con ${personToMatch}...`
                    : `Analizando ${topNForVisualValidation} videos por relevancia...`,
                matchMode: requiresPersonMatch ? 'person' : 'footage',
                personToMatch: personToMatch
            });
            const startStage5 = Date.now();

            const topVideos = videosToAnalyze.slice(0, topNForVisualValidation);
            let analyzedCount = 0;

            for (let vi = 0; vi < topVideos.length; vi++) {
                const video = topVideos[vi];
                
                if (!video.screenshot) {
                    video.visualAnalysis = { success: false };
                    onProgress({ 
                        stage: 5, 
                        message: `[${vi + 1}/${topVideos.length}] Sin screenshot`,
                        videoTitle: video.title?.substring(0, 30)
                    });
                    continue;
                }

                const shortTitle = (video.title || '').substring(0, 35);
                console.log(`   Validating: ${shortTitle}...`);
                onProgress({ 
                    stage: 5, 
                    message: `[${vi + 1}/${topVideos.length}] ${requiresPersonMatch ? `Buscando a ${personToMatch}` : 'Verificando relevancia'}...`,
                    videoTitle: shortTitle,
                    current: vi + 1,
                    total: topVideos.length
                });

                try {
                    let visionPrompt;
                    
                    if (requiresPersonMatch) {
                        // SIMPLE DIRECT QUESTION: Is this person in the video?
                        visionPrompt = `Look at this video screenshot.

QUESTION: Does this video show "${personToMatch}"?

Video title: ${video.title}
Video description: ${(video.videoInfo || '').substring(0, 200)}

Answer with JSON only:
{
  "shows_person": true/false,
  "person_identified": "Name of person you see (or 'unknown' or 'no person visible')",
  "confidence": 0.0-1.0,
  "relevance_score": 0-100
}

SCORING:
- If you clearly see ${personToMatch} → relevance_score: 90-100
- If you see someone who might be ${personToMatch} → relevance_score: 70-89
- If you see a different person → relevance_score: 20-40
- If no person visible but related content → relevance_score: 40-60`;
                    } else {
                        // FOOTAGE RELEVANCE CHECK - More detailed and context-aware
                        visionPrompt = `You are an expert news B-roll matcher. Analyze if this video is relevant for the news topic.

NEWS TOPIC: ${analysis.main_subject}
COUNTRY/REGION: ${analysis.country || 'Not specified'}
KEY VISUALS NEEDED: ${analysis.key_visuals?.join(', ') || 'General footage'}
MUST SHOW: ${analysis.must_show?.join(', ') || 'Related content'}
AVOID: ${analysis.avoid?.join(', ') || 'Nothing specific'}

VIDEO BEING EVALUATED:
Title: ${video.title}
Description: ${(video.videoInfo || '').substring(0, 400)}
Shot list: ${(video.shotList || '').substring(0, 300)}

SCORING GUIDE FOR B-ROLL FOOTAGE:
- 85-100: PERFECT MATCH - Shows exactly what the news topic is about (same event, same location, same context)
- 70-84: STRONG MATCH - Shows very related content (same type of event, same country, similar context)
- 55-69: MODERATE MATCH - Shows somewhat related content (same general topic or region)
- 40-54: WEAK MATCH - Only loosely connected (same broad category)
- 0-39: NO MATCH - Different topic, wrong country, or unrelated content

IMPORTANT CONTEXT RULES:
- Military footage (strikes, convoys, weapons) → must match the SPECIFIC conflict/country
- Disaster footage (earthquake, flood) → must match the SPECIFIC event/location
- Political footage (summit, speech) → must match the SPECIFIC event/participants
- Protest footage → must match the SPECIFIC cause/location
- Economic news → can be more flexible with stock footage of markets, trade, etc.

Answer with JSON only:
{
  "shows_relevant_content": true/false,
  "detected_elements": ["element1", "element2", "element3"],
  "context_match": "exact/related/loose/none",
  "country_match": true/false,
  "relevance_score": 0-100,
  "recommendation": "ACCEPT/REVIEW/REJECT",
  "reason": "Brief explanation of why this footage matches or doesn't match"
}`;
                    }

                    const visionResult = await visionModel.generateContent([
                        { inlineData: { mimeType: 'image/png', data: video.screenshot.toString('base64') } },
                        visionPrompt
                    ]);

                    const visionText = visionResult.response.text().replace(/```json\n?|```/g, '').trim();
                    
                    // Parse JSON with error handling
                    let visual;
                    try {
                        visual = JSON.parse(visionText);
                    } catch (parseError) {
                        console.error(`      JSON parse error: ${parseError.message}`);
                        console.error(`      Raw response: ${visionText.substring(0, 200)}...`);
                        // Create default response
                        visual = {
                            shows_relevant_content: false,
                            relevance_score: 30,
                            recommendation: 'REVIEW',
                            reason: 'Could not parse vision response'
                        };
                    }
                    
                    // Process results based on mode
                    if (requiresPersonMatch) {
                        // Person matching mode
                        const isPersonMatch = visual.shows_person === true && 
                            (visual.person_identified?.toLowerCase().includes(personToMatch.toLowerCase().split(' ')[0]) || 
                             visual.confidence >= 0.8);
                        
                        if (isPersonMatch) {
                            visual.relevance_score = Math.max(visual.relevance_score, 90);
                            visual.recommendation = 'ACCEPT';
                            visual.person_match = true;
                            console.log(`      [PERSONA ENCONTRADA] ${visual.person_identified} (${(visual.confidence * 100).toFixed(0)}%)`);
                        } else if (visual.shows_person && visual.confidence >= 0.5) {
                            visual.recommendation = 'REVIEW';
                            visual.person_match = 'possible';
                            console.log(`      [POSIBLE] ${visual.person_identified} (${(visual.confidence * 100).toFixed(0)}%)`);
                        } else {
                            visual.relevance_score = Math.min(visual.relevance_score, 40);
                            visual.recommendation = 'REJECT';
                            visual.person_match = false;
                            console.log(`      [NO ES ${personToMatch}] Detectado: ${visual.person_identified}`);
                        }
                        
                        visual.person_detected = visual.person_identified;
                    } else {
                        // FOOTAGE MODE - Consider context_match and country_match
                        const contextMatch = visual.context_match || 'none';
                        const countryMatch = visual.country_match !== false;
                        
                        // Adjust score based on context
                        if (contextMatch === 'exact' && countryMatch) {
                            visual.relevance_score = Math.max(visual.relevance_score, 85);
                            console.log(`      [CONTEXTO EXACTO] País correcto`);
                        } else if (contextMatch === 'related' && countryMatch) {
                            visual.relevance_score = Math.max(visual.relevance_score, 70);
                            console.log(`      [CONTEXTO RELACIONADO] País correcto`);
                        } else if (!countryMatch && visual.relevance_score > 60) {
                            visual.relevance_score = Math.min(visual.relevance_score, 55);
                            console.log(`      [PAIS INCORRECTO] Score reducido`);
                        }
                        
                        // Set recommendation based on adjusted score
                        if (visual.relevance_score >= 75) {
                            visual.recommendation = 'ACCEPT';
                        } else if (visual.relevance_score >= 55) {
                            visual.recommendation = 'REVIEW';
                        } else {
                            visual.recommendation = 'REJECT';
                        }
                        
                        console.log(`      Context: ${contextMatch}, Country: ${countryMatch}`);
                    }
                    
                    video.visualAnalysis = { 
                        success: true, 
                        ...visual,
                        matchMode: requiresPersonMatch ? 'person' : 'footage'
                    };
                    analyzedCount++;

                    console.log(`      Score: ${visual.relevance_score}`);
                    console.log(`      Recommendation: ${visual.recommendation}`);

                    // Send to UI
                    const matchInfo = requiresPersonMatch 
                        ? `${visual.person_match === true ? 'SI' : visual.person_match === 'possible' ? 'POSIBLE' : 'NO'} - ${visual.person_detected || 'N/A'}`
                        : `${visual.relevance_score}%`;
                    
                    onProgress({ 
                        stage: 5, 
                        message: `[${vi + 1}/${topVideos.length}] ${visual.recommendation}: ${requiresPersonMatch ? `Persona: ${matchInfo}` : `Relevancia: ${matchInfo}`}`,
                        videoTitle: shortTitle,
                        visualScore: visual.relevance_score,
                        recommendation: visual.recommendation,
                        personMatch: visual.person_match,
                        personDetected: visual.person_detected,
                        matchMode: requiresPersonMatch ? 'person' : 'footage'
                    });

                    await new Promise(r => setTimeout(r, 1500)); // Rate limit

                } catch (error) {
                    console.error(`      Vision error: ${error.message}`);
                    video.visualAnalysis = { success: false };
                    onProgress({ 
                        stage: 5, 
                        message: `[${vi + 1}/${topVideos.length}] Error: ${error.message?.substring(0, 30)}`,
                        error: true
                    });
                }
            }

            results.timings.stage5 = Date.now() - startStage5;
            console.log(`   Analyzed ${analyzedCount}/${topVideos.length} images in ${results.timings.stage5}ms`);
            onProgress({ 
                stage: 5, 
                message: `Visual analysis complete: ${analyzedCount}/${topVideos.length} images analyzed`,
                complete: true
            });

            // ================================================================
            // STAGE 6: FINAL RANKING
            // Now considers person/footage matching in scoring
            // ================================================================
            console.log('\n[STAGE 6] Final Ranking...');
            const rankingMode = requiresPersonMatch ? 'PERSON PRIORITY' : 'FOOTAGE PRIORITY';
            onProgress({ stage: 6, message: `Combining scores (${rankingMode}) - 60% text, 40% visual...` });
            const startStage6 = Date.now();

            const finalRanking = topVideos.map(v => {
                const textScore = v.textScore.score;
                const visualScore = v.visualAnalysis?.relevance_score || 0;
                const hasVisual = v.visualAnalysis?.success;
                
                // Base hybrid score: 60% text, 40% visual
                let finalScore = hasVisual 
                    ? Math.round(textScore * 0.6 + visualScore * 0.4)
                    : textScore;
                
                // Apply bonuses/penalties based on match mode
                let matchBonus = 0;
                let matchPenalty = 0;
                
                if (requiresPersonMatch && v.visualAnalysis) {
                    // Person matching mode: heavy bonus for person match, heavy penalty for mismatch
                    if (v.visualAnalysis.person_match === true) {
                        matchBonus = 25; // Big bonus for confirmed person match
                        console.log(`   [BONUS +25] Person match confirmed: ${v.visualAnalysis.person_detected}`);
                    } else if (v.visualAnalysis.person_match === 'possible' && v.visualAnalysis.person_confidence >= 0.6) {
                        matchBonus = 10; // Moderate bonus for possible match
                        console.log(`   [BONUS +10] Possible person match (${(v.visualAnalysis.person_confidence * 100).toFixed(0)}%)`);
                    } else if (v.visualAnalysis.person_match === false) {
                        matchPenalty = 30; // Heavy penalty for wrong person
                        console.log(`   [PENALTY -30] Person mismatch`);
                    }
                }
                
                // TEXT-BASED PERSON MATCH - person name found in video metadata
                if (v.textScore?.personMatchInText) {
                    matchBonus += 20; // Bonus for person name in text
                    console.log(`   [BONUS +20] Person name found in video text/shotlist`);
                } else if (v.visualAnalysis) {
                    // Footage matching mode: bonus for high relevance
                    const footageScore = v.visualAnalysis.relevance_score || visualScore;
                    if (footageScore >= 80) {
                        matchBonus = 15; // Bonus for strong footage match
                        console.log(`   [BONUS +15] Strong footage match (${footageScore}%)`);
                    } else if (footageScore < 60) {
                        matchPenalty = 20; // Penalty for weak footage match
                        console.log(`   [PENALTY -20] Weak footage match (${footageScore}%)`);
                    }
                }
                
                finalScore = Math.max(0, Math.min(100, finalScore + matchBonus - matchPenalty));
                
                return { 
                    ...v, 
                    finalScore, 
                    textScoreNum: textScore, 
                    visualScore: hasVisual ? visualScore : null,
                    matchBonus,
                    matchPenalty,
                    personMatch: v.visualAnalysis?.person_match,
                    personDetected: v.visualAnalysis?.person_detected,
                    sceneMatchPercentage: v.visualAnalysis?.scene_match_percentage
                };
            });

            // Sort by final score, but PRIORITIZE person matches if in person mode
            finalRanking.sort((a, b) => {
                if (requiresPersonMatch) {
                    // In person mode: true matches first, then possible, then others
                    const aMatch = a.personMatch === true ? 2 : (a.personMatch === 'possible' ? 1 : 0);
                    const bMatch = b.personMatch === true ? 2 : (b.personMatch === 'possible' ? 1 : 0);
                    if (aMatch !== bMatch) return bMatch - aMatch;
                }
                return b.finalScore - a.finalScore;
            });

            results.videos = finalRanking;

            // Send winner info to UI with person/footage match details
            const topCandidate = finalRanking[0];
            if (topCandidate) {
                const matchDetail = requiresPersonMatch 
                    ? `Person: ${topCandidate.personMatch ? 'YES' : 'NO'} (${topCandidate.personDetected || 'N/A'})`
                    : `Footage: ${topCandidate.sceneMatchPercentage || topCandidate.visualScore}%`;
                
                onProgress({ 
                    stage: 6, 
                    message: `Winner: Score ${topCandidate.finalScore} | ${matchDetail} | "${(topCandidate.title || '').substring(0, 35)}..."`,
                    winner: {
                        title: topCandidate.title?.substring(0, 50),
                        finalScore: topCandidate.finalScore,
                        textScore: topCandidate.textScoreNum,
                        visualScore: topCandidate.visualScore,
                        personMatch: topCandidate.personMatch,
                        personDetected: topCandidate.personDetected,
                        sceneMatchPercentage: topCandidate.sceneMatchPercentage,
                        matchMode: requiresPersonMatch ? 'person' : 'footage'
                    }
                });
            }
            results.winner = topCandidate || null;
            results.matchMode = requiresPersonMatch ? 'person' : 'footage';

            results.timings.stage6 = Date.now() - startStage6;
            results.timings.total = Date.now() - startTotal;

            // Log results with person/footage match info
            console.log('\n' + '='.repeat(70));
            console.log(`FINAL RESULTS (${requiresPersonMatch ? 'PERSON MODE' : 'FOOTAGE MODE'}):`);
            console.log('='.repeat(70));
            const medals = ['1st', '2nd', '3rd'];
            finalRanking.forEach((v, i) => {
                const matchInfo = requiresPersonMatch 
                    ? `Person: ${v.personMatch || 'N/A'} (${v.personDetected || 'unknown'})`
                    : `Footage: ${v.visualScore || 0}%`;
                
                console.log(`${medals[i] || '#'+(i+1)}: ${v.title}`);
                console.log(`   URL: ${v.url}`);
                console.log(`   Final Score: ${v.finalScore} (Text: ${v.textScoreNum}, Visual: ${v.visualScore ?? 'N/A'})`);
                console.log(`   Match: ${matchInfo}`);
                console.log(`   Bonuses: +${v.matchBonus || 0} / Penalties: -${v.matchPenalty || 0}`);
                console.log(`   Verdict: ${v.visualAnalysis?.recommendation || 'N/A'}`);
                if (v.shotList) {
                    console.log(`   Shot List: "${v.shotList.substring(0, 100)}..."`);
                }
                console.log('');
            });

            console.log(`Total time: ${results.timings.total}ms (${(results.timings.total/1000).toFixed(1)}s)`);

            // Recommendation with match info
            if (topCandidate && topCandidate.finalScore >= 50) {
                const matchStatus = requiresPersonMatch 
                    ? (topCandidate.personMatch ? 'PERSON MATCHED' : 'PERSON NOT CONFIRMED')
                    : `FOOTAGE ${topCandidate.sceneMatchPercentage || topCandidate.visualScore}% MATCH`;
                console.log(`\nRECOMMENDED [${matchStatus}]: "${topCandidate.title.substring(0, 50)}..."`);
            } else if (topCandidate) {
                console.log(`\nLOW CONFIDENCE: Best score ${topCandidate.finalScore} - may need manual review`);
            }

            return results;

        } catch (error) {
            console.error('Intelligent search failed:', error);
            results.error = error.message;
            return results;
        }
    }

    /**
     * INTELLIGENT SEARCH AND DOWNLOAD
     * Performs intelligent search, then attempts to download the best video.
     * 
     * STRATEGY:
     * 1. Try to download best video directly
     * 2. If requires My Content → wait up to 4 minutes
     * 3. If timeout → try next candidates (skip My Content)
     * 4. Return first successful download
     * 
     * @param {string} headline - News segment headline
     * @param {string} text - News segment text/description
     * @param {string} geminiApiKey - Gemini API key
     * @param {Object} options - Options
     * @param {Function} options.onProgress - Progress callback
     * @param {Buffer} options.segmentFrame - Optional screenshot from the segment for visual matching
     * @param {number} options.myContentWaitMinutes - Minutes to wait for My Content (default: 4)
     * @param {number} options.maxCandidatesToTry - Max candidates to try (default: 5)
     * @returns {Object} Download result with video info
     */
    async intelligentSearchAndDownload(headline, text, geminiApiKey, options = {}) {
        const {
            onProgress = () => {},
            segmentFrame = null,
            myContentWaitMinutes = 4,
            maxCandidatesToTry = 5
        } = options;

        console.log('\n' + '='.repeat(70));
        console.log('INTELLIGENT SEARCH AND DOWNLOAD');
        console.log('='.repeat(70));
        if (segmentFrame) {
            console.log('[VioryDownloader] Segment frame provided for visual matching');
        }

        // Step 1: Run intelligent search to get ranked candidates
        onProgress({ stage: 'search', message: 'Running intelligent search...' });
        const searchResults = await this.intelligentSearch(headline, text, geminiApiKey, {
            segmentFrame: segmentFrame,  // Pass the segment frame for visual analysis
            onProgress: (p) => onProgress({ stage: 'search', ...p })
        });

        if (!searchResults.videos || searchResults.videos.length === 0) {
            console.log('[VioryDownloader] No videos found in search');
            return {
                success: false,
                error: 'No videos found matching the search criteria',
                searchResults
            };
        }

        console.log(`\n[VioryDownloader] Found ${searchResults.videos.length} candidates, attempting download...`);

        const candidatesToTry = searchResults.videos.slice(0, maxCandidatesToTry);
        const skippedVideos = [];
        let firstVideoTriedMyContent = false;

        // Step 2: Try FIRST (best) video - allow My Content wait
        const bestVideo = candidatesToTry[0];
        console.log(`\n[VioryDownloader] Trying BEST candidate: "${bestVideo.title?.substring(0, 50)}..."`);
        console.log(`   URL: ${bestVideo.url}`);
        console.log(`   Score: ${bestVideo.finalScore} (Text: ${bestVideo.textScoreNum}, Visual: ${bestVideo.visualScore ?? 'N/A'})`);

        onProgress({
            stage: 'download',
            message: `Downloading best match...`,
            video: { title: bestVideo.title, url: bestVideo.url, score: bestVideo.finalScore }
        });

        try {
            // First attempt: try direct download (skipMyContent=true to detect if it needs My Content)
            const firstResult = await this.downloadVideo(
                bestVideo.url,
                (p) => onProgress({ stage: 'download', ...p }),
                { skipMyContent: true }
            );

            if (firstResult.success) {
                console.log(`\n✅ SUCCESS: Downloaded "${bestVideo.title?.substring(0, 50)}..."`);
                return this._buildSuccessResult(bestVideo, firstResult, 1, skippedVideos, searchResults);
            }

            // If needs My Content, wait for it (up to 4 minutes)
            if (firstResult.needsMyContent) {
                console.log(`\n[VioryDownloader] Best video requires My Content - waiting up to ${myContentWaitMinutes} minutes...`);
                firstVideoTriedMyContent = true;
                
                onProgress({
                    stage: 'myContent',
                    message: `Video processing, waiting up to ${myContentWaitMinutes} min...`,
                    video: { title: bestVideo.title }
                });

                const myContentResult = await this.downloadFromMyContent(
                    (p) => onProgress({ stage: 'myContent', ...p }),
                    firstResult.videoId,
                    firstResult.videoTitle,
                    { maxWaitMinutes: myContentWaitMinutes }
                );

                if (myContentResult.success) {
                    console.log(`\n✅ SUCCESS (My Content): Downloaded "${bestVideo.title?.substring(0, 50)}..."`);
                    return this._buildSuccessResult(bestVideo, myContentResult, 1, skippedVideos, searchResults);
                }

                // Timeout - add to skipped and try alternatives
                if (myContentResult.timeout) {
                    console.log(`\n⏱️ TIMEOUT: Video not ready after ${myContentWaitMinutes} minutes`);
                    skippedVideos.push({
                        url: bestVideo.url,
                        title: bestVideo.title,
                        score: bestVideo.finalScore,
                        reason: `My Content timeout (${myContentWaitMinutes} min)`
                    });
                }
            }
        } catch (error) {
            console.error(`   ❌ Error with best video: ${error.message}`);
            skippedVideos.push({
                url: bestVideo.url,
                title: bestVideo.title,
                score: bestVideo.finalScore,
                reason: error.message
            });
        }

        // Step 3: Try remaining candidates (SKIP My Content - only direct downloads)
        console.log(`\n[VioryDownloader] Trying alternative candidates (direct download only)...`);

        for (let i = 1; i < candidatesToTry.length; i++) {
            const video = candidatesToTry[i];
            
            console.log(`\n[VioryDownloader] Trying candidate ${i + 1}/${candidatesToTry.length}: "${video.title?.substring(0, 50)}..."`);
            console.log(`   URL: ${video.url}`);
            console.log(`   Score: ${video.finalScore}`);

            onProgress({
                stage: 'download',
                message: `Trying alternative ${i}/${candidatesToTry.length - 1}...`,
                video: { title: video.title, url: video.url, score: video.finalScore }
            });

            try {
                const downloadResult = await this.downloadVideo(
                    video.url,
                    (p) => onProgress({ stage: 'download', ...p }),
                    { skipMyContent: true }  // Always skip My Content for alternatives
                );

                if (downloadResult.success) {
                    console.log(`\n✅ SUCCESS (Alternative): Downloaded "${video.title?.substring(0, 50)}..."`);
                    return this._buildSuccessResult(video, downloadResult, i + 1, skippedVideos, searchResults);
                }

                if (downloadResult.needsMyContent) {
                    console.log(`   ⏭️ Skipped - requires My Content`);
                    skippedVideos.push({
                        url: video.url,
                        title: video.title,
                        score: video.finalScore,
                        reason: 'Requires My Content (skipped)'
                    });
                    continue;
                }

                skippedVideos.push({
                    url: video.url,
                    title: video.title,
                    score: video.finalScore,
                    reason: downloadResult.message || 'Download failed'
                });

            } catch (error) {
                console.error(`   ❌ Error: ${error.message}`);
                skippedVideos.push({
                    url: video.url,
                    title: video.title,
                    score: video.finalScore,
                    reason: error.message
                });
            }
        }

        // All candidates failed
        console.log('\n❌ ALL CANDIDATES FAILED');
        console.log('Skipped videos:');
        skippedVideos.forEach((v, i) => {
            console.log(`   ${i + 1}. "${v.title?.substring(0, 40)}..." - ${v.reason}`);
        });

        return {
            success: false,
            error: 'All video candidates failed to download',
            triedMyContent: firstVideoTriedMyContent,
            skippedVideos,
            searchResults
        };
    }

    /**
     * Helper to build success result object
     * @private
     */
    _buildSuccessResult(video, downloadResult, candidateNumber, skippedVideos, searchResults) {
        return {
            success: true,
            path: downloadResult.path,
            filename: downloadResult.filename,
            fromMyContent: downloadResult.fromMyContent || false,
            video: {
                url: video.url,
                title: video.title,
                finalScore: video.finalScore,
                textScore: video.textScoreNum,
                visualScore: video.visualScore,
                shotList: video.shotList,
                videoInfo: video.videoInfo,
                mandatoryCredit: video.mandatoryCredit
            },
            candidateNumber,
            skippedVideos,
            searchResults
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
     * Extract Video ID from Viory URL (e.g., "a3126_25012026" from the URL)
     */
    extractVideoId(url) {
        const match = url.match(/\/videos\/([a-zA-Z0-9_]+)\//);
        return match ? match[1] : null;
    }

    /**
     * Download a video with checkbox handling, "preparing video" detection, and My Content fallback
     * @param {string} videoUrl - Video URL to download
     * @param {Function} onProgress - Progress callback
     * @param {Object} options - Download options
     * @param {boolean} options.skipMyContent - If true, return immediately when video needs My Content (don't wait)
     * @returns {Object} Result with success, path, or needsMyContent flag
     */
    async downloadVideo(videoUrl, onProgress, options = {}) {
        const { skipMyContent = false } = options;
        console.log(`[VioryDownloader] Opening video: ${videoUrl}`);

        // Extract Video ID for exact matching in My Content
        const videoId = this.extractVideoId(videoUrl);
        console.log(`[VioryDownloader] Video ID: ${videoId}`);

        // Store video title as fallback for matching in My Content
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
                
                // If skipMyContent is true, return immediately without waiting
                if (skipMyContent) {
                    console.log('[VioryDownloader] skipMyContent=true, returning needsMyContent flag');
                    // Dismiss the modal by clicking Continue or pressing Escape
                    await this.page.evaluate(() => {
                        const btns = Array.from(document.querySelectorAll('button'));
                        const continueBtn = btns.find(b => (b.textContent || '').toLowerCase() === 'continue');
                        if (continueBtn) continueBtn.click();
                    });
                    await this.page.keyboard.press('Escape').catch(() => {});
                    await this.page.waitForTimeout(300);
                    
                    return {
                        success: false,
                        needsMyContent: true,
                        videoUrl,
                        videoId,
                        videoTitle,
                        message: 'Video requires My Content processing - skipped'
                    };
                }
                
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

                // Go to My Content and wait for the video (use Video ID for exact match)
                return await this.downloadFromMyContent(onProgress, videoId, videoTitle);
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
                // Download didn't start - check if video needs My Content
                console.log('[VioryDownloader] Direct download not started');
                
                // Check if we're in a "preparing" state we missed earlier
                const secondCheck = await this.checkForPreparingModal();
                if (secondCheck.isPreparing && skipMyContent) {
                    console.log('[VioryDownloader] Video needs My Content (detected late), skipping...');
                    return {
                        success: false,
                        needsMyContent: true,
                        videoUrl,
                        videoId,
                        videoTitle,
                        message: 'Video requires My Content processing - skipped'
                    };
                }
                
                if (skipMyContent) {
                    console.log('[VioryDownloader] skipMyContent=true, not waiting for My Content');
                    return {
                        success: false,
                        needsMyContent: true,
                        videoUrl,
                        videoId,
                        videoTitle,
                        message: 'Direct download failed, My Content would be required - skipped'
                    };
                }
                
                // Try My Content fallback
                console.log('[VioryDownloader] Checking My Content...');
                return await this.downloadFromMyContent(onProgress, videoId, videoTitle);
            }

        } catch (error) {
            console.error('[VioryDownloader] Download failed:', error.message);
            
            // If skipMyContent, don't try My Content fallback
            if (skipMyContent) {
                console.log('[VioryDownloader] skipMyContent=true, not attempting My Content fallback');
                return {
                    success: false,
                    needsMyContent: true,
                    videoUrl,
                    videoId,
                    videoTitle,
                    message: `Download failed: ${error.message} - My Content would be required`
                };
            }
            
            // Fallback to My Content
            try {
                return await this.downloadFromMyContent(onProgress, videoId, videoTitle);
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
     * Download video from My Content page (fallback when video needs preparation)
     * Uses Video ID for EXACT matching to ensure we download the correct video
     * @param {Function} onProgress - Progress callback
     * @param {string} targetVideoId - Video ID from URL (e.g., "a3126_25012026") - PRIMARY match
     * @param {string} targetVideoTitle - Video title as fallback for matching
     * @param {Object} options - Options
     * @param {number} options.maxWaitMinutes - Maximum minutes to wait (default: 4)
     * @returns {Object} Result with success flag, or timeout flag if video not ready
     */
    async downloadFromMyContent(onProgress, targetVideoId = '', targetVideoTitle = '', options = {}) {
        const { maxWaitMinutes = 4 } = options;
        
        console.log('[VioryDownloader] Navigating to My Content page...');
        console.log(`[VioryDownloader] Target Video ID: ${targetVideoId || '(none)'}`);
        console.log(`[VioryDownloader] Target Title: "${(targetVideoTitle || '').substring(0, 50)}..."`);
        console.log(`[VioryDownloader] Max wait time: ${maxWaitMinutes} minutes`);

        // Navigate to My Content page
        await this.page.goto('https://www.viory.video/en/user', {
            waitUntil: 'domcontentloaded',
            timeout: 25000
        });
        await this.page.waitForSelector('button', { timeout: 5000 }).catch(() => {});
        await this.page.waitForTimeout(2000);

        // Polling configuration - 4 minutes default (48 attempts * 5 seconds)
        const pollInterval = 5000;
        const maxAttempts = Math.ceil((maxWaitMinutes * 60 * 1000) / pollInterval);

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            console.log(`[VioryDownloader] Poll ${attempt}/${maxAttempts} - Checking My Content...`);

            // NEW APPROACH: Find the video by looking for the ID pattern and then find the nearest download button
            const videoStatus = await this.page.evaluate((videoId) => {
                const pageText = document.body.innerText;

                // Check if our Video ID exists anywhere on the page
                if (!pageText.includes(videoId)) {
                    return { found: false, reason: 'Video ID not found on page', debug: { pageLength: pageText.length } };
                }

                // Find ALL buttons on the page that contain "Download"
                const allButtons = Array.from(document.querySelectorAll('button'));
                const downloadButtons = allButtons.filter(btn => {
                    const text = (btn.textContent || '').toLowerCase();
                    return text.includes('download') && (text.includes('1080p') || text.includes('720p') || text.includes('mp4'));
                });

                // Find ALL elements that contain our video ID
                const idElements = Array.from(document.querySelectorAll('*')).filter(el => {
                    const text = el.innerText || el.textContent || '';
                    return text.includes(`ID ${videoId}`) || text.includes(`ID\n${videoId}`);
                });

                // For each ID element, find the closest download button (look at siblings and parent's children)
                let targetButton = null;
                let videoTitle = '';
                let isPreparing = false;

                for (const idEl of idElements) {
                    // Walk up to find a container that has both the ID and a button
                    let container = idEl.parentElement;
                    for (let i = 0; i < 5 && container; i++) {
                        const containerText = container.innerText || '';
                        
                        // Skip if this container is too large (the whole page)
                        if (containerText.length > 5000) {
                            container = container.parentElement;
                            continue;
                        }

                        // Check if this container has the video ID
                        if (!containerText.includes(videoId)) {
                            container = container.parentElement;
                            continue;
                        }

                        // Check for "Preparing" or "Cancel request" text (video still processing)
                        const containerLower = containerText.toLowerCase();
                        if (containerLower.includes('preparing to download') || containerLower.includes('cancel request')) {
                            isPreparing = true;
                            // Try to extract title
                            const lines = containerText.split('\n').map(l => l.trim()).filter(l => l.length > 15);
                            for (const line of lines) {
                                if (!line.includes('Download') && !line.includes('Preparing') && 
                                    !line.includes('Cancel') && !line.includes('Video') && !line.includes('ID ')) {
                                    videoTitle = line.substring(0, 100);
                                    break;
                                }
                            }
                            return { found: true, videoId, title: videoTitle, isPreparing: true, isReady: false };
                        }

                        // Look for a download button within this container
                        const btnsInContainer = container.querySelectorAll('button');
                        for (const btn of btnsInContainer) {
                            const btnText = (btn.textContent || '').toLowerCase();
                            if (btnText.includes('download') && (btnText.includes('1080p') || btnText.includes('720p') || btnText.includes('mp4'))) {
                                targetButton = btn;
                                
                                // Extract title from the container
                                const lines = containerText.split('\n').map(l => l.trim()).filter(l => l.length > 15);
                                for (const line of lines) {
                                    if (!line.includes('Download') && !line.includes('Preparing') && 
                                        !line.includes('Cancel') && !line.includes('Video') && !line.includes('ID ')) {
                                        videoTitle = line.substring(0, 100);
                                        break;
                                    }
                                }
                                break;
                            }
                        }

                        if (targetButton) break;
                        container = container.parentElement;
                    }

                    if (targetButton) break;
                }

                if (isPreparing) {
                    return { found: true, videoId, title: videoTitle, isPreparing: true, isReady: false };
                }

                if (!targetButton) {
                    // Check if video exists but in "Access history" section (already downloaded before)
                    const hasAccessHistory = pageText.includes('Access history');
                    return { 
                        found: false, 
                        reason: 'Could not find download button for this video ID', 
                        debug: { 
                            downloadButtonsFound: downloadButtons.length,
                            idElementsFound: idElements.length,
                            hasAccessHistory
                        }
                    };
                }

                return {
                    found: true,
                    videoId: videoId,
                    title: videoTitle,
                    isPreparing: false,
                    isReady: true,
                    buttonText: targetButton.textContent?.trim() || 'Download'
                };
            }, targetVideoId);

            // Log status with debug info
            if (!videoStatus.found) {
                console.log(`[VioryDownloader] ${videoStatus.reason}`);
                if (videoStatus.debug) {
                    console.log(`[VioryDownloader] Debug: ${JSON.stringify(videoStatus.debug)}`);
                }
            } else {
                const status = videoStatus.isReady ? 'READY' : (videoStatus.isPreparing ? 'PREPARING' : 'UNKNOWN');
                console.log(`[VioryDownloader] Video "${(videoStatus.title || '').substring(0, 40)}..." - Status: ${status}`);
                if (videoStatus.buttonText) {
                    console.log(`[VioryDownloader] Found button: "${videoStatus.buttonText}"`);
                }
            }

            // If video is READY, download it
            if (videoStatus.found && videoStatus.isReady) {
                console.log(`[VioryDownloader] Video is ready! Starting download...`);
                if (onProgress) onProgress({ status: 'downloading', message: 'Downloading from My Content...' });

                // Set up download listener BEFORE clicking
                const downloadPromise = this.page.waitForEvent('download', { timeout: 60000 }).catch(() => null);

                // Click the download button using a more robust method
                const clicked = await this.page.evaluate((videoId) => {
                    // Find the element with our video ID
                    const allElements = Array.from(document.querySelectorAll('*'));
                    
                    for (const el of allElements) {
                        const text = el.innerText || el.textContent || '';
                        if (!text.includes(`ID ${videoId}`) && !text.includes(`ID\n${videoId}`)) continue;
                        if (text.length > 5000) continue; // Skip the whole page
                        
                        // Look for download button
                        const btns = el.querySelectorAll('button');
                        for (const btn of btns) {
                            const btnText = (btn.textContent || '').toLowerCase();
                            if (btnText.includes('download') && (btnText.includes('1080p') || btnText.includes('720p') || btnText.includes('mp4'))) {
                                console.log('[MyContent] Clicking button:', btn.textContent?.trim());
                                btn.click();
                                return { success: true, buttonText: btn.textContent?.trim() || 'Download' };
                            }
                        }
                    }

                    // Fallback: Try to find any download button near a video ID mention
                    const buttons = Array.from(document.querySelectorAll('button'));
                    for (const btn of buttons) {
                        const btnText = (btn.textContent || '').toLowerCase();
                        if (btnText.includes('download') && btnText.includes('1080p')) {
                            // Check if this button's parent contains our video ID
                            let parent = btn.parentElement;
                            for (let i = 0; i < 10 && parent; i++) {
                                if ((parent.innerText || '').includes(videoId)) {
                                    console.log('[MyContent] Clicking button (fallback):', btn.textContent?.trim());
                                    btn.click();
                                    return { success: true, buttonText: btn.textContent?.trim() || 'Download', fallback: true };
                                }
                                parent = parent.parentElement;
                            }
                        }
                    }

                    return { success: false };
                }, targetVideoId);

                if (clicked.success) {
                    console.log(`[VioryDownloader] Clicked: "${clicked.buttonText}"${clicked.fallback ? ' (fallback method)' : ''}`);

                    const download = await downloadPromise;
                    if (download) {
                        const filename = download.suggestedFilename();
                        const savePath = path.join(this.downloadsPath, filename);

                        if (onProgress) onProgress({ status: 'saving', filename });
                        await download.saveAs(savePath);
                        await this.saveCookies();

                        console.log(`[VioryDownloader] Downloaded: ${savePath}`);
                        return {
                            success: true,
                            path: savePath,
                            filename,
                            fromMyContent: true,
                            videoId: targetVideoId,
                            videoTitle: videoStatus.title
                        };
                    } else {
                        console.error('[VioryDownloader] Download event not received after click');
                        // Try one more time with a longer wait
                        await this.page.waitForTimeout(2000);
                    }
                } else {
                    console.error('[VioryDownloader] Could not find/click download button');
                }
            }

            // Video still preparing or not found - wait and refresh
            if (videoStatus.found && videoStatus.isPreparing) {
                if (onProgress) {
                    onProgress({
                        status: 'processing',
                        message: `Video preparing... (${attempt}/${maxAttempts})`,
                        attempt,
                        maxAttempts
                    });
                }
            }

            // Wait and refresh page
            if (attempt < maxAttempts) {
                console.log(`[VioryDownloader] Waiting ${pollInterval / 1000}s before refresh...`);
                await this.page.waitForTimeout(pollInterval);
                await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
                await this.page.waitForTimeout(1500);
            }
        }

        console.log(`[VioryDownloader] Timeout after ${maxWaitMinutes} minutes - video not ready`);
        return {
            success: false,
            timeout: true,
            waitedMinutes: maxWaitMinutes,
            videoId: targetVideoId,
            videoTitle: targetVideoTitle,
            message: `Video not ready after ${maxWaitMinutes} minutes`
        };
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
