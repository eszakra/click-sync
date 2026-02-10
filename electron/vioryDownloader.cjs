// vioryDownloader.cjs - Production-Ready Viory Downloader for Electron
// Enhanced with Gemini Vision integration for intelligent video matching
// Refactored with proven fixes: smart matching, checkbox handling, My Content fallback

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// Platform-appropriate User-Agent for Playwright browsers
const VIORY_USER_AGENT = process.platform === 'darwin'
    ? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

class VioryDownloader {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.cookiesPath = null;
        this.downloadsPath = null;
        this.isHeadless = false;
        // Anti-repeat tracking: stores URLs of recently used videos
        // Videos cannot repeat within REPEAT_WINDOW segments
        this.recentlyUsedVideos = [];
        this.REPEAT_WINDOW = 6; // Videos can repeat after 6 segments

        // Search results cache: avoids re-scraping the same query within TTL
        // Key: query string, Value: { results: [...], timestamp: Date.now() }
        this.searchCache = new Map();
        this.SEARCH_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

        // Blacklist of videos that require "preparing" (My Content processing)
        // These are skipped immediately in future searches within the same session
        this.preparingBlacklist = new Set();
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

        // Get chromium path for packaged app (cross-platform)
        let executablePath = undefined;
        try {
            const appPath = path.dirname(process.execPath);
            const resourceBase = path.join(appPath, 'resources', 'playwright-browsers', 'chromium');
            
            let chromiumPath;
            if (process.platform === 'win32') {
                chromiumPath = path.join(resourceBase, 'chrome-win64', 'chrome.exe');
            } else if (process.platform === 'darwin') {
                // Try multiple macOS path patterns
                const macPaths = [
                    path.join(resourceBase, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                    path.join(resourceBase, 'chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                    path.join(resourceBase, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
                ];
                chromiumPath = macPaths.find(p => fs.existsSync(p));
            } else {
                chromiumPath = path.join(resourceBase, 'chrome-linux', 'chrome');
            }
            
            if (chromiumPath && fs.existsSync(chromiumPath)) {
                executablePath = chromiumPath;
                console.log('[VioryDownloader] Using bundled Chromium:', chromiumPath);
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
            userAgent: VIORY_USER_AGENT
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
     * Ensure page is available - with robust browser recovery
     */
    async ensurePage() {
        try {
            // Check if browser is still connected
            if (!this.browser || !this.browser.isConnected()) {
                console.log('[VioryDownloader] Browser disconnected, re-initializing...');
                await this.init({ headless: this.isHeadless });
                return this.page;
            }

            // Check if page is closed
            if (!this.page || this.page.isClosed()) {
                console.log('[VioryDownloader] Page closed, creating new page...');
                this.page = await this.context.newPage();
                // Apply cookies again
                await this.loadCookies();
            }

            return this.page;
        } catch (error) {
            console.error('[VioryDownloader] ensurePage error, full re-init:', error.message);
            // Full re-initialization
            this.browser = null;
            this.context = null;
            this.page = null;
            await this.init({ headless: this.isHeadless });
            return this.page;
        }
    }

    /**
     * Select best video from ranked list, avoiding recently used videos
     * If top choice was used recently, selects next best alternative
     * @param {Array} rankedVideos - Videos sorted by score (best first)
     * @returns {Object} Selected video (best available that wasn't recently used)
     */
    selectBestVideoAvoidingRepeats(rankedVideos) {
        if (!rankedVideos || rankedVideos.length === 0) return null;

        // Find first video not in recently used list
        for (let i = 0; i < rankedVideos.length; i++) {
            const video = rankedVideos[i];
            if (!this.recentlyUsedVideos.includes(video.url)) {
                if (i > 0) {
                    console.log(`   [ANTI-REPEAT] Skipped ${i} recently used video(s), selected alternative`);
                }
                return video;
            }
        }

        // All videos were recently used - allow repeat but log it
        console.log(`   [ANTI-REPEAT] All ${rankedVideos.length} candidates were recently used, allowing repeat`);
        return rankedVideos[0];
    }

    /**
     * Mark a video as used and maintain the sliding window
     * @param {string} videoUrl - URL of the video that was selected
     */
    markVideoAsUsed(videoUrl) {
        if (!videoUrl) return;

        // Add to recently used list
        this.recentlyUsedVideos.push(videoUrl);

        // Maintain sliding window - remove oldest if exceeded
        while (this.recentlyUsedVideos.length > this.REPEAT_WINDOW) {
            this.recentlyUsedVideos.shift();
        }

        console.log(`   [ANTI-REPEAT] Tracked ${this.recentlyUsedVideos.length}/${this.REPEAT_WINDOW} recent videos`);
    }

    /**
     * Generate expanded/broader search queries when initial queries return no results
     * This implements query expansion for better robustness
     * @param {object} analysis - The original Gemini analysis
     * @param {string} headline - Segment headline
     * @param {string} text - Segment text
     * @returns {array} Array of expanded query strings
     */
    generateExpansionQueries(analysis, headline, text) {
        const queries = [];
        const country = analysis?.country || '';
        const mainSubject = analysis?.main_subject || '';
        const keyVisuals = analysis?.key_visuals || [];
        
        // Extract keywords from headline and text
        const allText = `${headline} ${text}`.toLowerCase();
        const words = allText.split(/\s+/).filter(w => w.length > 3);
        const uniqueWords = [...new Set(words)].slice(0, 10);
        
        // Strategy 1: Broader country + topic combinations
        if (country) {
            queries.push(`${country} news footage`);
            queries.push(`${country} military`);
            queries.push(`${country} defense`);
            queries.push(`${country} armed forces`);
        }
        
        // Strategy 2: Generic military/defense terms with country
        if (allText.includes('military') || allText.includes('army') || allText.includes('defense')) {
            if (country) {
                queries.push(`${country} troops`);
                queries.push(`${country} soldiers`);
                queries.push(`${country} weapons`);
            }
        }
        
        // Strategy 3: Aircraft/Aviation specific
        if (allText.includes('aircraft') || allText.includes('jet') || allText.includes('plane') || allText.includes('air force')) {
            if (country) {
                queries.push(`${country} aircraft`);
                queries.push(`${country} air force`);
                queries.push(`${country} fighter jet`);
            }
            queries.push('military aircraft');
            queries.push('fighter jet footage');
        }
        
        // Strategy 4: Naval/Maritime specific
        if (allText.includes('ship') || allText.includes('naval') || allText.includes('navy') || allText.includes('carrier')) {
            if (country) {
                queries.push(`${country} navy`);
                queries.push(`${country} warship`);
                queries.push(`${country} naval`);
            }
            queries.push('warship footage');
            queries.push('naval footage');
        }
        
        // Strategy 5: Use key visual elements
        if (keyVisuals && keyVisuals.length > 0) {
            for (const visual of keyVisuals.slice(0, 3)) {
                if (country) {
                    queries.push(`${country} ${visual}`);
                }
                queries.push(`${visual} footage`);
            }
        }
        
        // Strategy 6: Important keywords from text
        const importantKeywords = uniqueWords.filter(w => 
            !['this', 'that', 'with', 'from', 'have', 'been', 'were', 'said'].includes(w)
        );
        
        for (let i = 0; i < Math.min(importantKeywords.length, 3); i++) {
            const keyword = importantKeywords[i];
            if (country) {
                queries.push(`${country} ${keyword}`);
            }
            queries.push(`${keyword} news`);
        }
        
        // Strategy 7: Generic fallbacks based on topic
        if (allText.includes('war') || allText.includes('conflict') || allText.includes('attack')) {
            queries.push('military conflict footage');
            queries.push('war footage');
        }
        
        if (allText.includes('drill') || allText.includes('exercise') || allText.includes('training')) {
            queries.push('military exercise');
            queries.push('military drill');
        }
        
        if (allText.includes('meeting') || allText.includes('summit') || allText.includes('talks')) {
            queries.push('diplomatic meeting');
            queries.push('international summit');
        }
        
        // Strategy 8: Ultra-generic final fallbacks
        queries.push('military footage');
        queries.push('defense news');
        if (country) {
            queries.push(`${country} footage`);
        }
        
        // Remove duplicates and limit to 12 queries
        const uniqueQueries = [...new Set(queries)].slice(0, 12);
        
        console.log(`[Expansion] Generated ${uniqueQueries.length} expanded queries:`, uniqueQueries);
        return uniqueQueries;
    }

    /**
     * Download a video on an ISOLATED page (for manual URL downloads)
     * This creates a separate page so it doesn't interfere with ongoing segment downloads
     * @param {string} videoUrl - The Viory video URL
     * @param {function} onProgress - Progress callback
     * @returns {object} Download result
     */
    async downloadVideoIsolated(videoUrl, onProgress) {
        console.log(`[VioryDownloader] ISOLATED download for: ${videoUrl}`);

        // Create isolated page from same context (shares cookies/login)
        let isolatedPage = null;
        try {
            isolatedPage = await this.context.newPage();
            console.log('[VioryDownloader] Created isolated page for manual download');

            // Extract Video ID
            const videoId = this.extractVideoId(videoUrl);
            console.log(`[VioryDownloader] Video ID: ${videoId}`);

            let videoTitle = '';
            let earlyMandatoryCredit = '';

            // Navigate to video page
            await isolatedPage.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
            await isolatedPage.waitForSelector('button', { timeout: 5000 }).catch(() => { });
            await isolatedPage.waitForTimeout(800);

            // Dismiss popups on isolated page
            await isolatedPage.evaluate(() => {
                document.querySelectorAll('button').forEach(btn => {
                    const text = btn.textContent || '';
                    if (text === '×' || text === 'x' || text === 'X') btn.click();
                });
                document.querySelectorAll('.popup-close, [aria-label="Close"], .modal-close').forEach(el => el.click());
            });
            await isolatedPage.waitForTimeout(300);

            // Extract video title
            videoTitle = await isolatedPage.evaluate(() => {
                const h1 = document.querySelector('h1');
                return h1 ? h1.innerText.trim() : '';
            });
            console.log(`[VioryDownloader] Video title: "${videoTitle.substring(0, 50)}..."`);

            // Extract mandatory credit early
            try {
                earlyMandatoryCredit = await isolatedPage.evaluate(() => {
                    const bodyText = document.body.innerText || '';
                    const creditMatch = bodyText.match(/[Mm]andatory\s*credit[:\s]+([^\n]+)/);
                    if (creditMatch && creditMatch[1]) {
                        let credit = creditMatch[1].trim();
                        credit = credit.replace(/[;].*$/, '').trim();
                        credit = credit.replace(/\/[A-Z].*$/i, '').trim();
                        credit = credit.replace(/\s*\/-.*$/, '').trim();
                        credit = credit.replace(/\s*\/\s*-.*$/, '').trim();
                        credit = credit.replace(/\s+-\s+.*$/, '').trim();
                        credit = credit.replace(/[.,;:\/]+$/, '').trim();
                        if (credit.length >= 3 && credit.length <= 100) {
                            return credit;
                        }
                    }
                    return '';
                });
                if (earlyMandatoryCredit) {
                    console.log(`[VioryDownloader] ✅ Early extracted mandatoryCredit: "${earlyMandatoryCredit}"`);
                }
            } catch (e) {
                console.log(`[VioryDownloader] Could not extract early credit: ${e.message}`);
            }

            // Scroll and click Download button
            await isolatedPage.evaluate(() => window.scrollBy(0, 300));
            await isolatedPage.waitForTimeout(200);

            console.log('[VioryDownloader] Clicking Download button to open modal...');
            const openedModal = await isolatedPage.evaluate(() => {
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
                throw new Error('Could not find Download button');
            }

            await isolatedPage.waitForTimeout(1000);

            // Wait for modal
            try {
                await isolatedPage.waitForSelector('input[type="checkbox"]', { timeout: 5000 });
            } catch (e) {
                console.log('[VioryDownloader] No checkbox found, trying direct download...');
            }

            // Handle restrictions checkbox
            console.log('[VioryDownloader] Handling restrictions checkbox...');
            await isolatedPage.evaluate(() => {
                const checkboxes = document.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => {
                    if (!cb.checked) cb.click();
                });
            });
            await isolatedPage.waitForTimeout(250);

            // Set up download listener
            const downloadPromise = isolatedPage.waitForEvent('download', { timeout: 15000 }).catch(() => null);

            // Click submit button
            console.log('[VioryDownloader] Clicking modal submit button...');
            await isolatedPage.evaluate(() => {
                const modal = document.querySelector('[role="dialog"], .modal, [class*="modal"], [class*="Modal"]') || document.body;
                const btns = Array.from(modal.querySelectorAll('button'));

                let submitBtn = btns.find(b => {
                    const text = (b.textContent || '').toLowerCase();
                    return (text.includes('download') || text.includes('confirm') || text.includes('submit')) && !b.disabled;
                });

                if (!submitBtn) {
                    submitBtn = btns.find(b => {
                        const classes = b.className || '';
                        return (classes.includes('primary') || classes.includes('submit') || classes.includes('bg-blue')) && !b.disabled;
                    });
                }

                if (!submitBtn && btns.length > 0) {
                    submitBtn = btns[btns.length - 1];
                }

                if (submitBtn) submitBtn.click();
            });

            await isolatedPage.waitForTimeout(1200);

            // Check for "preparing video" modal
            const preparingText = await isolatedPage.evaluate(() => {
                const text = document.body.innerText || '';
                return text.includes('preparing your video') || text.includes('We are preparing');
            });

            if (preparingText) {
                console.log('[VioryDownloader] Video requires processing - not immediately available');
                await isolatedPage.close();
                return {
                    success: false,
                    needsMyContent: true,
                    message: 'This video requires processing. Please choose a different video that is ready for download.'
                };
            }

            // Wait for download
            const download = await downloadPromise;

            if (download) {
                let filename = download.suggestedFilename();
                // Ensure unique filename to prevent overwriting
                const timestamp = Date.now();
                const uniqueFilename = `${timestamp}_${filename}`;
                const savePath = path.join(this.downloadsPath, uniqueFilename);
                console.log(`[VioryDownloader] Downloading: ${uniqueFilename}`);

                if (onProgress) onProgress({ status: 'downloading', filename: uniqueFilename });

                await download.saveAs(savePath);

                // Verify file
                if (!fs.existsSync(savePath)) {
                    throw new Error('Download completed but file not found');
                }

                const stats = fs.statSync(savePath);
                if (stats.size < 1000) {
                    throw new Error('Downloaded file is too small, likely corrupt');
                }

                console.log(`[VioryDownloader] Saved: ${savePath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);

                // Extract late mandatory credit
                let mandatoryCredit = '';
                try {
                    await isolatedPage.evaluate(() => {
                        const allElements = document.querySelectorAll('*');
                        for (const el of allElements) {
                            if (el.childNodes.length === 1 && el.textContent.trim() === 'Meta data') {
                                const sibling = el.nextElementSibling;
                                if (sibling && sibling.tagName === 'BUTTON') {
                                    sibling.click();
                                    return true;
                                }
                            }
                        }
                        return false;
                    });
                    await isolatedPage.waitForTimeout(300);

                    mandatoryCredit = await isolatedPage.evaluate(() => {
                        const bodyText = document.body.innerText || '';
                        const creditMatch = bodyText.match(/[Mm]andatory\s*credit[:\s]+([^\n]+)/);
                        if (creditMatch && creditMatch[1]) {
                            let credit = creditMatch[1].trim();
                            credit = credit.replace(/[;].*$/, '').trim();
                            credit = credit.replace(/\/[A-Z].*$/i, '').trim();
                            credit = credit.replace(/\s*\/-.*$/, '').trim();
                            credit = credit.replace(/\s+-\s+.*$/, '').trim();
                            credit = credit.replace(/[.,;:\/]+$/, '').trim();
                            if (credit.length >= 3 && credit.length <= 100) {
                                return credit;
                            }
                        }
                        return '';
                    });
                } catch (e) {
                    console.log(`[VioryDownloader] Late credit extraction failed: ${e.message}`);
                }

                const finalCredit = earlyMandatoryCredit || mandatoryCredit || '';

                // Close isolated page
                await isolatedPage.close();
                console.log('[VioryDownloader] Closed isolated page');

                return {
                    success: true,
                    path: savePath,
                    filename,
                    videoTitle,
                    mandatoryCredit: finalCredit
                };
            }

            // No direct download - try fallback
            console.log('[VioryDownloader] No direct download, checking for My Content...');
            await isolatedPage.close();
            return {
                success: false,
                message: 'Download did not start. Video may require processing.'
            };

        } catch (error) {
            console.error(`[VioryDownloader] Isolated download error: ${error.message}`);
            if (isolatedPage) {
                try { await isolatedPage.close(); } catch (e) { }
            }
            return {
                success: false,
                message: error.message
            };
        }
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
            try { await this.saveCookies(); } catch (x) { }
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
            // Get chromium path (cross-platform)
            let executablePath = undefined;
            try {
                const appPath = path.dirname(process.execPath);
                const resourceBase = path.join(appPath, 'resources', 'playwright-browsers', 'chromium');
                
                let chromiumPath;
                if (process.platform === 'win32') {
                    chromiumPath = path.join(resourceBase, 'chrome-win64', 'chrome.exe');
                } else if (process.platform === 'darwin') {
                    const macPaths = [
                        path.join(resourceBase, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                        path.join(resourceBase, 'chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                        path.join(resourceBase, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
                    ];
                    chromiumPath = macPaths.find(p => fs.existsSync(p));
                } else {
                    chromiumPath = path.join(resourceBase, 'chrome-linux', 'chrome');
                }
                
                if (chromiumPath && fs.existsSync(chromiumPath)) {
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
                userAgent: VIORY_USER_AGENT
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
            if (tempPage) await tempPage.close().catch(() => { });
            if (tempContext) await tempContext.close().catch(() => { });
            if (tempBrowser) await tempBrowser.close().catch(() => { });
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
     * INTELLIGENT VIDEO SEARCH PIPELINE
     * Complete 6-stage pipeline with Gemini analysis and visual validation
     * Exact copy of test-intelligent-search.cjs logic that produced good results
     * 
     * @param {string} headline - News segment headline
     * @param {string} text - News segment text/description
     * @param {string} geminiApiKey - Gemini API key
     * @param {Object} options - Search options
     * @param {Buffer} options.segmentFrame - Optional screenshot/frame from the segment
     * @param {Function} options.shouldSkip - Callback to check if user requested skip
     * @returns {Object} Best matching video with full analysis
     */
    async intelligentSearch(headline, text, geminiApiKey, options = {}) {
        const {
            maxQueries = 5,
            maxVideosToAnalyze = 5,
            topNForVisualValidation = 3,
            segmentFrame = null,  // Screenshot from the news segment
            onProgress = () => { },
            shouldSkip = () => false  // Callback to check if user requested skip
        } = options;

        // Helper to check for skip and throw if needed
        const checkSkip = () => {
            if (shouldSkip()) {
                throw new Error('SKIPPED_BY_USER');
            }
        };

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
            // Use gemini-3-flash-preview for text/query generation (smarter)
            const textModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
            // Use gemini-3-flash-preview for vision/image analysis
            const visionModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

            const analysisPrompt = `You are a news video researcher for Viory.video. Analyze this segment and generate optimal search queries.

SEGMENT:
- Headline: "${headline}"
- Text: "${text}"

RESPOND ONLY WITH VALID JSON.

═══════════════════════════════════════════════════════════════════════
⚠️ CRITICAL: QUERY FORMAT FOR ACCURATE RESULTS
═══════════════════════════════════════════════════════════════════════

STEP 1: Determine segment type

SET has_important_person = true IF:
- World leader mentioned by NAME (Trump, Putin, Xi, Netanyahu, Peskov, etc.)
- Story is about their statements, decisions, or actions
- Examples: "Trump announces fleet", "Netanyahu warns Iran", "Peskov says Russia ready"

SET has_important_person = false IF:
- About countries, events, military, or general topics
- Generic titles: "officials", "commanders", "government"
- Examples: "USS deployed", "Iran military exercises", "Trade war escalates"

═══════════════════════════════════════════════════════════════════════
STEP 2: QUERY FORMAT - THIS IS CRITICAL
═══════════════════════════════════════════════════════════════════════

IF has_important_person = true (PERSON MODE):
Use QUOTED EXACT PHRASES to find videos of THE PERSON speaking, not reactions:

✅ CORRECT FORMAT (uses quotes for exact match):
  "queries": ["\"Trump says\"", "\"Trump announces\"", "\"Trump warns\"", "Trump White House"]

❌ WRONG FORMAT (returns OTHER people talking about Trump):
  "queries": ["Trump says", "Trump Iran", "Trump statement"]

The quotes force EXACT phrase matching, filtering out reaction videos like "Venezuela responds to Trump".

PERSON MODE QUERY RULES (CRITICAL):
- Query 1: MUST be quoted "[Name] says" OR "[Name] speaks" (Finds strict speech)
- Query 2: "[Name] soundbite" (Finds interviews/talking heads)
- Query 3: "[Name] speech" OR "[Name] remarks"
- Query 4: [Name] + specific location (White House, Mar-a-Lago, Kremlin)
- Query 5: Fallback like "US president" or "Russian official"

IF has_important_person = false (FOOTAGE MODE):
Use COUNTRY + ACTION queries to get footage from the correct country:

✅ CORRECT FORMAT (country + visual action):
  "queries": ["IRGC parade", "Iran troops military", "Tehran streets", "Iran missiles", "Persian Gulf"]

❌ WRONG FORMAT (too generic - returns random countries):
  "queries": ["military parade", "troops", "missiles", "naval fleet"]

FOOTAGE MODE QUERY RULES:
- EVERY query MUST include country name OR country-specific organization (IRGC, Pentagon, Kremlin)
- Add ACTION WORDS: parade, sailing, launch, footage, troops, streets
- Use specific locations: Tehran, Washington, Moscow, Tel Aviv

TESTED EXAMPLES THAT WORK:
- "IRGC parade" → Iran military parade with missiles ✅
- "Iran troops military" → Tehran billboard, Iranian soldiers ✅  
- "Russia military parade" → Russian corvette, tanks ✅
- "warship sailing" → actual ship footage ✅
- "missile launch footage" → missile launches ✅

MILITARY CONTENT STRATEGY (CRITICAL):
For US Military, specific LOCATIONS work much better than generic terms:
- ✅ "Pentagon military" (Finds official briefings, B-roll)
- ✅ "Ramstein Air Base" (Finds specific aircraft in Europe)
- ✅ "Andrews Air Force Base" (Finds VIP aircraft, Air Force One)
- ✅ "US aircraft carrier" (Specific ship class works well)
- ❌ "US Air Force jet" (Too generic, often returns wrong country)

If content is US Military, queries 1-3 MUST use locations like "Pentagon", "Ramstein", or specific bases if mentioned.

EXAMPLES THAT FAIL:
- "military parade" → returns Central African Republic ❌
- "aircraft carrier" → returns person talking about carriers ❌
- "USS Abraham Lincoln" → returns Russian official reacting ❌

═══════════════════════════════════════════════════════════════════════
OUTPUT (VALID JSON ONLY - NO MARKDOWN):
═══════════════════════════════════════════════════════════════════════
{
  "main_subject": "what the video should show",
  "country": "primary country/countries (e.g. Iran/USA)",
  "secondary_country": "second country or null",
  "location_keywords": ["Tehran", "Washington", etc.],
  "has_important_person": true or false,
  "person_name": "full name or null",
  "person_description": "physical description for visual ID",
  "key_visuals": ["what must be visible"],
  "must_show": ["required elements with country context"],
  "avoid": ["wrong countries", "reactions instead of direct content"],
  "queries": ["query1", "query2", "query3", "query4", "query5"]
}

RULES:
- has_important_person=true → use QUOTED queries: "\"Trump says\""
- has_important_person=false → use COUNTRY+ACTION: "IRGC parade", "Iran military"
- NEVER use generic queries without country: "protest", "military", "diplomacy"

═══════════════════════════════════════════════════════════════════════
VIP LOOKUP TABLE (USE THESE EXACT QUERIES IF PERSON MATCHES):
═══════════════════════════════════════════════════════════════════════
- Donald Trump      → 1st Query MUST BE: "\"Trump says\""
- Vladimir Putin    → 1st Query MUST BE: "\"Putin says\""
- Ali Khamenei      → 1st Query MUST BE: "\"Khamenei says\""
- Nicolas Maduro    → 1st Query MUST BE: "\"Maduro says\""
- Antonio Guterres  → 1st Query MUST BE: "\"Antonio Guterres UN\""
- He Lifeng         → 1st Query MUST BE: "He Lifeng" (No quotes)
- Xi Jinping        → 1st Query MUST BE: "\"Xi Jinping\"" (Quotes)
- Marco Rubio       → 1st Query MUST BE: "\"Marco Rubio\"" (Quotes)

═══════════════════════════════════════════════════════════════════════
TECHNICAL ENTITY LOOKUP (For Aircraft, Vehicles, Equipment, Brands):
═══════════════════════════════════════════════════════════════════════
IF the headline mentions:
- Aircraft model (EA-37B, F-35, Su-57, MiG-31, B-21, A-10, C-130)
- Vehicle model (M1 Abrams, Leopard 2, T-90, HMMWV)
- Weapon system (HIMARS, Patriot, S-400, Stinger, Javelin)
- Engine/manufacturer brand (Rolls-Royce, Pratt & Whitney, GE Aviation)
- Ship class (USS, HMS, destroyer, frigate, aircraft carrier)

THEN use GENERIC CATEGORY + COUNTRY queries (obscure model numbers return zero results):
- Query 1: "[aircraft type] [country]" e.g. "US military aircraft", "fighter jet USA"
- Query 2: "[broader category]" e.g. "Air Force footage", "military jet"
- Query 3: "[action + subject]" e.g. "fighter takeoff", "jet flying"
- Query 4: "[country military]" e.g. "US military footage", "Pentagon"
- Query 5: "[generic fallback]" e.g. "military aviation", "aircraft footage"

⚠️ CRITICAL RULE: Query 5 MUST ALWAYS be ultra-generic video footage query!
    Query 5 is your SAFETY NET. Use ONLY these types of fallbacks:
    - "military footage" (for any military topic)
    - "news footage" (for any news topic)  
    - "documentary footage" (for historical topics)
    - "industry footage" (for manufacturing/business)
    - "[country] news footage" (country-specific fallback)

EXAMPLES (VERY IMPORTANT - LEARN FROM THESE):
- "EA-37B Compass Call electronic warfare" → ["US Air Force jet", "US electronic warfare", "military aircraft takeoff", "Pentagon footage", "military footage"]
- "Rolls-Royce engine manufacturing issues" → ["aircraft engine factory", "jet engine", "aviation industry", "manufacturing facility", "industry footage"]
- "F-35 delivery to Israel" → ["Israel Air Force", "military jet Israel", "fighter plane", "Israel defense", "military footage"]
- "USS Abraham Lincoln deployment" → ["US Navy aircraft carrier", "warship sailing", "naval fleet", "US Navy footage", "military footage"]
- "B-21 Raider stealth bomber" → ["US bomber aircraft", "Air Force bomber", "stealth plane", "Pentagon footage", "military footage"]
═══════════════════════════════════════════════════════════════════════`;

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

            // Check for user skip request before starting search
            checkSkip();

            // ================================================================
            // STAGE 2: VIORY SEARCH - Search with generated queries
            // OPTIMIZED: Parallel search with 3 pages for ~3x speed improvement
            // ================================================================
            console.log('\n[STAGE 2] Viory Search (PARALLEL MODE - 3 pages)...');
            const startStage2 = Date.now();

            const page = await this.ensurePage(); // Main page - will be reused in Stage 3
            const allVideos = [];
            const seenUrls = new Set();
            const country = (analysis.country || '').toLowerCase();
            const queriesToUse = analysis.queries.slice(0, maxQueries);
            const SEARCH_PARALLEL_PAGES = 5; // Increased from 3 to 5 for faster search

            onProgress({ stage: 2, message: `[Search] Searching with ${queriesToUse.length} queries using ${SEARCH_PARALLEL_PAGES} parallel pages...` });

            // Helper function to search with a single query on a given page
            const searchWithQuery = async (query, pageInstance, queryIndex) => {
                // Check cache first (avoids re-scraping the same query)
                const cacheKey = query.toLowerCase().trim();
                const cached = this.searchCache.get(cacheKey);
                if (cached && (Date.now() - cached.timestamp) < this.SEARCH_CACHE_TTL) {
                    console.log(`      [CACHE HIT] "${query.substring(0, 30)}..." - ${cached.results.length} cached results`);
                    return { query, queryIndex, results: cached.results, error: null };
                }

                try {
                    const searchUrl = `https://www.viory.video/en/videos?search=${encodeURIComponent(query)}`;
                    await pageInstance.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 });

                    try {
                        await pageInstance.waitForSelector('a[href*="/videos/"]', { timeout: 8000 });
                    } catch (e) {
                        return { query, queryIndex, results: [], error: 'no_results' };
                    }

                    await pageInstance.waitForTimeout(300);

                    // Scroll down to trigger lazy-loading of additional results
                    for (let scrolli = 0; scrolli < 3; scrolli++) {
                        await pageInstance.evaluate(() => window.scrollBy(0, 600));
                        await pageInstance.waitForTimeout(250);
                    }

                    // Get results with titles AND thumbnail URLs
                    const searchResults = await pageInstance.evaluate(() => {
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

                            // Get thumbnail URL from the image inside the link/container
                            let thumbnailUrl = '';
                            const img = link.querySelector('img') || container?.querySelector('img');
                            if (img) {
                                thumbnailUrl = img.src || img.getAttribute('src') || '';
                                // Convert small thumbnails to larger versions if possible
                                if (thumbnailUrl.includes('/small_')) {
                                    thumbnailUrl = thumbnailUrl.replace('/small_', '/');
                                }
                            }

                            const fullUrl = href.startsWith('http') ? href : `https://www.viory.video${href}`;

                            if (title && !videos.some(v => v.url === fullUrl)) {
                                videos.push({
                                    url: fullUrl,
                                    title: title.substring(0, 200),
                                    thumbnailUrl: thumbnailUrl
                                });
                            }
                        });

                        return videos.slice(0, 20); // Get more results for thumbnail filtering (increased with scroll)
                    });

                    // Cache the results for future queries
                    if (searchResults.length > 0) {
                        this.searchCache.set(cacheKey, { results: searchResults, timestamp: Date.now() });
                    }

                    return { query, queryIndex, results: searchResults, error: null };
                } catch (error) {
                    return { query, queryIndex, results: [], error: error.message };
                }
            };

            // Create additional pages for parallel search (reuse main page)
            const searchPages = [page];
            try {
                for (let i = 1; i < SEARCH_PARALLEL_PAGES; i++) {
                    const newPage = await this.context.newPage();
                    searchPages.push(newPage);
                }
                console.log(`   Created ${SEARCH_PARALLEL_PAGES} parallel search pages`);
            } catch (e) {
                console.warn(`   Could not create extra search pages: ${e.message}`);
            }

            // Process queries in parallel batches
            const numSearchBatches = Math.ceil(queriesToUse.length / searchPages.length);
            let queriesCompleted = 0;

            for (let batchNum = 0; batchNum < numSearchBatches; batchNum++) {
                checkSkip();

                const batchStart = batchNum * searchPages.length;
                const batchQueries = queriesToUse.slice(batchStart, batchStart + searchPages.length);

                // Log batch start with query names
                const queryNames = batchQueries.map(q => `"${q.substring(0, 30)}"`).join(', ');
                console.log(`   [Batch ${batchNum + 1}/${numSearchBatches}] Searching: ${queryNames}`);
                onProgress({
                    stage: 2,
                    message: `[Search] Batch ${batchNum + 1}/${numSearchBatches}: ${queryNames}`
                });

                // Run parallel searches
                const batchPromises = batchQueries.map((query, idx) => {
                    const pageToUse = searchPages[idx % searchPages.length];
                    const globalIndex = batchStart + idx;
                    return searchWithQuery(query, pageToUse, globalIndex);
                });

                const batchResults = await Promise.all(batchPromises);

                // Process results in order (by queryIndex for priority)
                batchResults.sort((a, b) => a.queryIndex - b.queryIndex);

                for (const result of batchResults) {
                    const { query, queryIndex, results: searchResults, error } = result;

                    if (error === 'no_results') {
                        console.log(`      [${queryIndex + 1}] ✗ "${query.substring(0, 30)}..." - No results`);
                    } else if (error) {
                        console.log(`      [${queryIndex + 1}] ✗ "${query.substring(0, 30)}..." - Error: ${error}`);
                    } else {
                        console.log(`      [${queryIndex + 1}] ✓ "${query.substring(0, 30)}..." - ${searchResults.length} videos`);

                        // Add results with priority
                        for (const video of searchResults) {
                            if (!seenUrls.has(video.url)) {
                                seenUrls.add(video.url);
                                allVideos.push({
                                    ...video,
                                    sourceQuery: query,
                                    queryPriority: queryIndex
                                });
                            }
                        }
                    }
                }

                queriesCompleted += batchQueries.length;

                // Small delay between batches
                if (batchNum + 1 < numSearchBatches) {
                    await new Promise(r => setTimeout(r, 200));
                }
            }

            // Close extra search pages (keep main page)
            for (let i = 1; i < searchPages.length; i++) {
                try {
                    await searchPages[i].close();
                } catch (e) { }
            }

            // SORT BY QUERY PRIORITY - videos from first (most specific) query come first
            allVideos.sort((a, b) => a.queryPriority - b.queryPriority);

            results.timings.stage2 = Date.now() - startStage2;
            const timePerQuery = (results.timings.stage2 / queriesToUse.length).toFixed(0);
            console.log(`   ✓ Search complete: ${allVideos.length} unique videos from ${queriesToUse.length} queries in ${(results.timings.stage2 / 1000).toFixed(1)}s (${timePerQuery}ms/query avg)`);

            onProgress({
                stage: 2,
                message: `[Search] ✓ Complete: ${allVideos.length} videos found in ${(results.timings.stage2 / 1000).toFixed(1)}s`,
                complete: true
            });

            if (allVideos.length === 0) {
                console.log('   No videos found with initial queries. Attempting query expansion...');
                onProgress({
                    stage: 2,
                    message: '[Search] No results with initial queries. Expanding search terms...'
                });

                // ================================================================
                // QUERY EXPANSION: Generate broader queries when initial search fails
                // ================================================================
                const expansionQueries = this.generateExpansionQueries(analysis, headline, text);
                
                if (expansionQueries.length > 0) {
                    console.log(`   Trying ${expansionQueries.length} expanded queries...`);

                    // Run expansion queries sequentially on the main page
                    // (extra search pages were already closed, only searchPages[0] remains)
                    for (let i = 0; i < expansionQueries.length; i++) {
                        const query = expansionQueries[i];
                        const queryIndex = i + 100;

                        const result = await searchWithQuery(query, searchPages[0], queryIndex);
                        const { results: searchResults, error } = result;

                        if (!error && searchResults && searchResults.length > 0) {
                            console.log(`      [EXPAND] ✓ "${query.substring(0, 30)}..." - ${searchResults.length} videos`);

                            for (const video of searchResults) {
                                if (!seenUrls.has(video.url)) {
                                    seenUrls.add(video.url);
                                    allVideos.push({
                                        ...video,
                                        sourceQuery: query,
                                        queryPriority: queryIndex
                                    });
                                }
                            }
                        } else {
                            console.log(`      [EXPAND] ✗ "${query.substring(0, 30)}..." - ${error || 'No results'}`);
                        }

                        // Stop early if we found enough videos
                        if (allVideos.length >= 12) {
                            console.log(`      [EXPAND] Found ${allVideos.length} videos, stopping expansion early`);
                            break;
                        }

                        // Small delay between queries
                        if (i + 1 < expansionQueries.length) {
                            await new Promise(r => setTimeout(r, 300));
                        }
                    }
                }

                if (allVideos.length === 0) {
                    console.log('   No videos found even with expanded queries!');
                    onProgress({
                        stage: 2,
                        message: '[Search] ✗ No videos found even with expanded search terms',
                        complete: true
                    });
                    return results;
                }

                console.log(`   ✓ Found ${allVideos.length} videos with expanded queries`);
            }

            // ================================================================
            // STAGE 2.5: THUMBNAIL VISION ANALYSIS - Filter by visual content
            // NEW: Analyze thumbnails BEFORE deep analysis for faster, more accurate results
            // ================================================================
            console.log('\n[STAGE 2.5] Thumbnail Vision Analysis...');
            const startStage25 = Date.now();

            // Only process videos that have thumbnail URLs
            const videosWithThumbnails = allVideos.filter(v => v.thumbnailUrl && v.thumbnailUrl.startsWith('http'));
            console.log(`   Found ${videosWithThumbnails.length}/${allVideos.length} videos with thumbnails`);

            let thumbnailFilteredVideos = allVideos; // Default: use all if thumbnail analysis fails

            if (videosWithThumbnails.length >= 3) {
                onProgress({
                    stage: 2.5,
                    message: `[Thumbnails] Analyzing ${Math.min(videosWithThumbnails.length, 12)} thumbnails with vision AI...`
                });

                try {
                    // Download thumbnails in parallel using https module (fast - they're small images)
                    const https = require('https');
                    const http = require('http');

                    const downloadThumbnail = (url) => {
                        return new Promise((resolve) => {
                            const protocol = url.startsWith('https') ? https : http;
                            const request = protocol.get(url, { timeout: 5000 }, (response) => {
                                if (response.statusCode !== 200) {
                                    resolve(null);
                                    return;
                                }
                                const chunks = [];
                                response.on('data', chunk => chunks.push(chunk));
                                response.on('end', () => resolve(Buffer.concat(chunks)));
                                response.on('error', () => resolve(null));
                            });
                            request.on('error', () => resolve(null));
                            request.on('timeout', () => { request.destroy(); resolve(null); });
                        });
                    };

                    const thumbnailsToAnalyze = videosWithThumbnails.slice(0, 12);
                    const thumbnailDownloads = await Promise.all(
                        thumbnailsToAnalyze.map(async (video, idx) => {
                            try {
                                const buffer = await downloadThumbnail(video.thumbnailUrl);
                                if (!buffer) return { video, thumbnail: null, error: 'download_failed' };
                                return { video, thumbnail: buffer, error: null };
                            } catch (e) {
                                return { video, thumbnail: null, error: e.message };
                            }
                        })
                    );

                    const successfulDownloads = thumbnailDownloads.filter(d => d.thumbnail !== null);
                    console.log(`   Downloaded ${successfulDownloads.length}/${thumbnailsToAnalyze.length} thumbnails`);

                    if (successfulDownloads.length >= 3) {
                        // Build the vision prompt with all thumbnails
                        const thumbnailPromptParts = [];

                        // Add each thumbnail image
                        successfulDownloads.forEach((item, idx) => {
                            thumbnailPromptParts.push({
                                inlineData: {
                                    mimeType: 'image/jpeg',
                                    data: item.thumbnail.toString('base64')
                                }
                            });
                        });

                        // Build search criteria from analysis
                        const searchCriteria = [];
                        if (analysis.has_important_person && analysis.person_name) {
                            searchCriteria.push(`Person: ${analysis.person_name}`);
                        }
                        if (analysis.key_visuals && analysis.key_visuals.length > 0) {
                            searchCriteria.push(`Visuals: ${analysis.key_visuals.join(', ')}`);
                        }
                        if (analysis.must_show && analysis.must_show.length > 0) {
                            searchCriteria.push(`Must show: ${analysis.must_show.join(', ')}`);
                        }
                        if (analysis.country) {
                            searchCriteria.push(`Country/Context: ${analysis.country}`);
                        }

                        // Add the analysis prompt - PERSON-AWARE RELEVANCE MATCHING
                        const personModeInstructions = analysis.has_important_person && analysis.person_name
                            ? `
═══════════════════════════════════════════════════════════════════════
⚠️ PERSON MODE ACTIVE - Looking for: ${analysis.person_name}
═══════════════════════════════════════════════════════════════════════
We need to find videos showing ${analysis.person_name} ON CAMERA.

SCORING FOR PERSON MODE:
90-100: ${analysis.person_name} clearly visible (at podium, interview, close-up)
70-89: ${analysis.person_name} likely present (official setting, press conference)
40-69: Cannot confirm if ${analysis.person_name} is shown (unclear/distant)
0-39: DEFINITELY NOT ${analysis.person_name} - shows crowds, protests, OTHER politicians

⚠️ STRICT REJECTION:
- Crowds or protests → score 10-20 (even if related to ${analysis.person_name})
- Different politician visible → score 5-15
- Military/officials without ${analysis.person_name} → score 20-35
`
                            : `
═══════════════════════════════════════════════════════════════════════
⚠️ FOOTAGE MODE - COUNTRY/LOCATION IS CRITICAL
═══════════════════════════════════════════════════════════════════════
REQUIRED COUNTRY/REGION: ${analysis.country || 'Not specified'}
${analysis.secondary_country ? `SECONDARY COUNTRY: ${analysis.secondary_country}` : ''}
${analysis.location_keywords ? `SPECIFIC LOCATIONS: ${analysis.location_keywords.join(', ')}` : ''}

THE FOOTAGE MUST BE FROM THE CORRECT COUNTRY. This is the #1 priority.

SCORING FOR FOOTAGE MODE:
90-100: PERFECT - Clearly from ${analysis.country || 'correct country'}, shows exact topic
85-89: EXCELLENT - From correct country/region, related content
70-84: GOOD - Appears to be from correct region, relevant topic
50-69: UNCERTAIN - Cannot confirm country, but topic seems related
20-49: WRONG LOCATION - Footage appears to be from a DIFFERENT country
0-19: COMPLETELY WRONG - Different country AND different topic

⚠️ STRICT REJECTION FOR WRONG COUNTRY:
- Protest with flags from OTHER countries (Venezuela, Palestine, etc.) → score 5-15
- European city when segment is about Middle East → score 10-20
- Asian location when segment is about Americas → score 10-20
- Generic "international" footage with no clear location → score 30-40

⛔ IMMEDIATE REJECTION - SCORE 0-5:
- CHINESE/JAPANESE/KOREAN TEXT visible when segment is about Middle East/Iran → score 0-5
- East Asian faces/performances when looking for Middle Eastern content → score 0-5
- Russian Cyrillic text when looking for Iran/Middle East → score 5-10
- WRONG ALPHABET completely mismatched to required country → score 0-10

HOW TO IDENTIFY COUNTRY:
- Look for FLAGS (national flags indicate country)
- Look for SIGNS/TEXT - CHECK THE ALPHABET:
  * Chinese characters (汉字) = China
  * Arabic script (العربية) = Middle East/Iran
  * Cyrillic (кириллица) = Russia
  * Latin = Western countries
- Look for ARCHITECTURE (Middle Eastern, European, Asian styles)
- Look for UNIFORMS (police, military with country insignia)
- Look for LANDMARKS (recognizable buildings, monuments)

EXAMPLE: If segment is about "Iran-US diplomacy":
✅ ACCEPT: Iranian flags, Tehran streets, US State Department, Persian/Arabic text
❌ REJECT: Chinese text (中文), Japanese, Korean, Venezuelan flags, European protests
`;

                        const thumbnailAnalysisPrompt = `You are a news video thumbnail analyzer.

TASK: You will receive ${successfulDownloads.length} IMAGES (thumbnails) numbered 0 to ${successfulDownloads.length - 1}.
Analyze EACH IMAGE INDIVIDUALLY and give a score for EACH ONE.

NEWS SEGMENT TOPIC: ${analysis.main_subject}
REQUIRED COUNTRY/REGION: ${analysis.country || 'Any'}
${analysis.secondary_country ? `SECONDARY COUNTRY: ${analysis.secondary_country}` : ''}
KEY VISUALS: ${(analysis.key_visuals || []).join(', ') || 'any related imagery'}
${analysis.has_important_person ? `TARGET PERSON: ${analysis.person_name}` : ''}

The images you receive are in ORDER: Image 0 is first, Image 1 is second, etc.
${personModeInstructions}
═══════════════════════════════════════════════════════════════════════
⚠️ CRITICAL: REJECT PLACEHOLDER/AUDIO-ONLY THUMBNAILS
═══════════════════════════════════════════════════════════════════════
IMMEDIATELY SCORE 0-5 if thumbnail shows:
- AUDIO WAVEFORMS (sound wave visualizations on colored background)
- Abstract graphics with no real people or scenes
- Solid color backgrounds with text or logos only
- Stock graphics, charts, or data visualizations without real footage
- Blue/dark geometric shapes without actual video content

These are AUDIO-ONLY videos with fake thumbnails. We need REAL VIDEO content!
═══════════════════════════════════════════════════════════════════════

For each thumbnail, identify:
1. IS IT REAL VIDEO? (score 0-5 if it's a waveform, abstract graphic, or placeholder)
2. WHO is visible (specific person names if recognizable)
3. WHAT is shown (event type, location, context)
4. WHERE - What country/location does this appear to be? (look for flags, signs, architecture)
5. Score based on relevance - COUNTRY MATCH IS CRITICAL for footage mode

Respond with JSON:
{
  "best_index": <index of best match with REAL VIDEO content>,
  "best_score": <score 0-100>,
  "best_reason": "brief reason",
  "evaluations": [
    {"index": 0, "score": <0-100>, "is_placeholder": true/false, "shows": "WHO/WHAT is visible", "country_detected": "country or unknown", "person_visible": "name or null"},
    {"index": 1, "score": <0-100>, "is_placeholder": true/false, "shows": "WHO/WHAT is visible", "country_detected": "country or unknown", "person_visible": "name or null"},
    ...
  ],
  "ranked_indices": [<all indices with score >= 30 AND is_placeholder=false, ordered best to worst>]
}`;

                        thumbnailPromptParts.push(thumbnailAnalysisPrompt);

                        console.log(`   Sending ${successfulDownloads.length} thumbnails to Gemini Vision...`);
                        onProgress({
                            stage: 2.5,
                            message: `[Thumbnails] Analyzing ${successfulDownloads.length} thumbnails with Gemini Vision...`
                        });

                        const thumbnailResult = await visionModel.generateContent(thumbnailPromptParts);
                        const thumbnailText = thumbnailResult.response.text().replace(/```json\n?|```/g, '').trim();
                        const thumbnailAnalysis = JSON.parse(thumbnailText);

                        console.log(`   ✓ Vision analysis complete`);
                        console.log(`   Best: Index ${thumbnailAnalysis.best_index} (${thumbnailAnalysis.best_score}%) - ${thumbnailAnalysis.best_reason}`);

                        // Log top evaluations
                        if (thumbnailAnalysis.evaluations) {
                            const sorted = [...thumbnailAnalysis.evaluations].sort((a, b) => (b.score || 0) - (a.score || 0));
                            console.log(`   Top matches:`);
                            sorted.slice(0, 5).forEach((evalItem, idx) => {
                                console.log(`      [${evalItem.index ?? idx}] ${evalItem.score}% - ${evalItem.shows || 'N/A'}`);
                            });
                        }

                        // Build filtered video list based on ranked indices
                        thumbnailFilteredVideos = [];
                        const addedUrls = new Set();

                        // Build evaluation map for quick lookup
                        const evalMap = new Map();
                        if (thumbnailAnalysis.evaluations) {
                            thumbnailAnalysis.evaluations.forEach((evalItem, idx) => {
                                const evalIdx = evalItem.index !== undefined ? evalItem.index : idx;
                                evalMap.set(evalIdx, evalItem);
                            });
                        }

                        // Use ranked_indices if available, otherwise use evaluations sorted by score
                        let rankedIndices = thumbnailAnalysis.ranked_indices || [];
                        if (rankedIndices.length === 0 && thumbnailAnalysis.evaluations) {
                            // Sort evaluations by score - be more permissive
                            rankedIndices = thumbnailAnalysis.evaluations
                                .map((e, i) => ({
                                    index: e.index !== undefined ? e.index : i,
                                    score: e.score || 0
                                }))
                                .filter(e => e.score >= 30) // Lower threshold - let more videos through
                                .sort((a, b) => b.score - a.score)
                                .map(e => e.index);
                        }

                        // Always put best_index first if it exists
                        if (thumbnailAnalysis.best_index !== undefined && thumbnailAnalysis.best_index >= 0) {
                            rankedIndices = [thumbnailAnalysis.best_index, ...rankedIndices.filter(i => i !== thumbnailAnalysis.best_index)];
                        }

                        // Add videos in ranked order
                        for (const idx of rankedIndices) {
                            if (idx >= 0 && idx < successfulDownloads.length) {
                                const video = successfulDownloads[idx].video;
                                if (!addedUrls.has(video.url)) {
                                    const evalItem = evalMap.get(idx);

                                    // Reject placeholders (audio waveforms, abstract graphics)
                                    if (evalItem && evalItem.is_placeholder === true) {
                                        console.log(`      [SKIP] Index ${idx} is audio-only/placeholder thumbnail`);
                                        continue;
                                    }

                                    // Only reject very low scores
                                    if (evalItem && evalItem.score < 30) {
                                        continue;
                                    }

                                    addedUrls.add(video.url);
                                    video.thumbnailScore = evalItem?.score || (idx === thumbnailAnalysis.best_index ? thumbnailAnalysis.best_score : 50);
                                    video.thumbnailShows = evalItem?.shows || thumbnailAnalysis.best_reason || '';
                                    video.isBestThumbnail = (idx === thumbnailAnalysis.best_index);

                                    thumbnailFilteredVideos.push(video);
                                }
                            }
                        }

                        // If still not enough videos, add more from the original list
                        if (thumbnailFilteredVideos.length < 3) {
                            for (let i = 0; i < successfulDownloads.length && thumbnailFilteredVideos.length < 5; i++) {
                                const video = successfulDownloads[i].video;
                                if (!addedUrls.has(video.url)) {
                                    addedUrls.add(video.url);
                                    video.thumbnailScore = 35; // Default score
                                    video.thumbnailShows = 'Fallback option';
                                    thumbnailFilteredVideos.push(video);
                                }
                            }
                        }

                        // If we don't have enough good videos, flag for scroll/more search
                        if (thumbnailFilteredVideos.length < 3) {
                            console.log(`   ⚠️ Not enough good matches found (${thumbnailFilteredVideos.length}/3)`);
                            results.needsMoreSearch = true;
                        }

                        // Log ranked results
                        console.log(`   Ranked videos by thumbnail analysis:`);
                        thumbnailFilteredVideos.slice(0, 5).forEach((v, i) => {
                            const score = v.thumbnailScore || 0;
                            const best = v.isBestThumbnail ? ' ⭐ BEST' : '';
                            const shows = v.thumbnailShows || 'N/A';
                            console.log(`      [${i + 1}] Score: ${score}${best} - "${v.title?.substring(0, 35)}..." | ${shows}`);
                        });

                        results.thumbnailAnalysis = thumbnailAnalysis;

                        // CHECK: Fast-track based on score
                        const bestVideo = thumbnailFilteredVideos[0];
                        if (bestVideo && bestVideo.thumbnailScore >= 75) {
                            console.log(`\n   🚀 HIGH CONFIDENCE (${bestVideo.thumbnailScore}%) - Fast-tracking`);
                            results.fastTrack = true;
                            results.fastTrackReason = `Thumbnail score: ${bestVideo.thumbnailScore}%`;
                        } else if (bestVideo && bestVideo.thumbnailScore >= 55) {
                            console.log(`\n   📋 Medium confidence (${bestVideo.thumbnailScore}%) - Verifying with text`);
                            results.needsTextVerification = true;
                        } else {
                            console.log(`\n   ⚠️ Low confidence (${bestVideo?.thumbnailScore || 0}%) - Full analysis needed`);
                        }
                    }
                } catch (error) {
                    console.error(`   Thumbnail analysis failed: ${error.message}`);
                    onProgress({
                        stage: 2.5,
                        message: `[Thumbnails] Analysis failed: ${error.message?.substring(0, 50)}`,
                        error: true
                    });
                }
            } else {
                console.log(`   Skipping thumbnail analysis - not enough thumbnails`);
            }

            results.timings.stage25 = Date.now() - startStage25;
            const filteredCount = thumbnailFilteredVideos.length;
            const originalCount = allVideos.length;

            console.log(`   ✓ Thumbnail filtering: ${filteredCount} videos selected from ${originalCount} in ${(results.timings.stage25 / 1000).toFixed(1)}s`);
            onProgress({
                stage: 2.5,
                message: `[Thumbnails] ✓ ${filteredCount} relevant videos identified in ${(results.timings.stage25 / 1000).toFixed(1)}s`,
                complete: true
            });

            // Check for skip
            checkSkip();

            // ================================================================
            // FAST-TRACK: If thumbnail analysis found high-confidence match, skip deep analysis
            // ================================================================
            if (results.fastTrack && thumbnailFilteredVideos.length > 0) {
                const bestVideo = thumbnailFilteredVideos[0];
                console.log('\n' + '='.repeat(70));
                console.log('🚀 FAST-TRACK MODE - Skipping deep analysis');
                console.log('='.repeat(70));
                console.log(`   Best video: "${bestVideo.title?.substring(0, 50)}..."`);
                console.log(`   Thumbnail score: ${bestVideo.thumbnailScore}%`);
                console.log(`   Shows: ${bestVideo.thumbnailShows}`);

                onProgress({
                    stage: 'fast-track',
                    message: `🚀 High confidence match found! Score: ${bestVideo.thumbnailScore}%`
                });

                // Set up the winner directly using thumbnail analysis
                bestVideo.finalScore = bestVideo.thumbnailScore;
                bestVideo.textScore = { score: bestVideo.thumbnailScore };
                bestVideo.visualAnalysis = {
                    relevance_score: bestVideo.thumbnailScore,
                    recommendation: 'ACCEPT',
                    reason: bestVideo.thumbnailShows
                };

                // CRITICAL FIX: Fast Track skips deep analysis, so we MUST extract mandatoryCredit manually
                // REVERTED per user request: Skipping metadata extraction to preserve maximum speed.
                // Note: This means mandatoryCredit will be missing for Fast Track videos.
                console.log(`\n   🔎 FAST-TRACK: Skipping metadata extraction (Speed Priority)`);

                // Prepare final ranking with just the top videos from thumbnail analysis
                const finalRanking = thumbnailFilteredVideos.slice(0, 5).map((v, idx) => ({
                    ...v,
                    finalScore: v.thumbnailScore || 50,
                    textScoreNum: v.thumbnailScore || 50,
                    visualScore: v.thumbnailScore || 50,
                    matchBonus: 0,
                    matchPenalty: 0
                }));

                results.videos = finalRanking;

                // ANTI-REPEAT: Select best video that wasn't recently used
                results.winner = this.selectBestVideoAvoidingRepeats(finalRanking);
                if (results.winner) {
                    this.markVideoAsUsed(results.winner.url);
                }

                results.timings.total = Date.now() - startTotal;

                console.log(`\nFAST-TRACK complete in ${(results.timings.total / 1000).toFixed(1)}s`);
                console.log(`Winner: "${results.winner?.title?.substring(0, 50)}..." (Score: ${results.winner?.finalScore})`);

                onProgress({
                    stage: 6,
                    message: `Winner: Score ${results.winner?.finalScore} | "${results.winner?.title?.substring(0, 35)}..."`,
                    winner: {
                        title: results.winner?.title?.substring(0, 50),
                        finalScore: results.winner?.finalScore,
                        thumbnailScore: results.winner?.thumbnailScore
                    }
                });

                return results;
            }

            // ================================================================
            // STAGE 2.7: QUICK TEXT VERIFICATION (when Vision score is medium)
            // Compare segment text with video titles to verify relevance
            // ================================================================
            if (results.needsTextVerification && thumbnailFilteredVideos.length > 0) {
                console.log('\n[STAGE 2.7] Quick Text Verification...');
                const startStage27 = Date.now();

                // Extract key terms from headline and text for comparison
                const segmentKeywords = (headline + ' ' + text)
                    .toLowerCase()
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .split(/\s+/)
                    .filter(w => w.length > 3)
                    .slice(0, 20);

                // Score each video by title keyword matching
                for (const video of thumbnailFilteredVideos) {
                    const titleLower = (video.title || '').toLowerCase();
                    let keywordMatches = 0;
                    for (const keyword of segmentKeywords) {
                        if (titleLower.includes(keyword)) {
                            keywordMatches++;
                        }
                    }
                    video.textMatchScore = Math.round((keywordMatches / Math.min(segmentKeywords.length, 10)) * 100);

                    // Combine thumbnail score with text match
                    const combinedScore = Math.round(video.thumbnailScore * 0.6 + video.textMatchScore * 0.4);
                    video.thumbnailScore = combinedScore;

                    console.log(`   [${video.textMatchScore}% text match] "${video.title?.substring(0, 40)}..."`);
                }

                // Re-sort by combined score
                thumbnailFilteredVideos.sort((a, b) => b.thumbnailScore - a.thumbnailScore);

                // Check if top video now has high enough score
                const topVideo = thumbnailFilteredVideos[0];
                if (topVideo && topVideo.thumbnailScore >= 70) {
                    console.log(`\n   🚀 Text verification passed (${topVideo.thumbnailScore}%) - Fast-tracking`);
                    results.fastTrack = true;
                    results.fastTrackReason = `Combined score: ${topVideo.thumbnailScore}%`;
                }

                results.timings.stage27 = Date.now() - startStage27;
                console.log(`   Completed in ${results.timings.stage27}ms`);
            }

            // If fast-track after text verification, return early
            if (results.fastTrack && thumbnailFilteredVideos.length > 0) {
                const bestVideo = thumbnailFilteredVideos[0];

                bestVideo.finalScore = bestVideo.thumbnailScore;
                bestVideo.textScore = { score: bestVideo.thumbnailScore };
                bestVideo.visualAnalysis = {
                    relevance_score: bestVideo.thumbnailScore,
                    recommendation: 'ACCEPT',
                    reason: bestVideo.thumbnailShows
                };

                const finalRanking = thumbnailFilteredVideos.slice(0, 5).map((v, idx) => ({
                    ...v,
                    finalScore: v.thumbnailScore || 50,
                    textScoreNum: v.thumbnailScore || 50,
                    visualScore: v.thumbnailScore || 50,
                    matchBonus: 0,
                    matchPenalty: 0
                }));

                results.videos = finalRanking;
                results.winner = finalRanking[0];
                results.timings.total = Date.now() - startTotal;

                console.log(`\nFAST-TRACK complete in ${(results.timings.total / 1000).toFixed(1)}s`);
                console.log(`Winner: "${results.winner.title?.substring(0, 50)}..." (Score: ${results.winner.finalScore})`);

                onProgress({
                    stage: 6,
                    message: `Winner: Score ${results.winner.finalScore} | "${results.winner.title?.substring(0, 35)}..."`,
                    winner: {
                        title: results.winner.title?.substring(0, 50),
                        finalScore: results.winner.finalScore,
                        thumbnailScore: results.winner.thumbnailScore
                    }
                });

                return results;
            }

            // ================================================================
            // STAGE 3: DEEP VIDEO ANALYSIS - Extract metadata + screenshots
            // Only runs if no high-confidence thumbnail match was found
            // ================================================================
            console.log('\n[STAGE 3] Deep Video Analysis (PARALLEL MODE - 3 pages)...');
            const startStage3 = Date.now();

            // Use thumbnail-filtered videos instead of all videos
            const videosToAnalyze = thumbnailFilteredVideos.slice(0, maxVideosToAnalyze);
            const PARALLEL_PAGES = 5; // Increased from 3 to 5 for faster analysis
            const totalVideos = videosToAnalyze.length;

            // Send clear initial message
            onProgress({
                stage: 3,
                message: `[Deep Analysis] Extracting metadata from ${totalVideos} videos using ${PARALLEL_PAGES} parallel pages...`
            });

            // Helper function to analyze a single video on a given page
            // Returns result WITHOUT sending progress (we batch progress updates)
            const analyzeVideoOnPage = async (video, pageInstance, videoIndex) => {
                const shortTitle = (video.title || '').substring(0, 40);

                try {
                    // OPTIMIZED: Use domcontentloaded instead of networkidle (faster)
                    await pageInstance.goto(video.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
                    await pageInstance.waitForSelector('h1', { timeout: 5000 }).catch(() => { });
                    // OPTIMIZED: Reduced from 800ms to 400ms
                    await pageInstance.waitForTimeout(400);

                    // Expand collapsible sections (Shot list AND Meta data)
                    // CRITICAL: "Mandatory credit" is inside "Meta data" which is collapsed by default
                    const expandedSections = await pageInstance.evaluate(() => {
                        const expanded = { shotList: false, metaData: false };
                        const allElements = document.querySelectorAll('*');

                        for (const el of allElements) {
                            if (el.childNodes.length === 1) {
                                const text = el.textContent.trim();

                                // Expand "Shot list" section
                                if (text === 'Shot list' && !expanded.shotList) {
                                    let sibling = el.nextElementSibling;
                                    if (sibling && sibling.tagName === 'BUTTON') {
                                        sibling.click();
                                        expanded.shotList = true;
                                    } else {
                                        const parent = el.parentElement;
                                        if (parent) {
                                            sibling = parent.nextElementSibling;
                                            if (sibling && sibling.tagName === 'BUTTON') {
                                                sibling.click();
                                                expanded.shotList = true;
                                            }
                                        }
                                    }
                                }

                                // Expand "Meta data" section (contains Mandatory credit)
                                if (text === 'Meta data' && !expanded.metaData) {
                                    let sibling = el.nextElementSibling;
                                    if (sibling && sibling.tagName === 'BUTTON') {
                                        sibling.click();
                                        expanded.metaData = true;
                                    } else {
                                        const parent = el.parentElement;
                                        if (parent) {
                                            sibling = parent.nextElementSibling;
                                            if (sibling && sibling.tagName === 'BUTTON') {
                                                sibling.click();
                                                expanded.metaData = true;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        return expanded;
                    });

                    if (expandedSections.shotList || expandedSections.metaData) {
                        // Wait for accordion animations
                        await pageInstance.waitForTimeout(300);
                        console.log(`[VioryDownloader] Expanded sections: Shot list=${expandedSections.shotList}, Meta data=${expandedSections.metaData}`);
                    }

                    // Extract metadata - EXACT SAME LOGIC (unchanged for result consistency)
                    const metadata = await pageInstance.evaluate(() => {
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
                        const creditMatch = bodyText.match(/[Mm]andatory\s*credit[:\s]+([^\n]+)/);
                        if (creditMatch && creditMatch[1]) {
                            let credit = creditMatch[1].trim();
                            credit = credit.replace(/[;].*$/, '').trim();
                            credit = credit.replace(/\/[A-Z].*$/i, '').trim();
                            credit = credit.replace(/\s*\/-.*$/, '').trim();
                            credit = credit.replace(/\s*\/\s*-.*$/, '').trim();
                            credit = credit.replace(/\s+-\s+.*$/, '').trim();
                            credit = credit.replace(/[.,;:\/]+$/, '').trim();
                            if (credit.length >= 3 && credit.length <= 100) {
                                result.mandatoryCredit = credit;
                                console.log('[VioryDownloader] DEBUG: Analyzed credit: "' + credit + '"');
                            } else {
                                console.log('[VioryDownloader] DEBUG: Rejected credit "' + credit + '" (length ' + credit.length + ')');
                            }
                        } else {
                            console.log('[VioryDownloader] DEBUG: No mandatory credit pattern match. Body snippet: ' + bodyText.substring(0, 500));
                        }

                        return result;
                    });

                    Object.assign(video, metadata);

                    // Capture screenshot
                    try {
                        const videoArea = await pageInstance.$('video, [class*="player"], [class*="video-container"], main img');
                        if (videoArea) {
                            const box = await videoArea.boundingBox();
                            if (box && box.width > 200) {
                                video.screenshot = await videoArea.screenshot({ type: 'png' });
                            }
                        }
                        if (!video.screenshot) {
                            video.screenshot = await pageInstance.screenshot({
                                type: 'png',
                                clip: { x: 300, y: 80, width: 900, height: 500 }
                            });
                        }
                    } catch (e) {
                        // Screenshot failed silently - will be logged in batch summary
                    }

                    return { success: true, video };

                } catch (error) {
                    return { success: false, video, error: error.message };
                }
            };

            // Create additional pages for parallel analysis
            const analysisPages = [page]; // Reuse main page as first
            try {
                for (let i = 1; i < PARALLEL_PAGES; i++) {
                    const newPage = await this.context.newPage();
                    analysisPages.push(newPage);
                }
                console.log(`   Created ${PARALLEL_PAGES} parallel analysis pages`);
            } catch (e) {
                console.warn(`   Could not create extra pages, falling back to sequential: ${e.message}`);
            }

            // Process videos in parallel batches with clear progress
            let videosCompleted = 0;
            const numBatches = Math.ceil(totalVideos / analysisPages.length);

            for (let batchNum = 0; batchNum < numBatches; batchNum++) {
                // Check for skip before each batch
                checkSkip();

                const batchStart = batchNum * analysisPages.length;
                const batchVideos = videosToAnalyze.slice(batchStart, batchStart + analysisPages.length);
                const batchSize = batchVideos.length;

                // Log batch with video titles
                const videoTitles = batchVideos.map(v => `"${(v.title || '').substring(0, 25)}"`).join(', ');
                console.log(`   [Batch ${batchNum + 1}/${numBatches}] Analyzing: ${videoTitles}`);
                onProgress({
                    stage: 3,
                    message: `[Deep Analysis] Batch ${batchNum + 1}/${numBatches}: ${videoTitles}`,
                    current: videosCompleted,
                    total: totalVideos
                });

                // Run parallel analysis for this batch
                const batchPromises = batchVideos.map((video, idx) => {
                    const pageToUse = analysisPages[idx % analysisPages.length];
                    const globalIndex = batchStart + idx;
                    return analyzeVideoOnPage(video, pageToUse, globalIndex);
                });

                const batchResults = await Promise.all(batchPromises);

                // Log batch results AFTER all complete (ordered)
                batchResults.forEach((result, idx) => {
                    const globalIndex = batchStart + idx;
                    const video = batchVideos[idx];
                    const shortTitle = (video.title || '').substring(0, 35);
                    const hasInfo = video.videoInfo ? `${video.videoInfo.length}ch` : '0';
                    const hasShot = video.shotList ? `${video.shotList.length}ch` : '0';
                    const hasScreenshot = video.screenshot ? '✓' : '✗';

                    if (result.success) {
                        console.log(`      [${globalIndex + 1}/${totalVideos}] ✓ "${shortTitle}..." | Info:${hasInfo} Shot:${hasShot} Img:${hasScreenshot}`);
                    } else {
                        console.log(`      [${globalIndex + 1}/${totalVideos}] ✗ "${shortTitle}..." | Error: ${result.error}`);
                    }
                });

                videosCompleted += batchSize;

                // Send progress update after batch completes
                onProgress({
                    stage: 3,
                    message: `[Deep Analysis] Completed ${videosCompleted}/${totalVideos} videos`,
                    current: videosCompleted,
                    total: totalVideos
                });

                // Small delay between batches to avoid any rate limiting
                if (batchNum + 1 < numBatches) {
                    await new Promise(r => setTimeout(r, 250));
                }
            }

            // Close extra pages (keep main page)
            for (let i = 1; i < analysisPages.length; i++) {
                try {
                    await analysisPages[i].close();
                } catch (e) {
                    // Ignore close errors
                }
            }

            results.timings.stage3 = Date.now() - startStage3;
            const timePerVideo = (results.timings.stage3 / totalVideos).toFixed(0);
            console.log(`   ✓ Deep Analysis complete: ${totalVideos} videos in ${(results.timings.stage3 / 1000).toFixed(1)}s (${timePerVideo}ms/video avg)`);

            onProgress({
                stage: 3,
                message: `[Deep Analysis] ✓ Complete: ${totalVideos} videos analyzed in ${(results.timings.stage3 / 1000).toFixed(1)}s`,
                complete: true
            });

            // Check for user skip request before scoring
            checkSkip();

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
            // Analyzes each video individually for maximum accuracy
            // Uses parallel processing (2 at a time) for speed
            // ================================================================
            console.log('\n[STAGE 5] Visual Validation with Gemini Vision...');

            // Check if we need to match a specific person
            // Use PERSONA mode if:
            // 1. AI detected an important person in the segment (analysis.has_important_person)
            // 2. OR segment frame confirmed the person (segmentPersonConfirmed)
            const requiresPersonMatch = (analysis.has_important_person === true || results.segmentPersonConfirmed === true) && analysis.person_name;
            const personToMatch = analysis.person_name;
            const personConfirmedByFrame = results.segmentPersonConfirmed === true;

            if (requiresPersonMatch) {
                if (personConfirmedByFrame) {
                    console.log(`   [MODO PERSONA - CONFIRMADO] Buscando videos que muestren a: ${personToMatch} (confirmado en frame)`);
                } else {
                    console.log(`   [MODO PERSONA - AI] Buscando videos que muestren a: ${personToMatch} (detectado por AI)`);
                }
            } else {
                console.log(`   [MODO FOOTAGE] Buscando videos relevantes al tema`);
            }

            const startStage5 = Date.now();
            const topVideos = videosToAnalyze.slice(0, topNForVisualValidation);

            console.log(`   Analizando ${topVideos.length} videos por relevancia...`);
            onProgress({
                stage: 5,
                message: `[Vision] Analyzing ${topVideos.length} videos...`,
                matchMode: requiresPersonMatch ? 'person' : 'footage',
                personToMatch: personToMatch
            });

            // Helper function to build the vision prompt for a single video
            const buildVisionPrompt = (video) => {
                if (requiresPersonMatch) {
                    // Build a list of common "wrong persons" to help the model
                    const wrongPersonExamples = {
                        'trump': ['Biden', 'Putin', 'Xi Jinping', 'Macron', 'Zelensky', 'Iranian officials', 'Chinese officials', 'European leaders', 'protesters'],
                        'putin': ['Zelensky', 'Biden', 'Trump', 'NATO officials', 'Ukrainian soldiers', 'European leaders', 'protesters'],
                        'netanyahu': ['Palestinian officials', 'Hamas leaders', 'Iranian officials', 'protesters', 'UN officials', 'Biden'],
                        'biden': ['Trump', 'Putin', 'Xi Jinping', 'Republicans', 'protesters'],
                        'zelensky': ['Putin', 'Russian officials', 'soldiers', 'refugees'],
                        'xi': ['Biden', 'Trump', 'Taiwanese officials', 'protesters']
                    };

                    const personLower = personToMatch.toLowerCase();
                    let wrongPersons = ['other politicians', 'protesters', 'crowds', 'officials'];

                    // Find specific wrong persons based on target
                    for (const [key, examples] of Object.entries(wrongPersonExamples)) {
                        if (personLower.includes(key)) {
                            wrongPersons = examples;
                            break;
                        }
                    }

                    // Determine expected country/setting for this person
                    const personCountryMap = {
                        'trump': { country: 'USA', flags: 'American flag', settings: 'White House, US Capitol, Mar-a-Lago' },
                        'biden': { country: 'USA', flags: 'American flag', settings: 'White House, US Capitol' },
                        'putin': { country: 'Russia', flags: 'Russian flag', settings: 'Kremlin, Russian government buildings' },
                        'zelensky': { country: 'Ukraine', flags: 'Ukrainian flag', settings: 'Kyiv, Ukrainian government' },
                        'netanyahu': { country: 'Israel', flags: 'Israeli flag', settings: 'Knesset, Israeli government' },
                        'macron': { country: 'France', flags: 'French flag', settings: 'Elysee Palace' },
                        'xi': { country: 'China', flags: 'Chinese flag', settings: 'Great Hall of the People, Beijing' }
                    };

                    let expectedCountry = 'USA';
                    let expectedFlags = 'country flags matching the person';
                    let expectedSettings = 'official government setting';

                    for (const [key, info] of Object.entries(personCountryMap)) {
                        if (personLower.includes(key)) {
                            expectedCountry = info.country;
                            expectedFlags = info.flags;
                            expectedSettings = info.settings;
                            break;
                        }
                    }

                    return `═══════════════════════════════════════════════════════════════════════
PERSON IDENTIFICATION TASK
═══════════════════════════════════════════════════════════════════════

TARGET PERSON: "${personToMatch}"
EXPECTED COUNTRY: ${expectedCountry}
EXPECTED SETTING: ${expectedSettings}
${analysis.person_description ? `DESCRIPTION: ${analysis.person_description}` : ''}

Look at this video screenshot and answer TWO things:
1. Is ${personToMatch} VISIBLE in this image?
2. Are the FLAGS/SETTING correct for ${personToMatch}? (Should be ${expectedFlags})

═══════════════════════════════════════════════════════════════════════
⚠️ FLAG/COUNTRY CHECK - VERY IMPORTANT:
═══════════════════════════════════════════════════════════════════════
If looking for ${personToMatch}, the background should show ${expectedFlags}.

WRONG FLAGS = WRONG VIDEO, even if a politician is visible:
- Slovak flag (white-blue-red with coat of arms) ≠ USA
- EU flag (blue with yellow stars) ≠ USA  
- Any European country flag ≠ USA (unless topic is about Europe)
- Middle Eastern flags ≠ USA

═══════════════════════════════════════════════════════════════════════
IDENTIFICATION RULES:
═══════════════════════════════════════════════════════════════════════

✅ ACCEPT (score 85-100):
- ${personToMatch} is clearly visible AND recognizable
- Background shows correct flags/setting (${expectedFlags})
- Close-up, medium shot, or at podium/desk

⚠️ REVIEW (score 50-70):
- ${personToMatch} might be present but image is unclear
- OR correct person but flags/setting not visible

❌ REJECT (score 0-30):
- Shows DIFFERENT politician (${wrongPersons.slice(0, 4).join(', ')})
- Shows WRONG FLAGS (European, Asian, Middle Eastern when expecting ${expectedFlags})
- Shows crowd/protesters
- Shows military/officials without ${personToMatch}
- No people visible, just buildings/flags/graphics

═══════════════════════════════════════════════════════════════════════
VIDEO CONTEXT:
═══════════════════════════════════════════════════════════════════════
Title: ${video.title}

═══════════════════════════════════════════════════════════════════════
RESPOND WITH JSON ONLY:
═══════════════════════════════════════════════════════════════════════
{
  "shows_target_person": true/false,
  "person_identified": "WHO is actually visible? Be specific - name them if recognizable",
  "identification_confidence": 0.0-1.0,
  "flags_visible": "What flags are visible in the image? (be specific)",
  "flags_match_expected": true/false,
  "wrong_country_flags": "Country name if wrong flags visible, else null",
  "is_crowd_or_protest": true/false,
  "is_different_politician": true/false,
  "different_politician_name": "Name if showing different politician, else null",
  "relevance_score": 0-100,
  "recommendation": "ACCEPT/REVIEW/REJECT",
  "reason": "One sentence explanation"
}`;
                } else {
                    // FOOTAGE MODE - Country/Location is CRITICAL
                    // Build list of commonly confused countries
                    const confusedCountries = {
                        'israel': ['UAE', 'Abu Dhabi', 'Dubai', 'Qatar', 'Saudi Arabia', 'Jordan', 'Egypt'],
                        'iran': ['UAE', 'Iraq', 'Saudi Arabia', 'Turkey', 'Pakistan'],
                        'usa': ['Canada', 'UK', 'Australia', 'European countries'],
                        'russia': ['Ukraine', 'Belarus', 'Kazakhstan', 'Eastern European countries'],
                        'china': ['Japan', 'South Korea', 'Taiwan', 'Hong Kong', 'Singapore']
                    };

                    const requiredCountry = (analysis.country || '').toLowerCase();
                    let wrongCountryExamples = [];
                    for (const [country, confused] of Object.entries(confusedCountries)) {
                        if (requiredCountry.includes(country)) {
                            wrongCountryExamples = confused;
                            break;
                        }
                    }

                    return `═══════════════════════════════════════════════════════════════════════
FOOTAGE RELEVANCE ANALYSIS - COUNTRY VERIFICATION IS CRITICAL
═══════════════════════════════════════════════════════════════════════

NEWS TOPIC: ${analysis.main_subject}
REQUIRED COUNTRY: ${analysis.country || 'Not specified'}
${analysis.secondary_country ? `SECONDARY COUNTRY: ${analysis.secondary_country}` : ''}
${analysis.location_keywords ? `SPECIFIC LOCATIONS: ${(analysis.location_keywords || []).join(', ')}` : ''}
KEY VISUALS NEEDED: ${analysis.key_visuals?.join(', ') || 'General footage'}
MUST SHOW: ${analysis.must_show?.join(', ') || 'Related content'}
AVOID: ${analysis.avoid?.join(', ') || 'Nothing specific'}

VIDEO BEING EVALUATED:
Title: ${video.title}
Description: ${(video.videoInfo || '').substring(0, 400)}
Shot list: ${(video.shotList || '').substring(0, 300)}

═══════════════════════════════════════════════════════════════════════
⚠️ CRITICAL: COUNTRY/LOCATION VERIFICATION
═══════════════════════════════════════════════════════════════════════

STEP 1: Identify what country/location this footage is from:
- Look for FLAGS (most important indicator)
- Look for RECOGNIZABLE LANDMARKS/SKYLINES:
  * Abu Dhabi/UAE: Etihad Towers, Emirates Palace, modern skyscrapers
  * Dubai: Burj Khalifa, Palm Jumeirah
  * Israel: Tel Aviv skyline, Jerusalem Old City, Hebrew text
  * Iran: Persian architecture, Farsi text, Iranian flags
- Look for SIGNS/TEXT (language, alphabet - Hebrew, Arabic, Persian, etc.)
- Look for ARCHITECTURE style

STEP 2: Compare with required country (${analysis.country || 'unknown'})
${wrongCountryExamples.length > 0 ? `
⚠️ COMMONLY CONFUSED - Do NOT accept footage from:
${wrongCountryExamples.map(c => `- ${c}`).join('\n')}
` : ''}

═══════════════════════════════════════════════════════════════════════
SCORING RULES - COUNTRY MATCH IS #1 PRIORITY:
═══════════════════════════════════════════════════════════════════════

✅ CORRECT COUNTRY + CORRECT TOPIC (85-100):
- Footage clearly from ${analysis.country || 'required country'}
- Shows relevant content (${analysis.key_visuals?.slice(0, 2).join(', ') || 'topic-related'})

⚠️ UNCERTAIN COUNTRY + CORRECT TOPIC (50-70):
- Cannot verify country from image
- But topic/content seems relevant

❌ WRONG COUNTRY (0-30) - AUTOMATIC REJECT:
- Footage shows flags/landmarks from DIFFERENT country
- UAE/Dubai skyline when topic is about Israel → 5-15
- Abu Dhabi landmarks when topic is about Iran → 5-15
- European city when topic is about Middle East → 10-20
- Any clearly wrong location → REJECT

❌ WRONG TOPIC (0-40):
- Footage from correct country but wrong topic
- E.g., sports event when topic is diplomacy

═══════════════════════════════════════════════════════════════════════
RESPOND WITH JSON ONLY:
═══════════════════════════════════════════════════════════════════════
{
  "shows_relevant_content": true/false,
  "detected_country": "What country does this footage appear to be from? (based on flags, landmarks, architecture)",
  "detected_landmarks": "Any recognizable landmarks or skylines? (be specific)",
  "country_match": true/false/unknown,
  "country_confidence": 0.0-1.0,
  "wrong_country_detected": "Name of wrong country if visible (e.g., 'UAE' when expecting 'Israel'), else null",
  "detected_elements": ["element1", "element2", "element3"],
  "context_match": "exact/related/loose/none",
  "relevance_score": 0-100,
  "recommendation": "ACCEPT/REVIEW/REJECT",
  "reason": "Brief explanation focusing on country match and content relevance"
}`;
                }
            };

            // Helper function to process vision result
            const processVisionResult = (video, visionText, videoIndex) => {
                let visual;
                try {
                    visual = JSON.parse(visionText.replace(/```json\n?|```/g, '').trim());
                } catch (parseError) {
                    visual = {
                        shows_relevant_content: false,
                        relevance_score: 30,
                        recommendation: 'REVIEW',
                        reason: 'Could not parse vision response'
                    };
                }

                // Process results based on mode
                if (requiresPersonMatch) {
                    // Check if target person is shown
                    const showsTarget = visual.shows_target_person === true || visual.shows_person === true;
                    const personIdentified = (visual.person_identified || '').toLowerCase();
                    const targetName = personToMatch.toLowerCase();
                    const targetFirstName = targetName.split(' ')[0];
                    const targetLastName = targetName.split(' ').pop();

                    // Check if identified person matches target
                    const nameMatches = personIdentified.includes(targetFirstName) ||
                        personIdentified.includes(targetLastName) ||
                        personIdentified.includes(targetName);

                    // Use identification_confidence if available, fallback to confidence
                    const confidence = visual.identification_confidence || visual.confidence || 0;

                    const isPersonMatch = showsTarget && nameMatches && confidence >= 0.6;
                    const isCrowdOrProtest = visual.is_crowd_or_protest === true;
                    const isDifferentPolitician = visual.is_different_politician === true;

                    // NEW: Check for wrong country flags (even if person seems correct)
                    const hasWrongFlags = visual.flags_match_expected === false || visual.wrong_country_flags;
                    const wrongFlagsCountry = visual.wrong_country_flags;

                    // FIRST: Check for wrong flags - this is a STRONG rejection signal
                    if (hasWrongFlags && wrongFlagsCountry) {
                        // Wrong country flags visible - REJECT even if a politician is visible
                        visual.relevance_score = Math.min(visual.relevance_score || 100, 12);
                        visual.recommendation = 'REJECT';
                        visual.person_match = false;
                        visual.wrong_flags_detected = wrongFlagsCountry;
                        console.log(`         ✗ RECHAZADO: Banderas incorrectas (${wrongFlagsCountry}) - NO es ${personToMatch}`);
                    } else if (isPersonMatch) {
                        // Target person found with correct flags!
                        visual.relevance_score = Math.max(visual.relevance_score || 0, 90);
                        visual.recommendation = 'ACCEPT';
                        visual.person_match = true;
                        console.log(`         ✓ PERSONA ENCONTRADA: ${personToMatch} (${(confidence * 100).toFixed(0)}% confidence)`);
                    } else if (isDifferentPolitician) {
                        // Different politician detected - STRONG REJECT
                        visual.relevance_score = Math.min(visual.relevance_score || 100, 10);
                        visual.recommendation = 'REJECT';
                        visual.person_match = false;
                        console.log(`         ✗ RECHAZADO: Muestra a ${visual.different_politician_name || personIdentified}, NO a ${personToMatch}`);
                    } else if (isCrowdOrProtest) {
                        // Crowd/protest - REJECT hard
                        visual.relevance_score = Math.min(visual.relevance_score || 100, 15);
                        visual.recommendation = 'REJECT';
                        visual.person_match = false;
                        console.log(`         ✗ RECHAZADO: Muestra multitud/protesta, no a ${personToMatch}`);
                    } else if (showsTarget && confidence >= 0.4) {
                        // Possibly the person but not sure
                        visual.relevance_score = Math.min(visual.relevance_score || 100, 50);
                        visual.recommendation = 'REVIEW';
                        visual.person_match = 'possible';
                        console.log(`         ? REVISAR: Posiblemente ${personToMatch} (${(confidence * 100).toFixed(0)}% confidence)`);
                    } else {
                        // Wrong person or no person - REJECT
                        visual.relevance_score = Math.min(visual.relevance_score || 100, 25);
                        visual.recommendation = 'REJECT';
                        visual.person_match = false;
                        console.log(`         ✗ RECHAZADO: No muestra a ${personToMatch} (detectado: ${personIdentified || 'nadie'})`);
                    }
                    visual.person_detected = visual.person_identified;
                    visual.confidence = confidence;
                    visual.flags_visible = visual.flags_visible || null;
                } else {
                    // FOOTAGE MODE - Country verification is critical
                    const contextMatch = visual.context_match || 'none';
                    const countryMatch = visual.country_match;
                    const wrongCountry = visual.wrong_country_detected;
                    const detectedCountry = visual.detected_country || 'unknown';
                    const countryConfidence = visual.country_confidence || 0;
                    const requiredCountry = (analysis.country || '').toLowerCase();

                    // Check if detected country matches required country
                    const detectedCountryLower = detectedCountry.toLowerCase();
                    const isCountryMatch = countryMatch === true ||
                        (requiredCountry && detectedCountryLower.includes(requiredCountry.split('/')[0])) ||
                        (analysis.secondary_country && detectedCountryLower.includes(analysis.secondary_country.toLowerCase()));

                    // STRONG REJECTION: Wrong country explicitly detected
                    if (wrongCountry || (countryMatch === false && countryConfidence >= 0.6)) {
                        visual.relevance_score = Math.min(visual.relevance_score || 100, 15);
                        visual.recommendation = 'REJECT';
                        visual.country_rejected = true;
                        console.log(`         ✗ RECHAZADO: País incorrecto detectado: "${wrongCountry || detectedCountry}" (requiere: ${analysis.country})`);
                    }
                    // Country matches - apply normal scoring
                    else if (isCountryMatch && contextMatch === 'exact') {
                        visual.relevance_score = Math.max(visual.relevance_score || 0, 85);
                        visual.recommendation = 'ACCEPT';
                        console.log(`         ✓ ACEPTADO: País correcto (${detectedCountry}) + tema exacto`);
                    }
                    else if (isCountryMatch && contextMatch === 'related') {
                        visual.relevance_score = Math.max(visual.relevance_score || 0, 70);
                        visual.recommendation = 'ACCEPT';
                        console.log(`         ✓ ACEPTADO: País correcto (${detectedCountry}) + tema relacionado`);
                    }
                    // Country unknown but content seems relevant
                    else if (countryMatch === 'unknown' || countryMatch === null) {
                        if (contextMatch === 'exact' || contextMatch === 'related') {
                            visual.relevance_score = Math.min(visual.relevance_score || 100, 65);
                            visual.recommendation = 'REVIEW';
                            console.log(`         ? REVISAR: País incierto (${detectedCountry}), pero tema relevante`);
                        } else {
                            visual.relevance_score = Math.min(visual.relevance_score || 100, 40);
                            visual.recommendation = 'REJECT';
                            console.log(`         ✗ RECHAZADO: País incierto + tema no relacionado`);
                        }
                    }
                    // Country doesn't match
                    else if (!isCountryMatch) {
                        visual.relevance_score = Math.min(visual.relevance_score || 100, 25);
                        visual.recommendation = 'REJECT';
                        visual.country_rejected = true;
                        console.log(`         ✗ RECHAZADO: País no coincide - detectado: "${detectedCountry}", requiere: "${analysis.country}"`);
                    }
                    // Default case
                    else {
                        if (visual.relevance_score >= 75) {
                            visual.recommendation = 'ACCEPT';
                        } else if (visual.relevance_score >= 55) {
                            visual.recommendation = 'REVIEW';
                        } else {
                            visual.recommendation = 'REJECT';
                        }
                    }

                    visual.detected_country = detectedCountry;
                }

                return {
                    success: true,
                    ...visual,
                    matchMode: requiresPersonMatch ? 'person' : 'footage'
                };
            };

            // Helper function to analyze a single video
            const analyzeVideoVisually = async (video, videoIndex) => {
                if (!video.screenshot) {
                    console.log(`      [Vision] Video ${videoIndex + 1}: NO SCREENSHOT - skipping`);
                    return { video, videoIndex, success: false, error: 'no_screenshot' };
                }

                try {
                    const screenshotSize = video.screenshot.length;
                    console.log(`      [Vision] Video ${videoIndex + 1}: Sending ${(screenshotSize / 1024).toFixed(1)}KB image to Gemini...`);

                    const visionPrompt = buildVisionPrompt(video);
                    const visionResult = await visionModel.generateContent([
                        { inlineData: { mimeType: 'image/png', data: video.screenshot.toString('base64') } },
                        visionPrompt
                    ]);

                    const visionText = visionResult.response.text();
                    console.log(`      [Vision] Video ${videoIndex + 1}: Got response (${visionText.length} chars)`);

                    const visualAnalysis = processVisionResult(video, visionText, videoIndex);

                    return { video, videoIndex, success: true, visualAnalysis };
                } catch (error) {
                    console.error(`      [Vision] Video ${videoIndex + 1}: ERROR - ${error.message}`);
                    return { video, videoIndex, success: false, error: error.message };
                }
            };

            // Process videos in parallel batches of 2 (conservative to avoid Gemini rate limiting)
            const VISION_PARALLEL = 2;
            let analyzedCount = 0;
            const allResults = [];

            for (let batch = 0; batch < topVideos.length; batch += VISION_PARALLEL) {
                checkSkip();

                const batchVideos = topVideos.slice(batch, batch + VISION_PARALLEL);
                const batchNum = Math.floor(batch / VISION_PARALLEL) + 1;
                const totalBatches = Math.ceil(topVideos.length / VISION_PARALLEL);

                // Log batch with video titles being analyzed
                const videoTitles = batchVideos.map(v => `"${(v.title || '').substring(0, 25)}"`).join(', ');
                console.log(`   [Batch ${batchNum}/${totalBatches}] Analyzing: ${videoTitles}`);

                onProgress({
                    stage: 5,
                    message: `[Vision] Batch ${batchNum}/${totalBatches}: ${videoTitles}`,
                    current: batch,
                    total: topVideos.length
                });

                // Run batch in parallel
                const batchPromises = batchVideos.map((video, idx) => {
                    const globalIndex = batch + idx;
                    return analyzeVideoVisually(video, globalIndex);
                });

                const batchResults = await Promise.all(batchPromises);

                // Process results and log in order
                for (const result of batchResults) {
                    const { video, videoIndex, success, visualAnalysis, error } = result;
                    const shortTitle = (video.title || '').substring(0, 35);

                    if (success && visualAnalysis) {
                        video.visualAnalysis = visualAnalysis;
                        analyzedCount++;

                        const symbol = visualAnalysis.recommendation === 'ACCEPT' ? '✓' :
                            visualAnalysis.recommendation === 'REVIEW' ? '?' : '✗';
                        console.log(`      [${videoIndex + 1}/${topVideos.length}] ${symbol} ${visualAnalysis.recommendation}: Relevancia ${visualAnalysis.relevance_score}% - "${shortTitle}..."`);
                    } else {
                        video.visualAnalysis = { success: false };
                        console.log(`      [${videoIndex + 1}/${topVideos.length}] ✗ Error: ${error || 'unknown'} - "${shortTitle}..."`);
                    }

                    allResults.push(result);
                }

                // Small delay between batches to avoid rate limiting (only if more batches)
                if (batch + VISION_PARALLEL < topVideos.length) {
                    await new Promise(r => setTimeout(r, 300));
                }
            }

            // Send final progress with summary
            const acceptCount = allResults.filter(r => r.visualAnalysis?.recommendation === 'ACCEPT').length;
            const reviewCount = allResults.filter(r => r.visualAnalysis?.recommendation === 'REVIEW').length;
            const rejectCount = allResults.filter(r => r.visualAnalysis?.recommendation === 'REJECT').length;

            results.timings.stage5 = Date.now() - startStage5;
            console.log(`   ✓ Vision analysis complete: ${analyzedCount}/${topVideos.length} in ${(results.timings.stage5 / 1000).toFixed(1)}s (${acceptCount} accept, ${reviewCount} review, ${rejectCount} reject)`);

            onProgress({
                stage: 5,
                message: `[Vision] ✓ Complete: ${acceptCount} accept, ${reviewCount} review, ${rejectCount} reject (${(results.timings.stage5 / 1000).toFixed(1)}s)`,
                complete: true
            });

            // ================================================================
            // STAGE 6: FINAL RANKING
            // Different scoring strategies for PERSON vs FOOTAGE mode
            // ================================================================
            console.log('\n[STAGE 6] Final Ranking...');
            const rankingMode = requiresPersonMatch ? 'PERSON PRIORITY' : 'FOOTAGE PRIORITY';

            // For PERSON mode: visual is MORE important (we need to SEE the person)
            // For FOOTAGE mode: text and visual are balanced
            const textWeight = requiresPersonMatch ? 0.3 : 0.6;
            const visualWeight = requiresPersonMatch ? 0.7 : 0.4;

            onProgress({ stage: 6, message: `Combining scores (${rankingMode}) - ${Math.round(textWeight * 100)}% text, ${Math.round(visualWeight * 100)}% visual...` });
            const startStage6 = Date.now();

            const finalRanking = topVideos.map(v => {
                const textScore = v.textScore.score;
                const visualScore = v.visualAnalysis?.relevance_score || 0;
                const hasVisual = v.visualAnalysis?.success;
                const shortTitle = (v.title || '').substring(0, 30);

                // Base hybrid score with mode-specific weights
                let finalScore = hasVisual
                    ? Math.round(textScore * textWeight + visualScore * visualWeight)
                    : textScore;

                // Apply bonuses/penalties based on match mode
                let matchBonus = 0;
                let matchPenalty = 0;

                if (requiresPersonMatch && v.visualAnalysis) {
                    // PERSON MODE: Visual confirmation is critical
                    if (v.visualAnalysis.person_match === true) {
                        matchBonus = 30; // Big bonus for confirmed person match
                        console.log(`   [BONUS +30] "${shortTitle}..." - Person match confirmed: ${v.visualAnalysis.person_detected}`);
                    } else if (v.visualAnalysis.person_match === 'possible') {
                        matchBonus = 5; // Small bonus for possible match
                        console.log(`   [BONUS +5] "${shortTitle}..." - Possible person match`);
                    } else if (v.visualAnalysis.person_match === false) {
                        // CRITICAL: If looking for a specific person and video doesn't show them, heavy penalty
                        matchPenalty = 50; // Very heavy penalty - we need the RIGHT person
                        console.log(`   [PENALTY -50] "${shortTitle}..." - Wrong person/crowd (not ${personToMatch})`);
                    }

                    // Extra penalty if Vision rejected with low score (crowds, protests, wrong people)
                    if (v.visualAnalysis.recommendation === 'REJECT' && visualScore < 30) {
                        matchPenalty += 20;
                        console.log(`   [PENALTY -20] "${shortTitle}..." - Vision strongly rejected (${visualScore}%)`);
                    }
                }

                // TEXT-BASED PERSON MATCH - person name found in video metadata
                if (v.textScore?.personMatchInText && requiresPersonMatch) {
                    matchBonus += 15; // Bonus for person name in text
                    console.log(`   [BONUS +15] "${shortTitle}..." - Person name in metadata`);
                } else if (!requiresPersonMatch && v.visualAnalysis) {
                    // FOOTAGE MODE: Country match is CRITICAL
                    const footageScore = v.visualAnalysis.relevance_score || visualScore;
                    const countryRejected = v.visualAnalysis.country_rejected === true;
                    const detectedCountry = v.visualAnalysis.detected_country || 'unknown';
                    const wrongCountry = v.visualAnalysis.wrong_country_detected;

                    // HEAVY PENALTY for wrong country
                    if (countryRejected || wrongCountry) {
                        matchPenalty = 60; // Very heavy penalty - WRONG COUNTRY
                        console.log(`   [PENALTY -60] "${shortTitle}..." - PAÍS INCORRECTO: "${wrongCountry || detectedCountry}" (requiere: ${analysis.country})`);
                    }
                    // Bonus for strong footage match with correct country
                    else if (footageScore >= 80) {
                        matchBonus = 20; // Bonus for strong footage match
                        console.log(`   [BONUS +20] "${shortTitle}..." - Footage fuerte + país correcto (${footageScore}%)`);
                    }
                    else if (footageScore >= 65) {
                        matchBonus = 10; // Small bonus for decent match
                        console.log(`   [BONUS +10] "${shortTitle}..." - Footage decente (${footageScore}%)`);
                    }
                    else if (footageScore < 40) {
                        matchPenalty = 30; // Penalty for weak footage match
                        console.log(`   [PENALTY -30] "${shortTitle}..." - Footage débil (${footageScore}%)`);
                    }
                }

                finalScore = Math.max(0, Math.min(100, finalScore + matchBonus - matchPenalty));

                console.log(`   Final: ${finalScore} (Text:${textScore} Visual:${visualScore}) - "${shortTitle}..."`)

                return {
                    ...v,
                    finalScore,
                    textScoreNum: textScore,
                    visualScore: hasVisual ? visualScore : null,
                    matchBonus,
                    matchPenalty,
                    personMatch: v.visualAnalysis?.person_match,
                    personDetected: v.visualAnalysis?.person_detected,
                    sceneMatchPercentage: v.visualAnalysis?.scene_match_percentage,
                    // Footage mode fields
                    detectedCountry: v.visualAnalysis?.detected_country,
                    countryRejected: v.visualAnalysis?.country_rejected,
                    wrongCountryDetected: v.visualAnalysis?.wrong_country_detected
                };
            });

            // Sort by final score, with special handling for each mode
            finalRanking.sort((a, b) => {
                if (requiresPersonMatch) {
                    // In person mode: true matches first, then possible, then others
                    const aMatch = a.personMatch === true ? 2 : (a.personMatch === 'possible' ? 1 : 0);
                    const bMatch = b.personMatch === true ? 2 : (b.personMatch === 'possible' ? 1 : 0);
                    if (aMatch !== bMatch) return bMatch - aMatch;
                } else {
                    // In footage mode: videos with wrong country go to the bottom
                    const aWrongCountry = a.visualAnalysis?.country_rejected === true ? 1 : 0;
                    const bWrongCountry = b.visualAnalysis?.country_rejected === true ? 1 : 0;
                    if (aWrongCountry !== bWrongCountry) return aWrongCountry - bWrongCountry; // wrong country goes last
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
            // ANTI-REPEAT: Select best video that wasn't recently used
            results.winner = this.selectBestVideoAvoidingRepeats(finalRanking);
            if (results.winner) {
                this.markVideoAsUsed(results.winner.url);
            }
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
                    : `Footage: ${v.visualScore || 0}% | País: ${v.detectedCountry || 'unknown'}${v.countryRejected ? ' ❌ RECHAZADO' : ''}`;

                console.log(`${medals[i] || '#' + (i + 1)}: ${v.title}`);
                console.log(`   URL: ${v.url}`);
                console.log(`   Final Score: ${v.finalScore} (Text: ${v.textScoreNum}, Visual: ${v.visualScore ?? 'N/A'})`);
                console.log(`   Match: ${matchInfo}`);
                if (!requiresPersonMatch && v.wrongCountryDetected) {
                    console.log(`   ⚠️ País incorrecto detectado: ${v.wrongCountryDetected}`);
                }
                console.log(`   Bonuses: +${v.matchBonus || 0} / Penalties: -${v.matchPenalty || 0}`);
                console.log(`   Verdict: ${v.visualAnalysis?.recommendation || 'N/A'}`);
                if (v.shotList) {
                    console.log(`   Shot List: "${v.shotList.substring(0, 100)}..."`);
                }
                console.log('');
            });

            console.log(`Total time: ${results.timings.total}ms (${(results.timings.total / 1000).toFixed(1)}s)`);

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
            // Re-throw skip errors so they propagate to the caller
            if (error.message === 'SKIPPED_BY_USER') {
                throw error;
            }
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
            onProgress = () => { },
            segmentFrame = null,
            myContentWaitMinutes = 4,
            maxCandidatesToTry = 12,
            excludeUrls = new Set(),  // URLs to exclude (recently used videos)
            segmentIndex = -1,        // Current segment index for logging
            shouldSkip = () => false  // Callback to check if user requested skip
        } = options;

        // Helper to check for skip and throw if needed
        const checkSkip = () => {
            if (shouldSkip()) {
                throw new Error('SKIPPED_BY_USER');
            }
        };

        console.log('\n' + '='.repeat(70));
        console.log('INTELLIGENT SEARCH AND DOWNLOAD');
        console.log('='.repeat(70));
        if (segmentFrame) {
            console.log('[VioryDownloader] Segment frame provided for visual matching');
        }

        // Step 1: Run intelligent search to get ranked candidates
        onProgress({ stage: 'search', message: 'Running intelligent search...' });

        // Check for skip before starting
        checkSkip();

        const searchResults = await this.intelligentSearch(headline, text, geminiApiKey, {
            segmentFrame: segmentFrame,  // Pass the segment frame for visual analysis
            onProgress: (p) => onProgress({ stage: 'search', ...p }),
            shouldSkip: shouldSkip  // Pass through the skip check callback
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

        // Filter out recently used videos (anti-repetition)
        let availableVideos = searchResults.videos;
        if (excludeUrls && excludeUrls.size > 0) {
            const originalCount = availableVideos.length;
            availableVideos = availableVideos.filter(v => !excludeUrls.has(v.url));
            const excludedCount = originalCount - availableVideos.length;

            if (excludedCount > 0) {
                console.log(`[Anti-Repeat] Filtered out ${excludedCount} recently used videos`);
                onProgress({
                    stage: 'download',
                    message: `Filtered ${excludedCount} recently used videos to avoid repetition`
                });
            }

            // If all videos were filtered out, use the original list but with a warning
            if (availableVideos.length === 0) {
                console.log(`[Anti-Repeat] Warning: All candidates were recently used. Using original list.`);
                availableVideos = searchResults.videos;
            }
        }

        // Filter out videos known to require "preparing" (My Content) from previous attempts
        if (this.preparingBlacklist.size > 0) {
            const beforeBlacklist = availableVideos.length;
            availableVideos = availableVideos.filter(v => !this.preparingBlacklist.has(v.url));
            const blacklisted = beforeBlacklist - availableVideos.length;
            if (blacklisted > 0) {
                console.log(`[Blacklist] Filtered out ${blacklisted} videos known to require My Content processing`);
            }
            // If all filtered, fall back to original (same safety pattern as excludeUrls)
            if (availableVideos.length === 0) {
                console.log(`[Blacklist] Warning: All candidates blacklisted. Using original list.`);
                availableVideos = searchResults.videos.filter(v => !excludeUrls.has(v.url));
                if (availableVideos.length === 0) availableVideos = searchResults.videos;
            }
        }

        const candidatesToTry = availableVideos.slice(0, maxCandidatesToTry);
        const skippedVideos = [];
        let firstVideoTriedMyContent = false;

        // Step 2: Try FIRST (best) video - allow My Content wait
        const bestVideo = candidatesToTry[0];
        console.log(`\n[VioryDownloader] Trying BEST candidate: "${bestVideo.title?.substring(0, 50)}..."`);
        console.log(`   URL: ${bestVideo.url}`);
        console.log(`   Score: ${bestVideo.finalScore} (Text: ${bestVideo.textScoreNum}, Visual: ${bestVideo.visualScore ?? 'N/A'})`);

        // MINIMUM SCORE CHECK - Skip very low scoring videos, try others
        const MIN_SCORE_FOR_AUTO_DOWNLOAD = 15; // Lowered from 25 to allow more videos for obscure topics
        if (bestVideo.finalScore < MIN_SCORE_FOR_AUTO_DOWNLOAD) {
            console.log(`\n⚠️ [VioryDownloader] Best video score (${bestVideo.finalScore}) is below minimum threshold (${MIN_SCORE_FOR_AUTO_DOWNLOAD})`);
            console.log(`   Skipping this video and trying other candidates...`);

            skippedVideos.push({
                url: bestVideo.url,
                title: bestVideo.title,
                score: bestVideo.finalScore,
                reason: `Score too low (${bestVideo.finalScore} < ${MIN_SCORE_FOR_AUTO_DOWNLOAD})`
            });

            // Continue to try alternative candidates (don't return early)
        } else {

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
                    { skipMyContent: true, shouldSkip }
                );

                if (firstResult.success) {
                    console.log(`\n✅ SUCCESS: Downloaded "${bestVideo.title?.substring(0, 50)}..."`);
                    return this._buildSuccessResult(bestVideo, firstResult, 1, skippedVideos, searchResults);
                }

                // If needs My Content, skip it and try alternatives (Optimization: don't wait for "preparing video")
                if (firstResult.needsMyContent) {
                    console.log(`\n[VioryDownloader] Best video requires My Content - SKIPPING to alternatives (Optimization)`);
                    this.preparingBlacklist.add(bestVideo.url);
                    skippedVideos.push({
                        url: bestVideo.url,
                        title: bestVideo.title,
                        score: bestVideo.finalScore,
                        reason: `Requires My Content (skipped for speed)`
                    });
                }
            } catch (error) {
                if (error.message === 'SKIPPED_BY_USER') throw error;
                console.error(`   ❌ Error with best video: ${error.message}`);
                skippedVideos.push({
                    url: bestVideo.url,
                    title: bestVideo.title,
                    score: bestVideo.finalScore,
                    reason: error.message
                });
            }
        } // Close the else block for MIN_SCORE check

        // Step 3: Try remaining candidates (SKIP My Content - only direct downloads)
        console.log(`\n[VioryDownloader] Trying alternative candidates (direct download only)...`);

        for (let i = 1; i < candidatesToTry.length; i++) {
            // Check for skip before trying each candidate
            checkSkip();

            const video = candidatesToTry[i];

            console.log(`\n[VioryDownloader] Trying candidate ${i + 1}/${candidatesToTry.length}: "${video.title?.substring(0, 50)}..."`);
            console.log(`   URL: ${video.url}`);
            console.log(`   Score: ${video.finalScore}`);

            // Skip low-scoring alternatives
            if (video.finalScore < MIN_SCORE_FOR_AUTO_DOWNLOAD) {
                console.log(`   ⏭️ Skipped - score too low (${video.finalScore} < ${MIN_SCORE_FOR_AUTO_DOWNLOAD})`);
                skippedVideos.push({
                    url: video.url,
                    title: video.title,
                    score: video.finalScore,
                    reason: `Score too low (${video.finalScore})`
                });
                continue;
            }

            onProgress({
                stage: 'download',
                message: `Trying alternative ${i}/${candidatesToTry.length - 1}...`,
                video: { title: video.title, url: video.url, score: video.finalScore }
            });

            try {
                const downloadResult = await this.downloadVideo(
                    video.url,
                    (p) => onProgress({ stage: 'download', ...p }),
                    { skipMyContent: true, shouldSkip }  // Always skip My Content for alternatives
                );

                if (downloadResult.success) {
                    console.log(`\n✅ SUCCESS (Alternative): Downloaded "${video.title?.substring(0, 50)}..."`);
                    return this._buildSuccessResult(video, downloadResult, i + 1, skippedVideos, searchResults);
                }

                if (downloadResult.needsMyContent) {
                    console.log(`   ⏭️ Skipped - requires My Content`);
                    this.preparingBlacklist.add(video.url);
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
                if (error.message === 'SKIPPED_BY_USER') throw error;
                console.error(`   ❌ Error: ${error.message}`);
                skippedVideos.push({
                    url: video.url,
                    title: video.title,
                    score: video.finalScore,
                    reason: error.message
                });
            }
        }

        // All candidates failed - check if they ALL needed My Content
        const allNeedMyContent = skippedVideos.every(v =>
            v.reason && v.reason.toLowerCase().includes('my content')
        );

        // ================================================================
        // EMERGENCY FALLBACK: When all fail, try best available with score >= 10
        // This ensures obscure topics (EA-37B, specific equipment) get something
        // ================================================================
        const EMERGENCY_MIN_SCORE = 10;
        const emergencyCandidate = candidatesToTry.find(v =>
            v.finalScore >= EMERGENCY_MIN_SCORE &&
            !skippedVideos.some(sv => sv.url === v.url && sv.reason?.includes('My Content'))
        );

        if (emergencyCandidate && !allNeedMyContent) {
            console.log(`\n⚠️ [EMERGENCY FALLBACK] Trying best available video (score: ${emergencyCandidate.finalScore})`);
            console.log(`   Title: "${emergencyCandidate.title?.substring(0, 50)}..."`);

            onProgress({
                stage: 'download',
                message: `Emergency fallback - downloading best available...`,
                video: { title: emergencyCandidate.title, url: emergencyCandidate.url, score: emergencyCandidate.finalScore }
            });

            try {
                const emergencyResult = await this.downloadVideo(
                    emergencyCandidate.url,
                    (p) => onProgress({ stage: 'download', ...p }),
                    { skipMyContent: true, shouldSkip }
                );

                if (emergencyResult.success) {
                    console.log(`\n✅ EMERGENCY FALLBACK SUCCESS: Downloaded with score ${emergencyCandidate.finalScore}`);
                    return this._buildSuccessResult(emergencyCandidate, emergencyResult, 'emergency', skippedVideos, searchResults);
                }
            } catch (err) {
                console.error(`   Emergency fallback failed: ${err.message}`);
            }
        }

        // Final failure - NEVER wait for My Content, just report the failure
        console.log('\n❌ ALL CANDIDATES FAILED');
        console.log('Skipped videos:');
        skippedVideos.forEach((v, i) => {
            console.log(`   ${i + 1}. "${v.title?.substring(0, 40)}..." - ${v.reason}`);
        });

        if (allNeedMyContent && skippedVideos.length > 0) {
            console.log('\n[VioryDownloader] ALL candidates require My Content - no direct downloads available');
        }

        return {
            success: false,
            error: allNeedMyContent
                ? `All ${skippedVideos.length} videos require "My Content" processing. Try a different search term or use Manual URL.`
                : 'All video candidates failed to download',
            allNeedMyContent,
            skippedVideos,
            searchResults
        };
    }

    /**
     * Helper to build success result object
     * @private
     */
    _buildSuccessResult(video, downloadResult, candidateNumber, skippedVideos, searchResults) {
        // Use mandatoryCredit from downloadResult if available (extracted during download),
        // otherwise fall back to video.mandatoryCredit (from deep analysis)
        const finalMandatoryCredit = downloadResult.mandatoryCredit || video.mandatoryCredit || '';

        // DEBUG: Log mandatory credit extraction
        console.log(`[VioryDownloader] _buildSuccessResult - video.mandatoryCredit: "${video.mandatoryCredit || '(EMPTY)'}"`);
        console.log(`[VioryDownloader] _buildSuccessResult - downloadResult.mandatoryCredit: "${downloadResult.mandatoryCredit || '(EMPTY)'}"`);
        console.log(`[VioryDownloader] _buildSuccessResult - FINAL mandatoryCredit: "${finalMandatoryCredit || '(EMPTY)'}"`);
        console.log(`[VioryDownloader] _buildSuccessResult - video.title: "${video.title}"`);

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
                mandatoryCredit: finalMandatoryCredit
            },
            candidateNumber,
            skippedVideos,
            searchResults
        };
    }

    /**
     * Extract Video ID from Viory URL (e.g., "a3126_25012026" from the URL)
     */
    extractVideoId(url) {
        const match = url.match(/\/videos\/([a-zA-Z0-9_]+)\//);
        return match ? match[1] : null;
    }

    /**
     * Download a video with checkbox handling and "preparing video" detection
     * @param {string} videoUrl - Video URL to download
     * @param {Function} onProgress - Progress callback
     * @param {Object} options - Download options
     * @param {boolean} options.skipMyContent - If true (default), return immediately when video needs My Content (don't wait)
     * @param {Function} options.shouldSkip - Optional callback to check if user requested skip
     * @returns {Object} Result with success, path, or needsMyContent flag
     */
    async downloadVideo(videoUrl, onProgress, options = {}) {
        const { skipMyContent = true, shouldSkip = () => false } = options;
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
            await this.page.waitForSelector('button', { timeout: 5000 }).catch(() => { });
            await this.page.waitForTimeout(800);
            await this.dismissPopups();

            // Extract video title for later matching
            videoTitle = await this.page.evaluate(() => {
                const h1 = document.querySelector('h1');
                return h1 ? h1.innerText.trim() : '';
            });
            console.log(`[VioryDownloader] Video title: "${videoTitle.substring(0, 50)}..."`);

            // CRITICAL FIX: Extract mandatory credit NOW, while it's visible in "Restrictions" section
            // After clicking Download, the modal changes and credit may not be accessible
            let earlyMandatoryCredit = '';
            try {
                earlyMandatoryCredit = await this.page.evaluate(() => {
                    const bodyText = document.body.innerText || '';
                    const creditMatch = bodyText.match(/[Mm]andatory\s*credit[:\s]+([^\n]+)/);
                    if (creditMatch && creditMatch[1]) {
                        let credit = creditMatch[1].trim();
                        credit = credit.replace(/[;].*$/, '').trim();
                        credit = credit.replace(/\/[A-Z].*$/i, '').trim();
                        credit = credit.replace(/\s*\/-.*$/, '').trim();
                        credit = credit.replace(/\s*\/\s*-.*$/, '').trim();
                        credit = credit.replace(/\s+-\s+.*$/, '').trim();
                        credit = credit.replace(/[.,;:\/]+$/, '').trim();
                        if (credit.length >= 3 && credit.length <= 100) {
                            return credit;
                        }
                    }
                    return '';
                });
                if (earlyMandatoryCredit) {
                    console.log(`[VioryDownloader] ✅ Early extracted mandatoryCredit: "${earlyMandatoryCredit}"`);
                }
            } catch (e) {
                console.log(`[VioryDownloader] Could not extract early credit: ${e.message}`);
            }

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
                    await this.page.keyboard.press('Escape').catch(() => { });
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
                return await this.downloadFromMyContent(onProgress, videoId, videoTitle, { shouldSkip });
            }

            // Wait for download (with shorter timeout since we already checked for preparing modal)
            const download = await downloadPromise;

            if (download) {
                // Direct download started
                let filename = download.suggestedFilename();
                // Ensure unique filename to prevent overwriting
                const timestamp = Date.now();
                const uniqueFilename = `${timestamp}_${filename}`;
                const savePath = path.join(this.downloadsPath, uniqueFilename);
                console.log(`[VioryDownloader] Downloading: ${uniqueFilename}`);

                if (onProgress) onProgress({ status: 'downloading', filename: uniqueFilename });

                try {
                    await download.saveAs(savePath);
                    await this.saveCookies();

                    // Verify file was saved
                    if (!fs.existsSync(savePath)) {
                        console.error(`[VioryDownloader] File not saved at: ${savePath}`);
                        throw new Error('Download completed but file not found');
                    }

                    const stats = fs.statSync(savePath);
                    if (stats.size < 1000) {
                        console.error(`[VioryDownloader] File too small (${stats.size} bytes): ${savePath}`);
                        throw new Error('Downloaded file is too small, likely corrupt');
                    }

                    console.log(`[VioryDownloader] Saved: ${savePath} (${(stats.size / 1024 / 1024).toFixed(1)} MB)`);

                    // Extract mandatoryCredit from the current page (we're already on the video page)
                    // CRITICAL FIX: First expand "Meta data" section where the credit is located
                    let mandatoryCredit = '';
                    try {
                        // Expand "Meta data" section (Mandatory credit is hidden in collapsed accordion)
                        await this.page.evaluate(() => {
                            const allElements = document.querySelectorAll('*');
                            for (const el of allElements) {
                                if (el.childNodes.length === 1 && el.textContent.trim() === 'Meta data') {
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

                        // Wait for accordion to expand
                        await this.page.waitForTimeout(300);

                        // Now extract the mandatory credit
                        mandatoryCredit = await this.page.evaluate(() => {
                            const bodyText = document.body.innerText || '';
                            const creditMatch = bodyText.match(/[Mm]andatory\s*credit[:\s]+([^\n]+)/);
                            if (creditMatch && creditMatch[1]) {
                                let credit = creditMatch[1].trim();
                                // Clean up restrictions like "; News use only"
                                credit = credit.replace(/[;].*$/, '').trim();
                                credit = credit.replace(/\/[A-Z].*$/i, '').trim();
                                credit = credit.replace(/\s*\/-.*$/, '').trim();
                                credit = credit.replace(/\s*\/\s*-.*$/, '').trim();
                                credit = credit.replace(/\s+-\s+.*$/, '').trim();
                                credit = credit.replace(/[.,;:\/]+$/, '').trim();
                                if (credit.length >= 3 && credit.length <= 100) {
                                    return credit;
                                }
                            }
                            return '';
                        });
                        if (mandatoryCredit) {
                            console.log(`[VioryDownloader] Extracted mandatoryCredit (late): "${mandatoryCredit}"`);
                        }
                    } catch (creditError) {
                        console.log(`[VioryDownloader] Late credit extraction failed: ${creditError.message}`);
                    }

                    // Use early-extracted credit if available, otherwise use late-extracted
                    const finalCredit = earlyMandatoryCredit || mandatoryCredit || '';
                    if (finalCredit) {
                        console.log(`[VioryDownloader] ✅ Final mandatoryCredit: "${finalCredit}" (source: ${earlyMandatoryCredit ? 'early' : 'late'})`);
                    } else {
                        console.log(`[VioryDownloader] ⚠️ No mandatory credit found`);
                    }

                    return { success: true, path: savePath, filename, videoTitle, mandatoryCredit: finalCredit };
                } catch (saveError) {
                    console.error(`[VioryDownloader] Save failed: ${saveError.message}`);
                    return {
                        success: false,
                        needsMyContent: false,
                        message: `Download save failed: ${saveError.message}`
                    };
                }
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
                return await this.downloadFromMyContent(onProgress, videoId, videoTitle, { shouldSkip });
            }

        } catch (error) {
            // Re-throw skip errors
            if (error.message === 'SKIPPED_BY_USER') throw error;

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
                return await this.downloadFromMyContent(onProgress, videoId, videoTitle, { shouldSkip });
            } catch (fallbackError) {
                // Re-throw skip errors
                if (fallbackError.message === 'SKIPPED_BY_USER') throw fallbackError;
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
     * @param {Function} options.shouldSkip - Optional callback to check if user requested skip
     * @returns {Object} Result with success flag, or timeout flag if video not ready
     */
    async downloadFromMyContent(onProgress, targetVideoId = '', targetVideoTitle = '', options = {}) {
        const { maxWaitMinutes = 4, shouldSkip = () => false } = options;

        console.log('[VioryDownloader] Navigating to My Content page...');
        console.log(`[VioryDownloader] Target Video ID: ${targetVideoId || '(none)'}`);
        console.log(`[VioryDownloader] Target Title: "${(targetVideoTitle || '').substring(0, 50)}..."`);
        console.log(`[VioryDownloader] Max wait time: ${maxWaitMinutes} minutes`);

        // Navigate to My Content page
        await this.page.goto('https://www.viory.video/en/user', {
            waitUntil: 'domcontentloaded',
            timeout: 25000
        });
        await this.page.waitForSelector('button', { timeout: 5000 }).catch(() => { });
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
                        let filename = download.suggestedFilename();
                        // Ensure unique filename to prevent overwriting
                        const timestamp = Date.now();
                        const uniqueFilename = `${timestamp}_${filename}`;
                        const savePath = path.join(this.downloadsPath, uniqueFilename);

                        if (onProgress) onProgress({ status: 'saving', filename: uniqueFilename });
                        await download.saveAs(savePath);
                        await this.saveCookies();

                        console.log(`[VioryDownloader] Downloaded: ${savePath}`);

                        // CRITICAL FIX: Extract mandatoryCredit by navigating to the video page
                        // My Content page doesn't show credits, so we need to visit the actual video page
                        let mandatoryCredit = '';
                        try {
                            // Build video URL from ID (format: https://www.viory.video/en/videos/ID/...)
                            const videoPageUrl = `https://www.viory.video/en/videos/${targetVideoId}/`;
                            console.log(`[VioryDownloader] Extracting mandatory credit from: ${videoPageUrl}`);

                            await this.page.goto(videoPageUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
                            await this.page.waitForTimeout(1000);

                            mandatoryCredit = await this.page.evaluate(() => {
                                const bodyText = document.body.innerText || '';
                                const creditMatch = bodyText.match(/[Mm]andatory\s*credit[:\s]+([^\n]+)/);
                                if (creditMatch && creditMatch[1]) {
                                    let credit = creditMatch[1].trim();
                                    // Clean up restrictions
                                    credit = credit.replace(/[;].*$/, '').trim();
                                    credit = credit.replace(/\/[A-Z].*$/i, '').trim();
                                    credit = credit.replace(/\s*\/-.*$/, '').trim();
                                    credit = credit.replace(/\s*\/\s*-.*$/, '').trim();
                                    credit = credit.replace(/\s+-\s+.*$/, '').trim();
                                    credit = credit.replace(/[.,;:\/]+$/, '').trim();
                                    if (credit.length >= 3 && credit.length <= 100) {
                                        return credit;
                                    }
                                }
                                return '';
                            });

                            if (mandatoryCredit) {
                                console.log(`[VioryDownloader] Extracted mandatoryCredit from video page: "${mandatoryCredit}"`);
                            } else {
                                console.log(`[VioryDownloader] No mandatory credit found on video page`);
                            }
                        } catch (creditErr) {
                            console.log(`[VioryDownloader] Could not extract credit: ${creditErr.message}`);
                        }

                        return {
                            success: true,
                            path: savePath,
                            filename,
                            fromMyContent: true,
                            videoId: targetVideoId,
                            videoTitle: videoStatus.title,
                            mandatoryCredit
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

            // Check for user skip request before waiting
            if (shouldSkip()) {
                console.log('[VioryDownloader] User requested skip during My Content wait');
                throw new Error('SKIPPED_BY_USER');
            }

            // Wait and refresh page
            if (attempt < maxAttempts) {
                console.log(`[VioryDownloader] Waiting ${pollInterval / 1000}s before refresh...`);

                // Break up the wait into smaller chunks to check for skip more often
                const waitChunks = 5;  // Check every 1 second during 5-second wait
                const chunkDuration = pollInterval / waitChunks;
                for (let chunk = 0; chunk < waitChunks; chunk++) {
                    await this.page.waitForTimeout(chunkDuration);
                    if (shouldSkip()) {
                        console.log('[VioryDownloader] User requested skip during My Content wait');
                        throw new Error('SKIPPED_BY_USER');
                    }
                }

                await this.page.reload({ waitUntil: 'domcontentloaded' }).catch(() => { });
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
