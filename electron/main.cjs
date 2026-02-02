const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');
const { VioryDownloader } = require('./vioryDownloader.cjs');
const JSZip = require('jszip');

// Global Viory downloader instance
let vioryDownloader = null;
let viorySessionStatus = { checked: false, valid: false, needsLogin: true };

/**
 * Check if Viory session is valid (quick file-based check, no browser)
 * Call this at startup to set initial state
 */
function checkViorySessionQuick() {
    try {
        const userDataPath = app.getPath('userData');
        const cookiesPath = path.join(userDataPath, 'viory-cookies.json');

        if (fs.existsSync(cookiesPath)) {
            const cookies = JSON.parse(fs.readFileSync(cookiesPath, 'utf-8'));
            // Check if we have session-like cookies
            const hasSessionCookies = cookies.some(c =>
                c.name.includes('session') ||
                c.name.includes('auth') ||
                c.name.includes('token') ||
                c.name.includes('user') ||
                c.domain.includes('viory')
            );
            if (cookies.length > 5 && hasSessionCookies) {
                console.log('[Main] Found saved Viory session cookies');
                viorySessionStatus = { checked: true, valid: true, needsLogin: false, source: 'cookies' };
                return true;
            }
        }
        console.log('[Main] No valid Viory session cookies found');
        viorySessionStatus = { checked: true, valid: false, needsLogin: true };
        return false;
    } catch (e) {
        console.warn('[Main] Error checking Viory session:', e.message);
        viorySessionStatus = { checked: true, valid: false, needsLogin: true, error: e.message };
        return false;
    }
}

/**
 * Verify Viory session with headless browser (silent, no UI)
 * Only called when we need to actually verify the session works
 */
async function verifyViorySessionSilent() {
    console.log('[Main] Verifying Viory session silently...');

    const tempDownloader = new VioryDownloader();
    // Don't init browser, just use the verification method
    tempDownloader.cookiesPath = path.join(app.getPath('userData'), 'viory-cookies.json');

    const result = await tempDownloader.verifySessionHeadless();
    viorySessionStatus = {
        checked: true,
        valid: result.valid,
        needsLogin: result.needsLogin,
        source: 'verified'
    };

    return result;
}

/**
 * Initialize Viory browser lazily - only when actually needed
 * @param {object} options - { forceLogin: boolean, minimizeAfterReady: boolean }
 * @param {function} onStatusChange - Callback for status updates
 */
async function ensureVioryReadyLazy(options = {}, onStatusChange = null) {
    const { forceLogin = false, minimizeAfterReady = true } = options;

    // If already initialized and browser exists, just ensure it's ready
    if (vioryDownloader && vioryDownloader.browser) {
        console.log('[Main] Viory browser already initialized');
        // Minimize if requested for background operation
        if (minimizeAfterReady) {
            await vioryDownloader.minimizeWindow();
        }
        return { success: true, alreadyInitialized: true };
    }

    console.log('[Main] Lazy initializing Viory...');
    if (onStatusChange) onStatusChange({ status: 'initializing', message: 'Initializing Viory connection...' });

    // First, check if we have cookies (quick check, no browser)
    const hasCookies = checkViorySessionQuick();

    if (hasCookies && !forceLogin) {
        // We have cookies - verify them silently with headless browser
        if (onStatusChange) onStatusChange({ status: 'verifying', message: 'Verifying Viory session...' });

        const verifyResult = await verifyViorySessionSilent();

        if (verifyResult.valid) {
            // Session is valid! Initialize the main browser (visible but minimized)
            console.log('[Main] Session valid, initializing browser for video operations...');
            if (onStatusChange) onStatusChange({ status: 'ready', message: 'Viory session active' });

            vioryDownloader = new VioryDownloader();
            await vioryDownloader.init({ headless: false }); // Visible mode for reliability

            // Minimize the browser so it's not intrusive
            if (minimizeAfterReady) {
                await vioryDownloader.minimizeWindow();
            }

            return { success: true, wasLoggedIn: true };
        }

        // Session expired - need to login
        console.log('[Main] Session expired, need to login');
    }

    // Need to login - show the browser window
    if (onStatusChange) onStatusChange({ status: 'login_required', message: 'Please log in to Viory' });

    vioryDownloader = new VioryDownloader();
    await vioryDownloader.init({ headless: false }); // Visible for login

    // Show the window for login
    await vioryDownloader.showWindow();

    // Wait for login with smart detection
    const loginSuccess = await vioryDownloader.handleLoginFlow(onStatusChange);

    if (loginSuccess) {
        viorySessionStatus = { checked: true, valid: true, needsLogin: false, source: 'fresh_login' };

        // After successful login, minimize for background operation
        if (minimizeAfterReady) {
            await vioryDownloader.minimizeWindow();
        }

        if (onStatusChange) onStatusChange({ status: 'ready', message: 'Successfully logged in to Viory' });
        return { success: true, wasLoggedIn: false, freshLogin: true };
    }

    if (onStatusChange) onStatusChange({ status: 'error', message: 'Failed to log in to Viory' });
    return { success: false, error: 'Login failed or timed out' };
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use ensureVioryReadyLazy instead
 */
async function ensureVioryReady() {
    return ensureVioryReadyLazy({ minimizeAfterReady: false });
}

// ============================================================================
// GEMINI AI INTEGRATION FOR SMART QUERY GENERATION
// ============================================================================
let GoogleGenerativeAI = null;
let geminiModel = null;
let geminiInitialized = false;

const DEFAULT_GEMINI_KEY = "AIzaSyC0QCO0_h3jb6l2rDV738Rv8hAvf6_5atk";

// Get Gemini API Key from user config or use default
function getGeminiApiKey() {
    try {
        const configPath = path.join(os.homedir(), '.clicksync', 'config.json');
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (data.geminiKey && data.geminiKey.trim().length > 10) {
                console.log("[Gemini] Using custom API Key from user config");
                return data.geminiKey.trim();
            }
        }
    } catch (e) {
        console.error("[Gemini] Failed to load config:", e.message);
    }
    return DEFAULT_GEMINI_KEY;
}

// Initialize Gemini (lazy loading)
async function initGemini() {
    if (geminiInitialized) return true;

    try {
        // Dynamic import for ES module
        const module = await import('@google/generative-ai');
        GoogleGenerativeAI = module.GoogleGenerativeAI;

        const apiKey = getGeminiApiKey();
        const genAI = new GoogleGenerativeAI(apiKey);
        geminiModel = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });
        geminiInitialized = true;
        console.log("[Gemini] Initialized successfully with gemini-3-flash-preview");
        return true;
    } catch (e) {
        const errorMessage = e.message || String(e);

        // Provide specific error messages
        if (errorMessage.includes('API_KEY') || errorMessage.toLowerCase().includes('api key')) {
            console.error("[Gemini] INIT ERROR: Invalid or missing API key. Please check your Gemini API key in Settings.");
        } else if (errorMessage.toLowerCase().includes('module') || errorMessage.toLowerCase().includes('import')) {
            console.error("[Gemini] INIT ERROR: Failed to load @google/generative-ai module.");
        } else {
            console.error("[Gemini] Failed to initialize:", errorMessage);
        }

        return false;
    }
}

// Generate smart queries using Gemini AI (like videoMatcher.js)
async function generateSmartQueries(headline, text = '', previousContext = null) {
    // Try to use Gemini, fall back to simple generation if it fails
    if (!geminiInitialized) {
        const success = await initGemini();
        if (!success) {
            console.log("[Gemini] Using fallback query generation");
            return generateFallbackQueries(headline);
        }
    }

    try {
        let continuitySection = '';
        if (previousContext && previousContext.main_person) {
            continuitySection = `
PREVIOUS SEGMENT CONTEXT:
- Previous main person: "${previousContext.main_person}"
- Previous topic: "${previousContext.topic || 'N/A'}"
RULE: If this is a CONTINUATION, use similar entities but DIFFERENT query variants.`;
        }

        const prompt = `You help search for news video footage on Viory.video. Generate search queries.

SEGMENT TO ANALYZE:
Headline: "${headline}"
${text ? `Text: "${text.substring(0, 500)}"` : ''}
${continuitySection}

GENERATE 6-8 SEARCH QUERIES following this priority:
1. If TWO people mentioned: "PersonA PersonB" together
2. Main person + action: "Trump speech", "Putin conference"
3. Person's FULL NAME only
4. Person + location: "Biden White House"
5. Institution/Organization if mentioned
6. Event type + location: "NATO summit", "UN meeting"
7. Generic fallback: topic + "footage"

RULES:
- Queries must be 2-4 words MAX
- Include action words: speech, conference, meeting, interview
- If position without name (e.g. "the President"), use: "Russian President", "Chinese Premier"
- Each query MUST be different

OUTPUT JSON ONLY:
{
  "block_type": "PERSONA|MULTI_PERSONA|EVENT|INSTITUTION|GENERIC",
  "main_person": "Full Name or null",
  "topic": "main topic",
  "queries": ["query1", "query2", "query3", "query4", "query5", "query6"]
}`;

        const result = await geminiModel.generateContent(prompt);
        const responseText = result.response.text();
        const jsonText = responseText.replace(/```json\n?|```/g, '').trim();
        const parsed = JSON.parse(jsonText);

        console.log(`[Gemini] Generated ${parsed.queries?.length || 0} smart queries for: "${headline.substring(0, 40)}..."`);
        console.log(`[Gemini] Type: ${parsed.block_type}, Person: ${parsed.main_person || 'N/A'}`);

        return {
            queries: parsed.queries || generateFallbackQueries(headline),
            analysis: parsed
        };

    } catch (e) {
        // Detailed error handling for Gemini API
        const errorMessage = e.message || String(e);
        let userFriendlyError = errorMessage;

        // Check for specific API errors
        if (errorMessage.includes('429') || errorMessage.toLowerCase().includes('rate limit') || errorMessage.toLowerCase().includes('quota')) {
            userFriendlyError = 'Gemini API rate limit exceeded. Using fallback queries.';
            console.error("[Gemini] RATE LIMIT: API quota exceeded. Consider upgrading your plan or waiting.");
        } else if (errorMessage.includes('403') || errorMessage.toLowerCase().includes('permission') || errorMessage.toLowerCase().includes('forbidden')) {
            userFriendlyError = 'Gemini API access denied. Check your API key.';
            console.error("[Gemini] ACCESS DENIED: Invalid API key or insufficient permissions.");
        } else if (errorMessage.includes('400') || errorMessage.toLowerCase().includes('invalid')) {
            userFriendlyError = 'Invalid request to Gemini API.';
            console.error("[Gemini] BAD REQUEST: Invalid request format or parameters.");
        } else if (errorMessage.includes('500') || errorMessage.includes('503') || errorMessage.toLowerCase().includes('unavailable')) {
            userFriendlyError = 'Gemini API temporarily unavailable. Using fallback queries.';
            console.error("[Gemini] SERVICE ERROR: Gemini API is temporarily unavailable.");
        } else if (errorMessage.toLowerCase().includes('resource') && errorMessage.toLowerCase().includes('exhausted')) {
            userFriendlyError = 'Gemini API quota exhausted for today. Using fallback queries.';
            console.error("[Gemini] QUOTA EXHAUSTED: Daily API limit reached.");
        } else if (errorMessage.toLowerCase().includes('network') || errorMessage.toLowerCase().includes('fetch')) {
            userFriendlyError = 'Network error connecting to Gemini API.';
            console.error("[Gemini] NETWORK ERROR: Could not reach Gemini API.");
        } else {
            console.error("[Gemini] Query generation failed:", errorMessage);
        }

        // Log the full error for debugging
        console.error("[Gemini] Full error details:", e);

        return {
            queries: generateFallbackQueries(headline),
            analysis: { block_type: 'GENERIC', main_person: null, topic: headline },
            error: userFriendlyError
        };
    }
}

// Fallback query generation (no AI)
function generateFallbackQueries(headline) {
    const queries = [];
    const clean = headline.replace(/[^\w\s]/g, '').trim();

    queries.push(clean);

    const words = clean.split(/\s+/).filter(w => w.length > 2);
    if (words.length > 4) {
        queries.push(words.slice(0, 4).join(' '));
        queries.push(words.slice(0, 3).join(' '));
        queries.push(words.slice(0, 2).join(' '));
    }
    if (words.length > 2) {
        queries.push(words.slice(0, 2).join(' '));
    }

    // Add individual important words (likely names/places)
    words.filter(w => w.length > 4 && w[0] === w[0].toUpperCase()).forEach(w => {
        if (!queries.includes(w)) queries.push(w);
    });

    queries.push('news footage');

    return [...new Set(queries)].slice(0, 8);
}

// Calculate relevance score for a video against the analysis
function calculateVideoRelevance(video, analysis, query) {
    let score = 0;
    const titleLower = (video.title || '').toLowerCase();
    const contentLower = (
        (video.title || '') + ' ' +
        (video.description || '') + ' ' +
        (video.videoInfo || '') + ' ' +
        (video.shotList || '')
    ).toLowerCase();

    const queryLower = query.toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    // Check for person match FIRST (critical for PERSONA segments)
    let hasPersonMatch = false;
    let personParts = [];
    const hasTargetPerson = analysis && analysis.main_person;

    if (hasTargetPerson) {
        personParts = analysis.main_person.toLowerCase().split(' ').filter(p => p.length > 2);
        // Check if ANY part of the person's name is in title (stricter) or content
        const hasPersonInTitle = personParts.some(part => part.length > 2 && titleLower.includes(part));
        const hasPersonInContent = personParts.some(part => part.length > 3 && contentLower.includes(part));
        hasPersonMatch = hasPersonInTitle || hasPersonInContent;
    }

    // CRITICAL: If we're looking for a specific person but video doesn't have them
    if (hasTargetPerson && !hasPersonMatch) {
        // Check for completely unrelated topics (refugees, protests about different things, etc.)
        const unrelatedTopics = ['refugee', 'protest', 'rally', 'discrimination', 'embassy', 'tutsi', 'congo', 'drc', 'kigali'];
        const hasUnrelatedTopic = unrelatedTopics.some(topic => titleLower.includes(topic));

        if (hasUnrelatedTopic) {
            return 5; // Extremely low - completely unrelated video
        }

        // Check if another person's name is prominently featured (wrong person)
        const commonLeaderNames = ['trump', 'biden', 'putin', 'xi', 'jinping', 'macron', 'johnson', 'modi', 'lee', 'kim', 'scholz', 'erdogan', 'netanyahu'];
        const hasWrongPerson = commonLeaderNames.some(name =>
            !personParts.includes(name) && titleLower.includes(name)
        );

        if (hasWrongPerson) {
            return 10; // Very low score - wrong person detected
        }

        // Penalty for missing expected person (but not disqualifying)
        score -= 40;
    }

    // Exact query match in title (+50 - very important)
    if (titleLower.includes(queryLower)) {
        score += 50;
    }

    // Query words in content (+10 each)
    let wordMatchScore = 0;
    queryWords.forEach(word => {
        if (contentLower.includes(word)) {
            wordMatchScore += 10;
        }
    });
    score += Math.min(wordMatchScore, 40); // Cap at 40

    // Main person name match (+50 - highest importance for PERSONA)
    if (hasPersonMatch) {
        score += 50;
        // Extra bonus if person is in TITLE specifically
        if (personParts.some(part => part.length > 2 && titleLower.includes(part))) {
            score += 15;
        }
    }

    // Priority keywords for news footage (+5 each)
    const priorityKeywords = ['speech', 'conference', 'statement', 'interview', 'address', 'meeting', 'summit', 'talks'];
    priorityKeywords.forEach(kw => {
        if (contentLower.includes(kw)) score += 5;
    });

    // Negative keywords (-20 each)
    const negativeKeywords = ['graphic', 'animation', 'infographic', 'chart', 'map'];
    negativeKeywords.forEach(kw => {
        if (contentLower.includes(kw)) score -= 20;
    });

    // Existing score from vioryDownloader (reduced weight)
    if (video.score && video.score.total) {
        score += video.score.total * 0.2;
    }

    return Math.max(0, Math.min(100, score));
}

// Check if a video is a confident match (for early exit)
function isConfidentMatch(video, analysis, score) {
    // For segments with a target person, require person match + high score
    if (analysis && analysis.main_person) {
        const titleLower = (video.title || '').toLowerCase();
        const personParts = analysis.main_person.toLowerCase().split(' ').filter(p => p.length > 3);
        const hasPersonInTitle = personParts.some(part => titleLower.includes(part));
        return score >= 75 && hasPersonInTitle;
    }
    // For generic/footage, just need good score
    return score >= 80;
}

// ============================================================================
// END GEMINI AI INTEGRATION
// ============================================================================

// Configure logging
log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = true; // Spotify-style: Download silently, then ask to restart
autoUpdater.allowPrerelease = true; // Allow finding "Pre-releases" if GitHub marks them as such

// Keep a global reference of the window object
let mainWindow;
let tray = null;

// Determine if we're in development or production
const isDev = !app.isPackaged;

// CRITICAL: Set App User Model ID for Windows Notifications (Fixes "electron.app.ClickSync" title)
if (process.platform === 'win32') {
    app.setAppUserModelId('com.clicksync.app');
}

// --- AUTO UPDATE EVENTS ---
function setupAutoUpdater() {
    autoUpdater.on('checking-for-update', () => {
        log.info('Checking for update...');
        if (mainWindow) mainWindow.webContents.send('update-status', { status: 'checking', message: 'Checking for updates...' });
    });

    autoUpdater.on('update-available', (info) => {
        log.info('Update available.', info);
        if (mainWindow) mainWindow.webContents.send('update-available', info);
    });

    autoUpdater.on('update-not-available', (info) => {
        log.info('Update not available.');
        if (mainWindow) mainWindow.webContents.send('update-status', { status: 'latest', message: 'You are on the latest version.' });
    });

    autoUpdater.on('error', (err) => {
        log.error('Error in auto-updater. ' + err);
        if (mainWindow) mainWindow.webContents.send('update-error', err.toString());
    });

    autoUpdater.on('download-progress', (progressObj) => {
        let log_message = "Download speed: " + progressObj.bytesPerSecond;
        log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
        log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
        log.info(log_message);
        if (mainWindow) mainWindow.webContents.send('update-progress', progressObj);
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('Update downloaded');
        if (mainWindow) mainWindow.webContents.send('update-downloaded', info);
    });
}

setupAutoUpdater();

// Create System Tray
function createTray() {
    try {
        let iconPath;
        if (app.isPackaged) {
            // In production, use the icon we copied to resources/assets using extraResources in package.json
            iconPath = path.join(process.resourcesPath, 'assets/tray-icon.png');
        } else {
            // In development, use public folder
            iconPath = path.join(__dirname, '../public/tray-icon.png');
        }

        console.log('[Tray] Loading icon from:', iconPath);

        // Ensure path exists before loading, otherwise nativeImage fail might crash? 
        // Actually nativeImage.createFromPath handles missing files gracefully (returns empty)

        let trayIcon;
        try {
            trayIcon = nativeImage.createFromPath(iconPath);
            // Resize if needed, though 32x32 is ideal
            if (trayIcon.isEmpty()) {
                console.warn('[Tray] Icon empty at path, falling back to exe icon');
                trayIcon = nativeImage.createFromPath(app.getPath('exe'));
            }
        } catch (e) {
            console.error('[Tray] Exception loading icon:', e);
            trayIcon = nativeImage.createFromPath(app.getPath('exe'));
        }

        tray = new Tray(trayIcon);

        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Check for Updates',
                click: () => {
                    autoUpdater.checkForUpdates();
                    if (mainWindow) {
                        mainWindow.show();
                        mainWindow.webContents.send('update-status', { status: 'checking', message: 'Manually checking...' });
                    }
                }
            },
            { type: 'separator' },
            {
                label: 'Show ClickSync',
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                        mainWindow.focus();
                    }
                }
            },
            { type: 'separator' },
            {
                label: 'Quit',
                click: () => {
                    app.isQuitting = true;
                    app.quit();
                }
            }
        ]);

        tray.setToolTip('ClickSync - Ready');
        tray.setContextMenu(contextMenu);

        // Double click to show window
        tray.on('double-click', () => {
            if (mainWindow) {
                mainWindow.show();
                mainWindow.focus();
            }
        });

        // Click to show window (single click)
        tray.on('click', () => {
            if (mainWindow) {
                mainWindow.show();
                mainWindow.focus();
            }
        });

        console.log('[Tray] System tray created successfully');
    } catch (error) {
        console.error('[Tray] Failed to create system tray:', error);
    }
}

function createWindow() {
    // Create the browser window
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.cjs')
        },
        // Modern frameless look
        frame: false,
        titleBarStyle: 'hidden',
        backgroundColor: '#000000',
        show: false, // Don't show until ready
        icon: path.join(__dirname, '../public/logo.png')
    });

    // Load the app
    if (isDev) {
        // In development, load from Vite dev server
        mainWindow.loadURL('http://localhost:5173');
        // Open DevTools in development
        mainWindow.webContents.openDevTools();
    } else {
        // In production, load the built files
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // Show window when ready to prevent visual flash
    mainWindow.once('ready-to-show', () => {
        mainWindow.maximize(); // Start maximized
        mainWindow.show();
    });

    // Minimize to tray instead of closing
    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();

            // Show notification on first minimize
            if (tray && !mainWindow.trayNotificationShown) {
                tray.displayBalloon({
                    title: 'ClickSync',
                    content: 'App is running in the background. Click the tray icon to restore.'
                });
                mainWindow.trayNotificationShown = true;
            }
        }
        return false;
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// Global server reference for health checks
let serverInstance = null;
let serverHealthCheckInterval = null;

async function startServer() {
    // In production, start the embedded server directly
    // In development, the server is started separately via npm run server
    if (!isDev) {
        try {
            const serverPath = path.join(__dirname, '../server.js');
            console.log(`[Electron] Server path: ${serverPath}`);

            // CRITICAL: Convert Windows path to file:// URL for ESM import
            const serverUrl = pathToFileURL(serverPath).href;
            console.log(`[Electron] Server URL: ${serverUrl}`);

            // Dynamic import using file:// URL
            const serverModule = await import(serverUrl);
            if (serverModule && serverModule.startServer) {
                serverInstance = await serverModule.startServer();
                console.log('[Electron] Server started successfully in-process');

                // Start health check to ensure server stays alive
                startServerHealthCheck();
            } else {
                const errMsg = 'No se encontró la función startServer en server.js';
                console.error('[Electron]', errMsg);
                dialog.showErrorBox('Error del Servidor', errMsg);
            }
        } catch (e) {
            const errMsg = `El servidor no pudo iniciar.\n\nError: ${e.message}`;
            console.error('[Electron] Failed to start server:', e);
            console.error('[Electron] Stack:', e.stack);

            // Show error dialog to user
            dialog.showErrorBox('Error al Iniciar Servidor',
                `${errMsg}\n\nPosibles causas:\n1. Chromium/Playwright no instalado\n2. Firewall bloqueando puerto 5000\n3. Puerto 5000 ocupado por otra app\n\nDetalles técnicos:\n${e.stack ? e.stack.substring(0, 500) : 'N/A'}`);
        }
    }
}

// Health check to ensure server is always running
function startServerHealthCheck() {
    // Clear any existing interval
    if (serverHealthCheckInterval) {
        clearInterval(serverHealthCheckInterval);
    }

    // Check every 30 seconds
    serverHealthCheckInterval = setInterval(async () => {
        try {
            const http = require('http');
            const req = http.get('http://localhost:5000/', { timeout: 5000 }, (res) => {
                // Server is responding, all good
                if (res.statusCode !== 200 && res.statusCode !== 404) {
                    console.log(`[Server Health] Unexpected status: ${res.statusCode}`);
                }
            });

            req.on('error', async (err) => {
                console.error('[Server Health] Server not responding, attempting restart...', err.message);
                // Try to restart server
                try {
                    const serverPath = path.join(__dirname, '../server.js');
                    const serverUrl = pathToFileURL(serverPath).href;
                    const serverModule = await import(serverUrl);
                    if (serverModule && serverModule.startServer) {
                        serverInstance = await serverModule.startServer();
                        console.log('[Server Health] Server restarted successfully');
                    }
                } catch (restartErr) {
                    console.error('[Server Health] Failed to restart server:', restartErr.message);
                }
            });

            req.on('timeout', () => {
                req.destroy();
                console.warn('[Server Health] Server health check timed out');
            });
        } catch (e) {
            console.error('[Server Health] Health check error:', e.message);
        }
    }, 30000); // Every 30 seconds

    console.log('[Server Health] Health check started (every 30s)');
}

// Dedicated Viory Login Browser (separate from scraping browser)
let vioryLoginBrowser = null;
let vioryLoginContext = null;
let vioryLoginPage = null;
let isCheckingVioryLogin = false;

/**
 * Check Viory login status at startup using a SEPARATE browser
 * This browser is ONLY for login detection and will be closed after login
 * The scraping browser (vioryDownloader) is completely separate
 * 
 * Detection method:
 * - NOT logged in: "Log in" and "Sign up" buttons visible in top-right header
 * - LOGGED IN: Person/avatar icon visible in top-right header (circular button)
 */
async function checkVioryLoginAtStartup() {
    if (isCheckingVioryLogin) return;
    isCheckingVioryLogin = true;

    const userDataPath = app.getPath('userData');
    const cookiesPath = path.join(userDataPath, 'viory-cookies.json');

    console.log('[VioryLogin] Starting login check at startup...');

    try {
        // Get chromium path for packaged app
        let executablePath = undefined;
        try {
            const appPath = path.dirname(process.execPath);
            const chromiumPath = path.join(appPath, 'resources', 'playwright-browsers', 'chromium', 'chrome-win64', 'chrome.exe');
            if (fs.existsSync(chromiumPath)) {
                executablePath = chromiumPath;
                console.log('[VioryLogin] Using bundled Chromium');
            }
        } catch (e) { /* Use system chromium */ }

        // Launch VISIBLE browser for login
        const { chromium } = require('playwright');
        vioryLoginBrowser = await chromium.launch({
            headless: false,
            channel: executablePath ? undefined : 'chromium',
            executablePath: executablePath,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        });

        vioryLoginContext = await vioryLoginBrowser.newContext({
            viewport: { width: 1280, height: 900 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });

        vioryLoginPage = await vioryLoginContext.newPage();

        // Navigate to main Viory page (not signin - let user click Log in if needed)
        console.log('[VioryLogin] Navigating to Viory main page...');
        await vioryLoginPage.goto('https://www.viory.video/en/videos', {
            waitUntil: 'domcontentloaded',
            timeout: 30000
        });

        // Wait for page to fully render
        console.log('[VioryLogin] Waiting for page to render...');
        await vioryLoginPage.waitForTimeout(3000);

        // Handle cookie/content consent modal if it appears
        await handleVioryConsentModal(vioryLoginPage);
        await vioryLoginPage.waitForTimeout(2000);

        // Check if user is already logged in (no "Log in" text visible)
        console.log('[VioryLogin] Checking initial login state...');
        const isLoggedIn = await checkIfLoggedInByAvatar(vioryLoginPage);

        if (isLoggedIn) {
            console.log('[VioryLogin] User is already logged in!');
            await saveVioryLoginCookies();
            await closeVioryLoginBrowser();
            viorySessionStatus = { checked: true, valid: true, needsLogin: false };
            if (mainWindow) {
                mainWindow.webContents.send('viory-status-update', { status: 'logged_in', message: 'Already logged in to Viory' });
            }
            return;
        }

        // Not logged in - show modal and wait for user to login
        console.log('[VioryLogin] User is NOT logged in - "Log in" text found on page');
        console.log('[VioryLogin] Waiting for user to log in...');
        if (mainWindow) {
            mainWindow.webContents.send('viory-status-update', {
                status: 'waiting_login',
                message: 'Please log in to Viory in the browser window'
            });
        }

        // Poll for login - check every 2 seconds if "Log in" text disappears
        const maxWaitTime = 5 * 60 * 1000; // 5 minutes
        const pollInterval = 2000;
        const startTime = Date.now();

        while (Date.now() - startTime < maxWaitTime) {
            await vioryLoginPage.waitForTimeout(pollInterval);

            // Check if "Log in" text is gone (means user logged in)
            const nowLoggedIn = await checkIfLoggedInByAvatar(vioryLoginPage);

            const elapsed = Math.round((Date.now() - startTime) / 1000);
            console.log(`[VioryLogin] Check #${Math.floor(elapsed / 2)}: ${nowLoggedIn ? 'LOGGED IN!' : 'Still waiting...'}`);

            if (nowLoggedIn) {
                console.log('[VioryLogin] Login detected - "Log in" text no longer visible!');
                await saveVioryLoginCookies();
                await closeVioryLoginBrowser();
                viorySessionStatus = { checked: true, valid: true, needsLogin: false };
                if (mainWindow) {
                    mainWindow.webContents.send('viory-status-update', { status: 'logged_in', message: 'Successfully logged in to Viory' });
                }
                return;
            }
        }

        // Timeout
        console.log('[VioryLogin] Login timeout');
        await closeVioryLoginBrowser();
        if (mainWindow) {
            mainWindow.webContents.send('viory-status-update', { status: 'timeout', message: 'Login timeout - you can try again later' });
        }

    } catch (error) {
        console.error('[VioryLogin] Error:', error.message);
        await closeVioryLoginBrowser();
        if (mainWindow) {
            mainWindow.webContents.send('viory-status-update', { status: 'error', message: error.message });
        }
    } finally {
        isCheckingVioryLogin = false;
    }
}

/**
 * SIMPLE and RELIABLE login detection
 * 
 * Logic: If "Log in" text exists anywhere on the page → NOT logged in
 *        If "Log in" text does NOT exist → LOGGED IN
 * 
 * This is the most reliable method because Viory always shows "Log in" button
 * in the header when user is not logged in, and hides it when logged in.
 */
async function checkIfLoggedInByAvatar(page) {
    try {
        const result = await page.evaluate(() => {
            // Get all text content from the page
            const bodyText = document.body.innerText || '';

            // Simple check: Does "Log in" appear in the page?
            // Viory shows "Log in" button in header when NOT logged in
            const hasLoginText = bodyText.includes('Log in');
            const hasSignUpText = bodyText.includes('Sign up');

            // If we see "Log in" or "Sign up", user is NOT logged in
            if (hasLoginText || hasSignUpText) {
                console.log('[VioryLogin] Found "Log in" or "Sign up" text - NOT logged in');
                return false;
            }

            // No "Log in" text found = user IS logged in
            console.log('[VioryLogin] No "Log in" text found - user IS logged in');
            return true;
        });

        console.log('[VioryLogin] Login check result:', result ? 'LOGGED IN' : 'NOT LOGGED IN');
        return result;
    } catch (e) {
        console.warn('[VioryLogin] Error checking login state:', e.message);
        // On error, assume NOT logged in (safer)
        return false;
    }
}

/**
 * Handle Viory's consent/cookie modal that appears on first visit
 * Clicks "Proceed to watch all content" button to dismiss it
 */
async function handleVioryConsentModal(page) {
    try {
        console.log('[VioryLogin] Checking for consent modal...');

        // Try clicking with Playwright's click method (more reliable)
        try {
            // Look for "Proceed to watch all content" button
            const proceedButton = await page.$('button:has-text("Proceed to watch all content")');
            if (proceedButton) {
                await proceedButton.click();
                console.log('[VioryLogin] Clicked "Proceed to watch all content"');
                await page.waitForTimeout(1500);
                return;
            }
        } catch (e) { /* Button not found */ }

        try {
            // Alternative: "Avoid explicit content" button
            const avoidButton = await page.$('button:has-text("Avoid explicit content")');
            if (avoidButton) {
                await avoidButton.click();
                console.log('[VioryLogin] Clicked "Avoid explicit content"');
                await page.waitForTimeout(1500);
                return;
            }
        } catch (e) { /* Button not found */ }

        // Fallback: use evaluate
        const clicked = await page.evaluate(() => {
            const buttons = document.querySelectorAll('button');
            for (const btn of buttons) {
                const text = (btn.textContent || '').trim();
                if (text.includes('Proceed') || text.includes('proceed') ||
                    text.includes('Avoid') || text.includes('Accept')) {
                    btn.click();
                    return true;
                }
            }
            return false;
        });

        if (clicked) {
            console.log('[VioryLogin] Consent modal dismissed via fallback');
            await page.waitForTimeout(1500);
        } else {
            console.log('[VioryLogin] No consent modal found');
        }
    } catch (e) {
        console.warn('[VioryLogin] Error handling consent modal:', e.message);
    }
}

/**
 * Save cookies from login browser
 */
async function saveVioryLoginCookies() {
    try {
        if (vioryLoginContext) {
            const cookies = await vioryLoginContext.cookies();
            const userDataPath = app.getPath('userData');
            const cookiesPath = path.join(userDataPath, 'viory-cookies.json');
            fs.writeFileSync(cookiesPath, JSON.stringify(cookies, null, 2));
            console.log('[VioryLogin] Cookies saved successfully');
        }
    } catch (e) {
        console.error('[VioryLogin] Failed to save cookies:', e.message);
    }
}

/**
 * Close the login browser (separate from scraping browser)
 */
async function closeVioryLoginBrowser() {
    try {
        if (vioryLoginPage) {
            await vioryLoginPage.close().catch(() => { });
            vioryLoginPage = null;
        }
        if (vioryLoginContext) {
            await vioryLoginContext.close().catch(() => { });
            vioryLoginContext = null;
        }
        if (vioryLoginBrowser) {
            await vioryLoginBrowser.close().catch(() => { });
            vioryLoginBrowser = null;
        }
        console.log('[VioryLogin] Login browser closed');
    } catch (e) {
        console.warn('[VioryLogin] Error closing browser:', e.message);
    }
}

// This method will be called when Electron has finished initialization
app.whenReady().then(async () => {
    // Start server
    await startServer();

    // Create window
    createWindow();

    // Check Viory session at startup (separate from video scraping)
    mainWindow.webContents.on('did-finish-load', async () => {
        console.log('[Main] Window loaded, checking Viory session...');

        // Quick file-based check first
        const hasSession = checkViorySessionQuick();
        console.log('[Main] Quick session check:', hasSession ? 'cookies found' : 'no cookies');

        if (!hasSession) {
            // No cookies at all - need to login IMMEDIATELY (no delay)
            console.log('[Main] No Viory session, starting login flow immediately...');
            checkVioryLoginAtStartup();
        } else {
            // Has cookies - verify they're valid with a quick headless check
            console.log('[Main] Cookies found, verifying session...');
            const verifyResult = await verifyViorySessionSilent();

            if (verifyResult.valid) {
                console.log('[Main] Viory session is valid!');
                viorySessionStatus = { checked: true, valid: true, needsLogin: false };
            } else {
                // Cookies expired - need to login again (no delay)
                console.log('[Main] Viory session expired, starting login flow...');
                checkVioryLoginAtStartup();
            }
        }
    });

    // Create system tray
    // --- IPC HANDLERS for Auto Updates ---
    ipcMain.handle('check-for-updates', async () => {
        if (!isDev) {
            return autoUpdater.checkForUpdates();
        } else {
            return { message: 'Development mode: Updates disabled' };
        }
    });

    ipcMain.handle('start-update-download', async () => {
        return autoUpdater.downloadUpdate();
    });

    ipcMain.handle('quit-and-install', () => {
        autoUpdater.quitAndInstall();
    });

    createTray();

    // Add JumpList for Windows to allow opening new instances
    if (process.platform === 'win32') {
        app.setUserTasks([
            {
                program: process.execPath,
                arguments: '--new-window',
                iconPath: process.execPath,
                iconIndex: 0,
                title: 'New Window',
                description: 'Open a new ClickSync window'
            }
        ]);
    }

    app.on('activate', () => {
        // On macOS it's common to re-create a window when the dock icon is clicked
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Track if cleanup is in progress to avoid double-quit
let isCleaningUp = false;

// Clean up on app quit
app.on('before-quit', (event) => {
    // If already cleaning up, let it proceed
    if (isCleaningUp) return;

    console.log('[Main] App before-quit: Starting cleanup...');

    // Stop server health check
    if (serverHealthCheckInterval) {
        clearInterval(serverHealthCheckInterval);
        serverHealthCheckInterval = null;
        console.log('[Main] Server health check stopped');
    }

    // Check if there's anything async to clean up
    if (vioryDownloader && vioryDownloader.browser) {
        // Prevent quit, do async cleanup, then quit again
        event.preventDefault();
        isCleaningUp = true;

        (async () => {
            try {
                console.log('[Main] Closing Viory browser...');
                await vioryDownloader.close();
                vioryDownloader = null;
                console.log('[Main] Viory browser closed successfully');
            } catch (e) {
                console.error('[Main] Error closing Viory browser:', e);
            }

            // Destroy tray
            if (tray) {
                try {
                    tray.destroy();
                    tray = null;
                    console.log('[Main] Tray destroyed');
                } catch (e) {
                    console.error('[Main] Error destroying tray:', e);
                }
            }

            console.log('[Main] Cleanup complete, quitting app...');
            app.quit();
        })();
    } else {
        // No async cleanup needed, just destroy tray
        if (tray) {
            try {
                tray.destroy();
                tray = null;
            } catch (e) { /* ignore */ }
        }
        console.log('[Main] No browser to clean, proceeding with quit');
    }
});

// IPC handlers for communication with renderer
ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.handle('get-app-path', () => {
    // CRITICAL FIX: Return a user-writable path for export, NOT app.asar
    // app.getAppPath() returns the asar path which is read-only!
    // Use the Videos folder or Documents as default export location
    const videosPath = app.getPath('videos');
    const documentsPath = app.getPath('documents');

    // Prefer Videos folder, fallback to Documents
    const exportDir = path.join(videosPath || documentsPath, 'ClickSync Exports');

    // Ensure directory exists
    if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
    }

    console.log('[Main] Export path:', exportDir);
    return exportDir;
});

// Show native notification with app icon
ipcMain.handle('show-notification', (event, { title, body }) => {
    try {
        // Get icon path - Windows prefers .ico files for notifications
        let iconPath;
        if (app.isPackaged) {
            // Try .ico first (better for Windows), then .png
            iconPath = path.join(process.resourcesPath, 'assets', 'icon.ico');
            if (!fs.existsSync(iconPath)) {
                iconPath = path.join(process.resourcesPath, 'assets', 'logo.png');
            }
        } else {
            iconPath = path.join(__dirname, '..', 'public', 'favicon.ico');
            if (!fs.existsSync(iconPath)) {
                iconPath = path.join(__dirname, '..', 'public', 'logo.png');
            }
        }

        console.log('[Main] Notification icon path:', iconPath, 'exists:', fs.existsSync(iconPath));

        const notification = new Notification({
            title: title,
            body: body,
            icon: fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined,
            silent: true // We play our own sound in renderer
        });

        notification.show();
        return { success: true };
    } catch (e) {
        console.error('[Main] Notification error:', e);
        return { success: false, error: e.message };
    }
});

// Window Controls
ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    }
});


ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
});

// Storage IPC Handlers (AppData persistence)
const getStoragePath = () => {
    const userDataPath = app.getPath('userData');
    const storagePath = path.join(userDataPath, 'storage');

    // Ensure storage directory exists
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }

    return storagePath;
};

ipcMain.handle('storage-get', async (event, key) => {
    try {
        const storagePath = getStoragePath();
        const filePath = path.join(storagePath, `${key}.json`);

        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return data;
        }
        return null;
    } catch (e) {
        console.error('Storage get error:', e);
        return null;
    }
});

ipcMain.handle('storage-set', async (event, key, value) => {
    try {
        const storagePath = getStoragePath();
        const filePath = path.join(storagePath, `${key}.json`);
        fs.writeFileSync(filePath, value, 'utf-8');
        return true;
    } catch (e) {
        console.error('Storage set error:', e);
        return false;
    }
});

ipcMain.handle('storage-remove', async (event, key) => {
    try {
        const storagePath = getStoragePath();
        const filePath = path.join(storagePath, `${key}.json`);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return true;
    } catch (e) {
        console.error('Storage remove error:', e);
        return false;
    }
});

// IPC handler to read file as buffer (for regenerating audio blobs)
ipcMain.handle('read-file-buffer', async (event, filePath) => {
    try {
        if (!fs.existsSync(filePath)) throw new Error('File not found');
        const buffer = fs.readFileSync(filePath);
        return buffer; // Electron handles Buffer serialization automatically
    } catch (e) {
        console.error('[Main] read-file-buffer error:', e);
        throw e;
    }
});

// IPC handler to check if a file exists (for validating restored video files)
ipcMain.handle('check-file-exists', async (event, filePath) => {
    try {
        return fs.existsSync(filePath);
    } catch (e) {
        console.error('[Main] check-file-exists error:', e);
        return false;
    }
});

// IPC handler to SAVE audio file to disk (critical for export)
// This solves the issue where browser File objects don't have a path property
ipcMain.handle('save-audio-file', async (event, { arrayBuffer, fileName, projectId }) => {
    try {
        console.log('[Main] save-audio-file called for project:', projectId, 'file:', fileName);

        // Create audio directory in userData
        const audioDir = path.join(app.getPath('userData'), 'project-audio');
        if (!fs.existsSync(audioDir)) {
            fs.mkdirSync(audioDir, { recursive: true });
        }

        // Generate unique filename to avoid collisions
        const ext = path.extname(fileName) || '.mp3';
        const safeName = `${projectId}_audio${ext}`;
        const audioPath = path.join(audioDir, safeName);

        // Convert ArrayBuffer to Buffer and save
        const buffer = Buffer.from(arrayBuffer);
        fs.writeFileSync(audioPath, buffer);

        console.log('[Main] Audio file saved to:', audioPath);
        console.log('[Main] File size:', buffer.length, 'bytes');

        return { success: true, path: audioPath };
    } catch (e) {
        console.error('[Main] save-audio-file error:', e);
        return { success: false, error: e.message };
    }
});

// IPC handler to check if audio file exists
ipcMain.handle('check-audio-file', async (event, audioPath) => {
    try {
        const exists = fs.existsSync(audioPath);
        console.log('[Main] check-audio-file:', audioPath, 'exists:', exists);
        return { exists, path: audioPath };
    } catch (e) {
        return { exists: false, error: e.message };
    }
});

// IPC handler to save Gemini API key to config file
ipcMain.handle('save-gemini-api-key', async (event, apiKey) => {
    try {
        if (!apiKey || apiKey.length < 10) {
            return { success: false, error: 'Invalid API key' };
        }

        const configDir = path.join(os.homedir(), '.clicksync');
        if (!fs.existsSync(configDir)) {
            fs.mkdirSync(configDir, { recursive: true });
        }

        const configPath = path.join(configDir, 'config.json');

        // Read existing config or create new
        let config = {};
        if (fs.existsSync(configPath)) {
            try {
                config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            } catch (e) {
                console.warn('[Main] Could not parse existing config, creating new');
                config = {};
            }
        }

        // Update key
        config.geminiKey = apiKey.trim();

        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
        console.log(`[Main] Gemini API Key saved to ${configPath}`);

        // Reinitialize Gemini with the new key
        geminiInitialized = false;
        await initGemini();

        return { success: true };
    } catch (e) {
        console.error('[Main] Failed to save Gemini API key:', e);
        return { success: false, error: e.message };
    }
});

// IPC handler to get current Gemini API key (masked for security)
ipcMain.handle('get-gemini-api-key', async () => {
    try {
        const configPath = path.join(os.homedir(), '.clicksync', 'config.json');
        if (fs.existsSync(configPath)) {
            const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            if (data.geminiKey && data.geminiKey.trim().length > 10) {
                // Return the actual key so the UI can display it
                return { success: true, key: data.geminiKey.trim(), isCustom: true };
            }
        }
        return { success: true, key: '', isCustom: false };
    } catch (e) {
        console.error('[Main] Failed to get Gemini API key:', e);
        return { success: false, error: e.message, key: '', isCustom: false };
    }
});

// --- PROJECT STATE MANAGEMENT ---
const PROJECT_STATE_FILE = 'clicksync_project_state';

// Check for interrupted project on app startup
ipcMain.handle('check-interrupted-project', async () => {
    try {
        const storagePath = getStoragePath();
        const stateFile = path.join(storagePath, `${PROJECT_STATE_FILE}.json`);

        if (fs.existsSync(stateFile)) {
            const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
            // If project was not completed/exported, it's interrupted
            if (state.status !== 'completed' && state.status !== 'exported') {
                return { hasInterruptedProject: true, projectData: state };
            }
        }
        return { hasInterruptedProject: false };
    } catch (e) {
        console.error('[Main] Error checking interrupted project:', e);
        return { hasInterruptedProject: false };
    }
});

// Update project state during work
ipcMain.handle('update-project-state', async (event, stateData) => {
    try {
        const storagePath = getStoragePath();
        const stateFile = path.join(storagePath, `${PROJECT_STATE_FILE}.json`);

        const state = {
            ...stateData,
            lastModified: Date.now()
        };

        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
        return true;
    } catch (e) {
        console.error('[Main] Error updating project state:', e);
        return false;
    }
});

// Clear session after project export (fresh start)
ipcMain.handle('clear-project-session', async () => {
    try {
        const storagePath = getStoragePath();
        const stateFile = path.join(storagePath, `${PROJECT_STATE_FILE}.json`);

        // Mark as completed and clear
        const state = { status: 'exported', completedAt: Date.now() };
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

        console.log('[Main] Project session cleared after export');
        return true;
    } catch (e) {
        console.error('[Main] Error clearing session:', e);
        return false;
    }
});

// Get Viory session status (quick check from memory/files)
ipcMain.handle('get-viory-session-status', async () => {
    try {
        // Return cached status if available
        if (viorySessionStatus.checked) {
            return {
                ...viorySessionStatus,
                hasSession: viorySessionStatus.valid,
                cookieCount: 0 // We don't count anymore, just check validity
            };
        }

        // Otherwise do a quick file check
        const hasSession = checkViorySessionQuick();
        return {
            ...viorySessionStatus,
            hasSession: hasSession
        };
    } catch (e) {
        return { hasSession: false, error: e.message };
    }
});

// Verify Viory session (actually checks with headless browser)
ipcMain.handle('verify-viory-session', async () => {
    try {
        console.log('[IPC] verify-viory-session called');
        const result = await verifyViorySessionSilent();
        return {
            valid: result.valid,
            needsLogin: result.needsLogin,
            message: result.valid ? 'Session is valid' : 'Session expired or invalid'
        };
    } catch (e) {
        console.error('[IPC] Session verification error:', e);
        return { valid: false, needsLogin: true, error: e.message };
    }
});

// Force Viory login (opens browser for user to log in)
ipcMain.handle('force-viory-login', async () => {
    try {
        console.log('[IPC] force-viory-login called');
        const result = await ensureVioryReadyLazy(
            { forceLogin: true, minimizeAfterReady: false },
            (status) => {
                if (mainWindow) {
                    mainWindow.webContents.send('viory-status-update', status);
                }
            }
        );
        return { success: result.success, freshLogin: result.freshLogin };
    } catch (e) {
        console.error('[IPC] Force login error:', e);
        return { success: false, error: e.message };
    }
});

// Tray Progress Update IPC
ipcMain.on('update-tray-progress', (event, data) => {
    if (tray) {
        const { status, progress, message, activeProjects } = data;

        let tooltip = 'ClickSync';

        if (status === 'processing') {
            tooltip = `ClickSync - Processing: ${Math.round(progress)}%`;
            if (message) {
                tooltip += `\n${message}`;
            }
        } else if (status === 'idle') {
            tooltip = 'ClickSync - Ready';
        } else if (status === 'completed') {
            tooltip = 'ClickSync - Completed!';
        }

        // Add active projects count if provided
        if (activeProjects && activeProjects > 0) {
            tooltip += `\n${activeProjects} active project(s)`;
        }

        tray.setToolTip(tooltip);
    }
});

// Tray Progress Update IPC
ipcMain.on('update-tray-progress', (event, data) => {
    if (tray) {
        const { status, progress, message, activeProjects } = data;

        let tooltip = 'ClickSync';

        if (status === 'processing') {
            tooltip = `ClickSync - Processing: ${Math.round(progress)}%`;
            if (message) {
                tooltip += `\n${message}`;
            }
        } else if (status === 'idle') {
            tooltip = 'ClickSync - Ready';
        } else if (status === 'completed') {
            tooltip = 'ClickSync - Completed!';
        }

        // Add active projects count if provided
        if (activeProjects && activeProjects > 0) {
            tooltip += `\n${activeProjects} active project(s)`;
        }

        tray.setToolTip(tooltip);
    }
});
// --- SMART EDITOR IPC HANDLERS ---
// Using dynamic imports because services are ESM
let videoEditorService = null;
let smartFetcherService = null;
let timelineManagerService = null;
let sessionManagerService = null;
let servicesLoaded = false;

// Active timeline segments for the current project (shared across IPC handlers)
let activeTimelineSegments = [];

// New: Track skip requests for segments
const activeSkipRequests = new Map(); // segmentIndex -> boolean

// Project isolation - track current project
let currentProjectId = null;
let currentProjectState = null;

// Helper function to check if a segment should be skipped
function shouldSkipSegment(segmentIndex) {
    return activeSkipRequests.has(segmentIndex) && activeSkipRequests.get(segmentIndex) === true;
}

/**
 * Clear all project state - call when switching projects
 */
function clearProjectState() {
    console.log('[Main] Clearing project state for new project');
    activeTimelineSegments = [];
    activeSkipRequests.clear();
    recentlyUsedVideos.length = 0;
    currentProjectState = null;
}

/**
 * Save current project state
 */
function saveProjectState(projectId) {
    if (!projectId || activeTimelineSegments.length === 0) return;
    
    try {
        const state = {
            projectId,
            timestamp: Date.now(),
            segments: activeTimelineSegments,
            skipRequests: Array.from(activeSkipRequests.entries()),
            recentlyUsed: recentlyUsedVideos
        };
        
        const userDataPath = app.getPath('userData');
        const statePath = path.join(userDataPath, 'project-states', `${projectId}.json`);
        
        if (!fs.existsSync(path.dirname(statePath))) {
            fs.mkdirSync(path.dirname(statePath), { recursive: true });
        }
        
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
        console.log(`[Main] Saved project state: ${projectId}`);
    } catch (e) {
        console.error('[Main] Failed to save project state:', e);
    }
}

/**
 * Load project state
 */
function loadProjectState(projectId) {
    try {
        const userDataPath = app.getPath('userData');
        const statePath = path.join(userDataPath, 'project-states', `${projectId}.json`);
        
        if (fs.existsSync(statePath)) {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            
            // Restore state
            activeTimelineSegments = state.segments || [];
            activeSkipRequests.clear();
            (state.skipRequests || []).forEach(([k, v]) => activeSkipRequests.set(k, v));
            recentlyUsedVideos.length = 0;
            (state.recentlyUsed || []).forEach(v => recentlyUsedVideos.push(v));
            
            console.log(`[Main] Loaded project state: ${projectId} (${activeTimelineSegments.length} segments)`);
            return true;
        }
    } catch (e) {
        console.error('[Main] Failed to load project state:', e);
    }
    return false;
}

// Track recently used video URLs to avoid repetition in nearby segments
// Structure: [{ url: string, segmentIndex: number }]
// Videos can be reused after 6 segments
const recentlyUsedVideos = [];
const VIDEO_REUSE_GAP = 6; // Allow reuse after 6 segments

// Helper to check if a video URL was used recently
function isVideoRecentlyUsed(url, currentSegmentIndex) {
    if (!url) return false;

    for (const entry of recentlyUsedVideos) {
        if (entry.url === url) {
            const gap = currentSegmentIndex - entry.segmentIndex;
            if (gap < VIDEO_REUSE_GAP) {
                return true; // Too recent, don't use
            }
        }
    }
    return false;
}

// Helper to mark a video as used
function markVideoAsUsed(url, segmentIndex) {
    if (!url) return;

    // Remove old entry for this URL if exists
    const existingIdx = recentlyUsedVideos.findIndex(e => e.url === url);
    if (existingIdx !== -1) {
        recentlyUsedVideos.splice(existingIdx, 1);
    }

    // Add new entry
    recentlyUsedVideos.push({ url, segmentIndex });

    // Clean up old entries (keep last 50)
    while (recentlyUsedVideos.length > 50) {
        recentlyUsedVideos.shift();
    }
}

// Helper to get URLs to exclude for a given segment
function getRecentlyUsedUrls(currentSegmentIndex) {
    const urlsToExclude = new Set();

    for (const entry of recentlyUsedVideos) {
        const gap = currentSegmentIndex - entry.segmentIndex;
        if (gap < VIDEO_REUSE_GAP && gap > 0) {
            urlsToExclude.add(entry.url);
        }
    }

    return urlsToExclude;
}


async function loadServices() {
    if (servicesLoaded) return true;

    console.log('[Services] Loading Smart Editor services...');

    // Use app.getAppPath() for correct path in both dev and production
    let appPath = app.getAppPath();

    // In production, services are in app.asar.unpacked


    const servicesPath = path.join(appPath, 'services');

    console.log('[Services] App path:', appPath);
    console.log('[Services] Services path:', servicesPath);
    console.log('[Services] isDev:', isDev);

    const toUrl = (p) => pathToFileURL(path.join(servicesPath, p)).href;

    try {
        console.log('[Services] Importing videoEditor...');
        const vedUrl = toUrl('videoEditor.js');
        console.log('[Services] URL:', vedUrl);
        videoEditorService = (await import(vedUrl)).default;
        console.log('[Services] videoEditor loaded');

        // Configure logo path for watermark (using correct path for both dev and production)
        const logoBasePath = appPath.includes('app.asar')
            ? appPath.replace('app.asar', 'app.asar.unpacked')
            : appPath;
        const logoPath = path.join(logoBasePath, 'assets', 'branding', 'logo.png');
        console.log('[Services] Configuring logo path:', logoPath);

        if (fs.existsSync(logoPath)) {
            videoEditorService.setLogoPath(logoPath);
            console.log('[Services] Logo configured successfully');
        } else {
            console.warn('[Services] Logo file not found at:', logoPath);
        }
    } catch (e) {
        console.error('[Services] videoEditor FAILED:', e.message);
    }

    try {
        console.log('[Services] Importing smartVideoFetcher...');
        const svfUrl = toUrl('smartVideoFetcher.js');
        console.log('[Services] URL:', svfUrl);
        smartFetcherService = (await import(svfUrl)).default;
        console.log('[Services] smartVideoFetcher loaded');
    } catch (e) {
        console.error('[Services] smartVideoFetcher FAILED:', e.message, e.stack);
    }

    try {
        console.log('[Services] Importing timelineManager...');
        timelineManagerService = (await import(toUrl('timeline/timelineManager.js'))).default;
        console.log('[Services] timelineManager loaded');
    } catch (e) {
        console.error('[Services] timelineManager FAILED:', e.message);
    }

    try {
        console.log('[Services] Importing sessionManager...');
        sessionManagerService = (await import(toUrl('browser/sessionManager.js'))).default;
        console.log('[Services] sessionManager loaded');
    } catch (e) {
        console.error('[Services] sessionManager FAILED:', e.message);
    }

    if (videoEditorService && smartFetcherService && timelineManagerService && sessionManagerService) {
        servicesLoaded = true;
        console.log('[Services] All Smart Editor services loaded successfully!');
        return true;
    } else {
        console.error('[Services] Some services failed to load');
        return false;
    }
}

// Load on app ready (not immediately)
app.whenReady().then(() => {
    loadServices();
});

ipcMain.handle('smart-session-login', async () => {
    console.log('[IPC] smart-session-login called');
    try {
        // Use lazy initialization with force login (show browser for manual login)
        const result = await ensureVioryReadyLazy(
            { forceLogin: false, minimizeAfterReady: false }, // Keep visible for user to verify
            (status) => {
                if (mainWindow) {
                    mainWindow.webContents.send('viory-status-update', status);
                }
            }
        );
        return result.success;
    } catch (e) {
        console.error('[IPC] Login failed:', e);
        return false;
    }
});

// Helper: Parse script text to extract segments from [ON SCREEN: ...] markers
function parseScriptToSegments(script) {
    const segments = [];
    const markerRegex = /\[ON\s*SCREEN[:\s-]*([^\]]+)\]/gi;
    const matches = Array.from(script.matchAll(markerRegex));

    if (matches.length === 0) {
        // Fallback: treat first line as headline
        const lines = script.trim().split('\n');
        if (lines.length > 0) {
            const text = lines.slice(1).join('\n');
            const words = text.split(/\s+/).length;
            segments.push({
                index: 0,
                headline: lines[0].substring(0, 80), // Use first line as headline
                text: text,
                query: lines[0].substring(0, 50).replace(/[^\w\s-]/g, '').trim() || 'news footage',
                duration: Math.max(5, Math.ceil(words / 2.5)),
                status: 'pending',
                video: null
            });
        }
        return segments;
    }

    for (let i = 0; i < matches.length; i++) {
        const headline = matches[i][1].trim();
        const textStart = matches[i].index + matches[i][0].length;
        const textEnd = (i < matches.length - 1) ? matches[i + 1].index : script.length;
        const text = script.substring(textStart, textEnd).trim();

        const words = text.split(/\s+/).length;
        const duration = Math.max(5, Math.ceil(words / 2.5));

        segments.push({
            index: i,
            headline: headline,
            text: text,
            query: headline.replace(/[^\w\s-]/g, '').trim() || 'news footage',
            duration: duration,
            status: 'pending',
            video: null
        });
    }

    console.log(`[Main] Parsed ${segments.length} segments from script`);
    return segments;
}

// Helper for basic timeline management if service fails
function createSimpleSegment(block, index) {
    // Extract query from multiple possible sources
    let query = 'news footage'; // Fallback

    // Priority 1: Use explicit title
    if (block.title && typeof block.title === 'string' && block.title.trim()) {
        query = block.title.trim();
    }
    // Priority 2: Use headline
    else if (block.headline && typeof block.headline === 'string' && block.headline.trim()) {
        query = block.headline.trim();
    }
    // Priority 3: Extract from text (first 50 chars)
    else if (block.text && typeof block.text === 'string' && block.text.trim()) {
        // Try to find ON SCREEN marker
        const onScreenMatch = block.text.match(/\[ON SCREEN:\s*([^\]]+)\]/i);
        if (onScreenMatch) {
            query = onScreenMatch[1].trim();
        } else {
            // Use first significant words
            query = block.text.substring(0, 80).replace(/[^\w\s-]/g, '').trim();
        }
    }

    // Safe keyword extraction
    const keywords = (query || '').split(' ').filter(w => w.length > 2);

    return {
        index,
        id: Date.now() + index,
        title: block.title,     // Preserve title
        headline: block.headline || block.title, // Preserve headline for UI
        text: block.text || block.description || '',
        keywords: keywords,
        query: query,
        duration: block.duration || 5,
        start_time: block.start_time, // CRITICAL: Preserve start time
        end_time: block.end_time,     // CRITICAL: Preserve end time
        status: 'pending',
        video: null
    };
}

// --- ROBUST PROCESSOR WITH INTELLIGENT SEARCH AND DOWNLOAD ---
// Uses the new intelligentSearchAndDownload() method with:
// - Gemini AI analysis for smart queries
// - Visual validation with Gemini Vision
// - Automatic My Content handling (wait 4 min, then try alternatives)
// @param excludeUrls - Optional Set of video URLs to exclude (used by "Find Different" to avoid repeating videos)
async function processSegmentRobustly(segment, logToUI, mainWindow, previousAnalysis = null, excludeUrls = null) {
    const VIDEO_MIN_MARGIN = 8; // seconds

    // CRITICAL: Set status to 'searching' at the START of processing
    segment.status = 'searching';
    if (mainWindow) mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });

    let finalVideoPath = null;
    let finalDuration = 0;
    let primaryVideo = null;

    // Log if we're excluding videos (Find Different mode)
    if (excludeUrls && excludeUrls.size > 0) {
        logToUI(`[Find Different] Excluding ${excludeUrls.size} previously used video(s) from search`);
    }

    const headline = segment.headline || segment.query || '';
    const text = segment.text || '';

    // Reset skip request for this segment at start
    activeSkipRequests.delete(segment.index);

    logToUI(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    logToUI(`[Segment ${segment.index + 1}] Starting Intelligent Search`);
    logToUI(`[Headline] "${headline.substring(0, 60)}${headline.length > 60 ? '...' : ''}"`);

    try {
        // Get Gemini API key
        const geminiApiKey = getGeminiApiKey();

        // Use the new intelligent search and download method
        const result = await vioryDownloader.intelligentSearchAndDownload(
            headline,
            text,
            geminiApiKey,
            {
                myContentWaitMinutes: 4,
                maxCandidatesToTry: 5,
                // Pass URLs to exclude (recently used videos)
                excludeUrls: excludeUrls || new Set(),
                segmentIndex: segment.index,
                // Pass skip check function so the downloader can check for user skip requests
                shouldSkip: () => shouldSkipSegment(segment.index),
                onProgress: (progress) => {
                    // Note: Skip is checked inside vioryDownloader via shouldSkip callback
                    // Don't throw here - errors in callbacks don't propagate correctly

                    // Send progress to UI
                    const stage = progress.stage;
                    const message = progress.message || '';

                    // Format log based on stage (can be number 1-6 or string)
                    if (typeof stage === 'number') {
                        // Stages from intelligentSearch: 1=AI, 2=Search, 3=Analysis, 4=Scoring, 5=Vision, 6=Ranking
                        switch (stage) {
                            case 1:
                                logToUI(`[AI] ${message}`);
                                break;
                            case 2:
                                logToUI(`[Search] ${message}`);
                                break;
                            case 3:
                                logToUI(`[Deep Analysis] ${message}`);
                                break;
                            case 4:
                                logToUI(`[Text Scoring] ${message}`);
                                break;
                            case 5:
                                // Visual validation - show detailed info
                                if (progress.recommendation) {
                                    const icon = progress.recommendation === 'ACCEPT' ? '✓' :
                                        progress.recommendation === 'REJECT' ? '✗' : '?';
                                    logToUI(`[Vision] ${icon} ${message}`);
                                } else {
                                    logToUI(`[Vision] ${message}`);
                                }
                                break;
                            case 6:
                                logToUI(`[Final Ranking] ${message}`);
                                break;
                            default:
                                logToUI(`[Stage ${stage}] ${message}`);
                        }
                    } else if (stage === 'search') {
                        logToUI(`[Search] ${message}`);
                    } else if (stage === 'download') {
                        logToUI(`[Download] ${message}`);
                    } else if (stage === 'myContent') {
                        logToUI(`[My Content] ${message}`);
                    } else if (message) {
                        logToUI(`[${stage || 'Info'}] ${message}`);
                    }
                }
            }
        );

        if (!result.success) {
            // Log skipped videos if any
            if (result.skippedVideos && result.skippedVideos.length > 0) {
                logToUI(`[Warning] Skipped ${result.skippedVideos.length} videos:`);
                result.skippedVideos.forEach((v, i) => {
                    logToUI(`  ${i + 1}. "${(v.title || '').substring(0, 40)}..." - ${v.reason}`);
                });
            }
            throw new Error(result.error || 'Intelligent search failed');
        }

        // Success! Extract video info
        primaryVideo = result.video;
        let currentPath = result.path;

        // DEBUG: Log full video object to see mandatoryCredit
        console.log(`[DEBUG] result.video keys:`, Object.keys(result.video || {}));
        console.log(`[DEBUG] result.video.mandatoryCredit:`, result.video?.mandatoryCredit || '(EMPTY)');

        // Verify we have a valid path
        if (!currentPath) {
            logToUI(`❌ Error: Download succeeded but no file path returned`);
            throw new Error('Download returned no file path');
        }

        // Verify file exists
        if (!fs.existsSync(currentPath)) {
            logToUI(`❌ Error: Downloaded file not found at: ${currentPath}`);
            throw new Error(`Downloaded file not found: ${currentPath}`);
        }

        logToUI(`✅ Found video: "${(primaryVideo.title || '').substring(0, 50)}..."`);
        logToUI(`   Score: ${primaryVideo.finalScore} (Text: ${primaryVideo.textScore}, Visual: ${primaryVideo.visualScore ?? 'N/A'})`);
        logToUI(`   Path: ${currentPath}`);
        if (primaryVideo.mandatoryCredit) {
            logToUI(`   Credit: ${primaryVideo.mandatoryCredit}`);
        }
        if (result.candidateNumber > 1) {
            logToUI(`   Note: Used candidate #${result.candidateNumber} (previous candidates skipped)`);
        }

        // Mark this video as used to prevent repetition in nearby segments
        if (primaryVideo.url) {
            markVideoAsUsed(primaryVideo.url, segment.index);
        }

        // Check duration and merge if needed
        if (!videoEditorService) await loadServices();
        let duration;
        try {
            duration = await videoEditorService.getMediaDuration(currentPath);
        } catch (durErr) {
            logToUI(`❌ Error getting video duration: ${durErr.message}`);
            throw new Error(`Failed to get video duration: ${durErr.message}`);
        }
        const requiredDuration = (segment.duration || 5) * 0.85; // 85% rule

        if (duration < requiredDuration) {
            logToUI(`⚠️ Video too short (${duration.toFixed(1)}s vs required ${segment.duration}s). Merging...`);

            const clipsToMerge = [currentPath];
            let accumulatedDuration = duration;

            // Use remaining videos from search results for merging
            const remainingVideos = (result.searchResults?.videos || [])
                .filter(v => v.url !== primaryVideo.url)
                .slice(0, 4);

            let extraVideoIndex = 0;

            while (accumulatedDuration < (segment.duration + VIDEO_MIN_MARGIN) && clipsToMerge.length < 5) {
                let extraVideo = remainingVideos[extraVideoIndex++];

                if (!extraVideo) {
                    logToUI(`Not enough unique videos, duplicating clip...`);
                    clipsToMerge.push(currentPath);
                    accumulatedDuration += duration;
                } else {
                    logToUI(`Fetching extra clip: ${(extraVideo.title || '').substring(0, 40)}...`);
                    // Use skipMyContent for extra clips to avoid long waits
                    const extraDl = await vioryDownloader.downloadVideo(extraVideo.url, null, { skipMyContent: true });
                    if (extraDl.success) {
                        clipsToMerge.push(extraDl.path);
                        const extraDur = await videoEditorService.getMediaDuration(extraDl.path);
                        accumulatedDuration += extraDur;
                        logToUI(`   Added ${extraDur.toFixed(1)}s clip`);
                    } else if (extraDl.needsMyContent) {
                        logToUI(`   Skipped (requires My Content)`);
                    }
                }
            }

            // Merge clips
            const mergedPath = path.join(app.getPath('userData'), 'video-downloads', `merged_${Date.now()}_${segment.index}.mp4`);
            await videoEditorService.mergeVideos(clipsToMerge, mergedPath);

            currentPath = mergedPath;
            duration = accumulatedDuration;
            logToUI(`✅ Merged ${clipsToMerge.length} clips. Final duration: ${duration.toFixed(1)}s`);

            if (mainWindow) mainWindow.webContents.send('show-toast', {
                type: 'info',
                title: 'Auto-Fix',
                message: `Combined ${clipsToMerge.length} clips for Segment ${segment.index + 1}`
            });
        }

        // Exact Trimming
        const trimmedPath = path.join(app.getPath('userData'), 'video-downloads', `segment_${segment.index}_exact_${Date.now()}.mp4`);

        try {
            logToUI(`✂️ Trimming to exact duration: ${segment.duration}s`);
            await videoEditorService.trimAndPrepareClip(currentPath, trimmedPath, {
                duration: segment.duration,
                startOffset: 0,
                volume: 0,
                fadeIn: 0.2,
                fadeOut: 0.2,
                headline: segment.headline || segment.title || ''
            });

            finalVideoPath = trimmedPath;
            finalDuration = segment.duration;
        } catch (err) {
            console.error("[Process] Trim failed, using raw video:", err);
            finalVideoPath = currentPath;
            finalDuration = duration;
        }

    } catch (error) {
        // Handle user-initiated skip separately from other errors
        if (error.message === 'SKIPPED_BY_USER') {
            logToUI(`⏭️ Search skipped by user`);
            segment.status = 'skipped';
            segment.video = null;
            if (mainWindow) mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });
            // Clear the skip request after handling
            activeSkipRequests.delete(segment.index);
            return; // Don't throw, just return
        }

        // Mark segment as error so it doesn't stay stuck in "searching"
        logToUI(`❌ Error: ${error.message}`);
        segment.status = 'error';
        segment.video = null;
        if (mainWindow) mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });
        throw error;
    }

    // Success - Update Segment
    const fileUrl = pathToFileURL(finalVideoPath).href;
    const extractedCredit = primaryVideo ? (primaryVideo.mandatoryCredit || '') : '';
    console.log(`[Process] Segment ${segment.index + 1} - MandatoryCredit: "${extractedCredit}"`);
    console.log(`[Process] Segment ${segment.index + 1} - Video Object Keys:`, primaryVideo ? Object.keys(primaryVideo) : 'NULL');

    // CRITICAL FIX: Verify actual duration of the final video file
    // This prevents duration mismatches that cause frozen frames at the end
    let verifiedDuration = finalDuration;
    try {
        verifiedDuration = await videoEditorService.getMediaDuration(finalVideoPath);
        const durationDiff = Math.abs(verifiedDuration - finalDuration);
        if (durationDiff > 0.5) {
            logToUI(`⚠️ Duration mismatch: expected ${finalDuration.toFixed(1)}s, actual ${verifiedDuration.toFixed(1)}s (diff: ${durationDiff.toFixed(1)}s)`);
            logToUI(`   Using actual duration: ${verifiedDuration.toFixed(1)}s`);
        } else {
            logToUI(`✓ Duration verified: ${verifiedDuration.toFixed(1)}s`);
        }
    } catch (e) {
        console.error(`[Process] Could not verify duration for segment ${segment.index + 1}:`, e);
        logToUI(`⚠️ Could not verify duration, using expected: ${finalDuration.toFixed(1)}s`);
    }

    segment.video = {
        url: fileUrl,
        previewUrl: fileUrl,
        thumbnail: '',
        duration: verifiedDuration,  // Use ACTUAL verified duration
        title: primaryVideo ? primaryVideo.title : 'Auto-Matched Video',
        mandatoryCredit: extractedCredit
    };
    segment.mandatoryCredit = segment.video.mandatoryCredit;
    segment._sourceVideoUrl = primaryVideo ? primaryVideo.url : null;
    segment.status = 'found';

    // CRITICAL FIX: Send UI update AFTER successful video assignment
    // This was missing and caused the last segment to appear stuck/not showing video
    if (mainWindow) {
        mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });
    }

    // Trigger segment rendering in background (non-blocking)
    // FIX: Use fileUrl (file:// URL format) instead of finalVideoPath (file path)
    // This ensures hash consistency between pre-render and export
    triggerSegmentRender(segment.index, {
        headline: segment.headline || segment.title || '',
        mandatoryCredit: extractedCredit,
        videoPath: fileUrl,  // FIX: Use file URL format for hash consistency
        duration: verifiedDuration  // FIX: Use verified duration for consistency
    }).catch(() => {
        // Non-fatal - export will still work
    });

    logToUI(`✅ Segment ${segment.index + 1} complete - video ready for review`);
    logToUI(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
}

ipcMain.handle('smart-fetch-timeline', async (event, { blocks, scriptText, projectId }) => {
    console.log('[IPC] smart-fetch-timeline called with', blocks?.length, 'blocks', 'project:', projectId);

    // Save previous project state if exists
    if (currentProjectId && currentProjectId !== projectId) {
        saveProjectState(currentProjectId);
    }

    // Clear state for new project
    clearProjectState();
    currentProjectId = projectId || `project_${Date.now()}`;

    // Try to load existing project state
    if (projectId && loadProjectState(projectId)) {
        console.log(`[IPC] Loaded existing project: ${projectId}`);
        if (mainWindow) {
            mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });
            mainWindow.webContents.send('smart-log', `📂 Restored project with ${activeTimelineSegments.length} segments`);
        }
        return { success: true, restored: true, projectId: currentProjectId };
    }

    // Attempt to load services but don't block if they fail (especially smartFetcher)
    await loadServices();

    // 1. Initialize Downloader - Simple and fast (login already done at app startup)
    if (!vioryDownloader) {
        vioryDownloader = new VioryDownloader();
        await vioryDownloader.init();
    }

    // 2. Build Timeline
    activeTimelineSegments = blocks.map((b, i) => ({
        ...b,
        index: i,
        status: 'pending'
    }));

    // Signal start
    if (mainWindow) {
        mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });
        mainWindow.webContents.send('smart-log', `🚀 Initializing Video Search for ${activeTimelineSegments.length} segments...`);
    }

    // Process sequentially (more reliable)
    (async () => {
        try {
            const vioryResult = await ensureVioryReadyLazy({ minimizeAfterReady: true });
            if (!vioryResult.success) {
                if (mainWindow) mainWindow.webContents.send('smart-log', `❌ Failed to initialize Viory: ${vioryResult.error}`);
                return;
            }

            for (let i = 0; i < activeTimelineSegments.length; i++) {
                const segment = activeTimelineSegments[i];
                const isLastSegment = (i === activeTimelineSegments.length - 1);

                // Get URLs to exclude (recently used in nearby segments)
                const excludeUrls = getRecentlyUsedUrls(segment.index);
                if (excludeUrls.size > 0) {
                    if (mainWindow) mainWindow.webContents.send('smart-log', `[Anti-Repeat] Excluding ${excludeUrls.size} recently used video(s)`);
                }

                try {
                    // Ensure browser is still alive before each segment
                    if (vioryDownloader) {
                        await vioryDownloader.ensurePage();
                    }

                    await processSegmentRobustly(segment, (msg) => {
                        if (mainWindow) mainWindow.webContents.send('smart-log', msg);
                    }, mainWindow, null, excludeUrls);

                    // ROBUSTNESS: Extra update after each segment completes successfully
                    // This ensures UI always reflects the latest state
                    if (mainWindow) {
                        mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });
                    }

                } catch (err) {
                    console.error(`[Fetch] Error processing segment ${segment.index}:`, err);

                    // Check if browser crashed and needs recovery
                    if (err.message && (err.message.includes('Target closed') ||
                        err.message.includes('browser') ||
                        err.message.includes('disconnected') ||
                        err.message.includes('Protocol error'))) {
                        if (mainWindow) mainWindow.webContents.send('smart-log', `⚠️ Browser issue detected, recovering...`);
                        try {
                            // Force re-initialization
                            if (vioryDownloader) {
                                vioryDownloader.browser = null;
                                vioryDownloader.page = null;
                                await vioryDownloader.init({ headless: false });
                                if (mainWindow) mainWindow.webContents.send('smart-log', `✓ Browser recovered`);
                            }
                        } catch (recoveryErr) {
                            console.error('[Fetch] Browser recovery failed:', recoveryErr);
                        }
                    }

                    // Mark segment as error but DON'T stop the entire process
                    segment.status = 'error';

                    // CRITICAL FIX: Add placeholder clip to maintain timeline synchronization
                    if (videoEditorService) {
                        try {
                            if (mainWindow) mainWindow.webContents.send('smart-log', `⚠️ Generating placeholder for Segment ${segment.index + 1} to keep sync...`);

                            // Use default duration if segment doesn't have one
                            const duration = segment.duration || 5;
                            await videoEditorService.addPlaceholderClip(segment.index, duration);

                            // Update segment video info so UI shows something (even if placeholder)
                            // We don't set a URL so it might show as missing in some UI parts, but timeline is safe
                            segment.status = 'error_handled';

                        } catch (phError) {
                            console.error('[Fetch] Failed to create placeholder:', phError);
                        }
                    }

                    if (mainWindow) {
                        mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });
                        mainWindow.webContents.send('smart-log', `⚠️ Segment ${segment.index + 1} failed, placeholder added.`);
                    }
                    // Continue to next segment instead of stopping
                }
            }

            // CRITICAL: Final update to ensure ALL segments are synced to UI
            if (mainWindow) {
                mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });
                mainWindow.webContents.send('smart-log', `✅ Timeline processing complete!`);
            }

        } catch (err) {
            console.error('[Fetch] Fatal error in timeline loop:', err);
            if (mainWindow) mainWindow.webContents.send('smart-log', `❌ Fatal Error: ${err.message}`);
        }
    })();

    return { success: true };
});

ipcMain.handle('smart-download-zip', async (event, segments) => {
    if (!segments || segments.length === 0) throw new Error("No segments to zip");

    const { filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Save Segments ZIP',
        defaultPath: 'segments.zip',
        filters: [{ name: 'ZIP Files', extensions: ['zip'] }]
    });

    if (!filePath) return { canceled: true };

    const zip = new JSZip();
    let count = 0;

    for (const seg of segments) {
        if (seg.video && seg.video.url) {
            try {
                // Remove file:// prefix
                const videoPath = new URL(seg.video.url).pathname;
                // Fix windows path if needed (leading /)
                const cleanPath = process.platform === 'win32' && videoPath.startsWith('/') ? videoPath.slice(1) : videoPath;
                const decodedPath = decodeURIComponent(cleanPath);

                if (fs.existsSync(decodedPath)) {
                    const fileName = `segment_${seg.index + 1}_${sanitizeFilename(seg.headline || 'video')}.mp4`;
                    const fileData = fs.readFileSync(decodedPath);
                    zip.file(fileName, fileData);
                    count++;
                }
            } catch (e) {
                console.error(`Failed to zip segment ${seg.index}:`, e);
            }
        }
    }

    const content = await zip.generateAsync({ type: 'nodebuffer' });
    fs.writeFileSync(filePath, content);

    // Open folder
    shell.showItemInFolder(filePath);

    return { success: true, count };
});

function sanitizeFilename(name) {
    return name.replace(/[^a-z0-9]/gi, '_').substring(0, 50);
}

// Scraper Window Controls
ipcMain.handle('scraper-window-control', async (event, action) => {
    if (!vioryDownloader) return false;
    // We haven't implemented these methods in VioryDownloader yet, but will next step
    try {
        if (action === 'minimize') await vioryDownloader.minimize();
        if (action === 'maximize') await vioryDownloader.maximize();
        if (action === 'close') await vioryDownloader.close();
        if (action === 'show') await vioryDownloader.show();
        return true;
    } catch (e) {
        console.error('Scraper control error:', e);
        return false;
    }
});

ipcMain.handle('smart-skip-search', async (event, segmentIndex) => {
    console.log(`[IPC] smart-skip-search called for segment ${segmentIndex}`);
    activeSkipRequests.set(segmentIndex, true);
    return { success: true };
});

ipcMain.handle('viory:manual-video', async (event, { segmentIndex, videoUrl }) => {
    console.log(`[IPC] viory:manual-video called for segment ${segmentIndex}, url: ${videoUrl}`);

    try {
        // Validate URL before attempting anything
        if (!videoUrl || !videoUrl.includes('viory.video')) {
            return { success: false, message: 'Invalid URL. Please use a viory.video link.' };
        }

        await loadServices();

        // Initialize Viory downloader if needed
        if (!vioryDownloader) {
            vioryDownloader = new VioryDownloader();
            await vioryDownloader.init({ headless: false });
        }

        // Ensure browser is alive
        await vioryDownloader.ensurePage();

        const vioryResult = await ensureVioryReadyLazy({ minimizeAfterReady: true });
        if (!vioryResult.success) throw new Error('Failed to connect to Viory. Please try again.');

        if (!activeTimelineSegments || activeTimelineSegments.length === 0) {
            throw new Error('No active timeline. Please start video search first.');
        }

        if (segmentIndex < 0 || segmentIndex >= activeTimelineSegments.length) {
            throw new Error(`Invalid segment index: ${segmentIndex}`);
        }

        if (!activeTimelineSegments[segmentIndex]) {
            throw new Error('Segment not found in timeline.');
        }

        const segment = activeTimelineSegments[segmentIndex];
        const logToUI = (msg) => {
            console.log(`[Manual] ${msg}`);
            if (mainWindow) mainWindow.webContents.send('smart-log', msg);
        };

        logToUI(`📥 Manual download for Segment ${segmentIndex + 1}: ${videoUrl}`);
        segment.status = 'searching';
        if (mainWindow) mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });

        // Download using ISOLATED page - prevents interference with ongoing segment downloads
        logToUI(`🔒 Using isolated browser page for manual download...`);
        const downloadResult = await vioryDownloader.downloadVideoIsolated(videoUrl, (p) => {
            if (p.message) logToUI(`[Download] ${p.message}`);
        });

        if (!downloadResult.success) {
            if (downloadResult.needsMyContent) {
                throw new Error('This video requires processing ("We are preparing your video"). Please choose a different video that is ready for download.');
            }
            throw new Error(downloadResult.message || 'Download failed');
        }

        // Apply video to segment (similar to processSegmentRobustly success path)
        const downloadedPath = downloadResult.path;
        if (!videoEditorService) {
            const loadResult = await loadServices();
            if (!loadResult || !videoEditorService) {
                throw new Error('Video editor service not available. Please restart the app.');
            }
        }
        const rawDuration = await videoEditorService.getMediaDuration(downloadedPath);

        // Get video title from download result (it's extracted during download)
        const videoTitle = downloadResult.videoTitle || downloadResult.filename?.replace(/\.[^/.]+$/, '') || 'Manual Video';

        // Check duration mismatch - STRICT: reject if too short
        const segmentDuration = segment.duration || 5;
        const minimumRequired = segmentDuration * 0.8; // Allow 20% margin
        const isTooShort = rawDuration < minimumRequired;

        if (isTooShort) {
            logToUI(`❌ Video too short: ${rawDuration.toFixed(1)}s (need at least ${minimumRequired.toFixed(1)}s for ${segmentDuration}s segment)`);
            // Clean up downloaded file
            try { fs.unlinkSync(downloadedPath); } catch (e) { /* ignore */ }
            return {
                success: false,
                isTooShort: true,
                videoDuration: rawDuration,
                requiredDuration: segmentDuration,
                minimumRequired: minimumRequired,
                message: `Video is too short (${rawDuration.toFixed(1)}s). This segment needs at least ${minimumRequired.toFixed(1)}s. Please choose a longer video.`
            };
        }

        logToUI(`✓ Video duration OK: ${rawDuration.toFixed(1)}s (segment needs ${segmentDuration}s)`);

        // CRITICAL: Trim the video to exact segment duration (same as processSegmentRobustly)
        // This ensures the manual video doesn't mess up the timeline
        let finalVideoPath = downloadedPath;
        let finalDuration = rawDuration;

        try {
            const trimmedPath = path.join(app.getPath('userData'), 'video-downloads', `segment_${segmentIndex}_manual_${Date.now()}.mp4`);
            logToUI(`✂️ Trimming manual video to segment duration: ${segmentDuration}s`);

            await videoEditorService.trimAndPrepareClip(downloadedPath, trimmedPath, {
                duration: segmentDuration,
                startOffset: 0,
                volume: 0,
                fadeIn: 0.2,
                fadeOut: 0.2,
                headline: segment.headline || segment.title || ''
            });

            finalVideoPath = trimmedPath;
            finalDuration = segmentDuration;
            logToUI(`✓ Video trimmed to ${segmentDuration}s`);
        } catch (trimErr) {
            console.error('[Manual] Trim failed, using raw video:', trimErr);
            logToUI(`⚠️ Trim failed, using original video (may cause timeline issues)`);
            // Fall back to raw video but warn user
        }

        const fileUrl = pathToFileURL(finalVideoPath).href;
        const extractedCredit = downloadResult.mandatoryCredit || '';
        if (extractedCredit) {
            logToUI(`📝 Mandatory Credit: "${extractedCredit}"`);
        }
        
        // CRITICAL FIX: Verify actual duration of the final video file
        // This prevents duration mismatches that cause frozen frames at the end
        let verifiedDuration = finalDuration;
        try {
            verifiedDuration = await videoEditorService.getMediaDuration(finalVideoPath);
            if (Math.abs(verifiedDuration - finalDuration) > 0.5) {
                logToUI(`⚠️ Duration mismatch detected: expected ${finalDuration}s, actual ${verifiedDuration.toFixed(1)}s`);
                logToUI(`   Using actual duration: ${verifiedDuration.toFixed(1)}s`);
            } else {
                logToUI(`✓ Duration verified: ${verifiedDuration.toFixed(1)}s`);
            }
        } catch (e) {
            console.error('[Manual] Could not verify duration:', e);
            logToUI(`⚠️ Could not verify duration, using expected: ${finalDuration}s`);
        }
        
        segment.video = {
            url: fileUrl,
            previewUrl: fileUrl,
            thumbnail: '',  // Could be generated but would slow down the flow
            duration: verifiedDuration,  // Use ACTUAL verified duration
            title: videoTitle,
            mandatoryCredit: extractedCredit
        };
        segment.mandatoryCredit = extractedCredit;  // Also set on segment directly
        segment.status = 'found';
        segment._sourceVideoUrl = videoUrl;

        // Send immediate update so UI reflects the change
        if (mainWindow) mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });
        logToUI(`✅ Manual video applied to Segment ${segmentIndex + 1} (${finalDuration.toFixed(1)}s)`);

        // Trigger segment rendering in background (non-blocking)
        // FIX: Use fileUrl (file:// URL format) instead of finalVideoPath (file path)
        // This ensures hash consistency between pre-render and export
        triggerSegmentRender(segmentIndex, {
            headline: segment.headline || segment.title || '',
            mandatoryCredit: extractedCredit,
            videoPath: fileUrl,  // FIX: Use file URL format for hash consistency
            duration: verifiedDuration  // FIX: Use verified duration for consistency
        }).catch(() => {
            // Non-fatal - export will still work
        });

        return {
            success: true,
            duration: verifiedDuration,
            requiredDuration: segment.duration || 5,
            isTooShort: isTooShort,
            videoTitle: videoTitle
        };

    } catch (error) {
        console.error('[viory:manual-video] Error:', error);
        if (mainWindow) mainWindow.webContents.send('smart-log', `❌ Manual failed: ${error.message}`);
        if (activeTimelineSegments && activeTimelineSegments[segmentIndex]) {
            activeTimelineSegments[segmentIndex].status = 'error';
            if (mainWindow) mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });
        }
        return { success: false, message: error.message };
    }
});

ipcMain.handle('smart-replace-clip', async (event, segmentIndex) => {
    console.log(`[IPC] smart-replace-clip called for segment ${segmentIndex}`);

    try {
        // Validate segment index
        if (typeof segmentIndex !== 'number' || segmentIndex < 0) {
            return { success: false, message: 'Invalid segment index' };
        }

        // Ensure services are loaded
        await loadServices();

        // Initialize Viory downloader if needed
        if (!vioryDownloader) {
            vioryDownloader = new VioryDownloader();
            await vioryDownloader.init({ headless: false });
        }

        // Ensure browser is alive
        await vioryDownloader.ensurePage();

        // Initialize Viory lazily - minimize browser for background operation
        const vioryResult = await ensureVioryReadyLazy(
            { minimizeAfterReady: true },
            (status) => {
                if (mainWindow) {
                    mainWindow.webContents.send('viory-status-update', status);
                }
            }
        );

        if (!vioryResult.success) {
            return { success: false, message: 'Failed to connect to Viory. Please try again.' };
        }

        // Use the module-level activeTimelineSegments
        if (!activeTimelineSegments || activeTimelineSegments.length === 0) {
            console.error('[smart-replace-clip] No active timeline segments');
            return { success: false, message: 'No active timeline. Start processing first.' };
        }

        if (segmentIndex >= activeTimelineSegments.length) {
            return { success: false, message: `Segment ${segmentIndex} does not exist` };
        }

        const segment = activeTimelineSegments[segmentIndex];

        if (!segment) {
            return { success: false, message: `Segment ${segmentIndex} not found` };
        }


        // Helper: Log to UI
        const logToUI = (msg) => {
            console.log(`[Replace] ${msg}`);
            if (mainWindow) {
                mainWindow.webContents.send('smart-log', msg);
            }
        };

        logToUI(`🔄 Replacing video for Segment ${segmentIndex + 1}: "${segment.headline || segment.query}"`);

        // FIND DIFFERENT FIX: Save current video URL to exclude it from new search
        // Initialize rejected URLs list if not exists
        if (!segment._rejectedUrls) {
            segment._rejectedUrls = [];
        }

        // If segment has a current video, add its URL to rejected list
        if (segment.video && segment.video.url) {
            const currentUrl = segment.video.url;
            // Extract original Viory URL if it's a file:// URL (the downloaded file)
            // We need to track the source URL, not the local file path
            if (segment._sourceVideoUrl) {
                segment._rejectedUrls.push(segment._sourceVideoUrl);
                logToUI(`[Replace] Excluding previous video: ${segment._sourceVideoUrl.substring(0, 60)}...`);
            }
        }

        // Create Set of URLs to exclude
        const excludeUrls = new Set(segment._rejectedUrls);
        logToUI(`[Replace] Excluding ${excludeUrls.size} previously used video(s)`);

        // Mark as searching
        segment.status = 'searching';
        segment.video = null;
        if (mainWindow) mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });

        // Process the segment again, passing excluded URLs to find a DIFFERENT video
        await processSegmentRobustly(segment, logToUI, mainWindow, null, excludeUrls);

        // Send updated timeline
        if (mainWindow) mainWindow.webContents.send('smart-timeline-update', { segments: activeTimelineSegments });

        logToUI(`✅ Replacement complete for Segment ${segmentIndex + 1}`);

        return { success: true };

    } catch (error) {
        console.error('[smart-replace-clip] Error:', error);
        if (mainWindow) {
            mainWindow.webContents.send('smart-log', `❌ Replace failed: ${error.message}`);
        }
        return { success: false, message: error.message };
    }
});


ipcMain.handle('smart-generate-preview', async () => {
    if (!videoEditorService) throw new Error('Editor Service not ready');
    // Returns path to preview file
    const previewPath = await videoEditorService.generateFullPreview();
    // Convert to file:// URL for renderer
    return `file://${previewPath}`;
});

ipcMain.handle('dialog:open-directory', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (canceled) {
        return null;
    } else {
        return filePaths[0];
    }
});

// Native file dialog for audio - returns the REAL file path (like pro editors)
ipcMain.handle('dialog:open-audio', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Select Voiceover Audio',
        properties: ['openFile'],
        filters: [
            { name: 'Audio Files', extensions: ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'flac'] }
        ]
    });

    if (canceled || filePaths.length === 0) {
        return null;
    }

    const filePath = filePaths[0];
    const fileName = path.basename(filePath);
    const stats = fs.statSync(filePath);

    console.log('[Main] Audio file selected:', filePath);

    return {
        path: filePath,
        name: fileName,
        size: stats.size
    };
});

// Fix for missing audio: Explicitly set the narration audio
ipcMain.handle('smart-set-audio', async (event, audioPath) => {
    console.log('[IPC] smart-set-audio called with:', audioPath);

    if (!audioPath) {
        console.warn('[smart-set-audio] No audio path provided');
        return false;
    }

    try {
        if (!videoEditorService) {
            console.log('[smart-set-audio] Loading services...');
            await loadServices();
        }

        if (!videoEditorService) {
            console.error('[smart-set-audio] videoEditorService still not available after loadServices');
            return false;
        }

        // Convert file:// if needed
        let cleanPath = audioPath;
        if (cleanPath.startsWith('file://')) {
            cleanPath = cleanPath.replace('file:///', '').replace('file://', '');
            cleanPath = decodeURIComponent(cleanPath);
        }

        // Verify file exists
        if (!fs.existsSync(cleanPath)) {
            console.error('[smart-set-audio] Audio file does not exist:', cleanPath);
            return false;
        }

        console.log('[smart-set-audio] Loading audio from:', cleanPath);
        await videoEditorService.loadNarrationAudio(cleanPath);
        console.log('[smart-set-audio] Audio loaded successfully. Duration:', videoEditorService.narrationAudio?.duration);
        return true;
    } catch (err) {
        console.error('[smart-set-audio] Error:', err);
        return false;
    }
});

ipcMain.handle('smart-export-final', async (event, options) => {
    if (!videoEditorService) throw new Error('Editor Service not ready');

    console.log('[Export] smart-export-final called with options:', JSON.stringify(options, null, 2));

    // DEBUG: Log activeTimelineSegments to see mandatoryCredit - WRITE TO FILE
    const debugLogPath = path.join(os.homedir(), 'ClickStudio', 'export-debug.log');
    const debugLog = (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}\n`;
        console.log(msg);
        try { fs.appendFileSync(debugLogPath, line); } catch (e) { }
    };

    debugLog(`[Export] DEBUG: activeTimelineSegments count: ${activeTimelineSegments.length}`);
    activeTimelineSegments.forEach((seg, i) => {
        debugLog(`[Export] DEBUG: Segment ${i} - mandatoryCredit: "${seg.mandatoryCredit || '(EMPTY)'}", video.mandatoryCredit: "${seg.video?.mandatoryCredit || '(EMPTY)'}"`);
    });

    // CRITICAL FIX: Ensure audio is loaded before export
    // The audioFilePath is passed from EditorView export options
    if (options.audioFilePath) {
        let audioPath = options.audioFilePath;

        // Convert file:// URL if needed
        if (audioPath.startsWith('file://')) {
            audioPath = audioPath.replace('file:///', '').replace('file://', '');
            audioPath = decodeURIComponent(audioPath);
        }

        console.log('[Export] Loading narration audio from:', audioPath);

        try {
            if (fs.existsSync(audioPath)) {
                await videoEditorService.loadNarrationAudio(audioPath);
                console.log('[Export] Narration audio loaded successfully');
            } else {
                console.error('[Export] Audio file does not exist:', audioPath);
            }
        } catch (audioErr) {
            console.error('[Export] Failed to load narration audio:', audioErr);
            // Don't throw - continue export, but warn
        }
    } else {
        console.warn('[Export] No audioFilePath provided in options! Video will export without voiceover.');
    }

    // Build clip list from activeTimelineSegments - CRITICAL FIX
    // The VideoEditorEngine's internal timeline is never populated by the current flow
    // So we need to populate it here from the actual segments
    const sortedSegments = [...activeTimelineSegments].sort((a, b) => a.index - b.index);

    // Clear and rebuild the timeline
    videoEditorService.timeline = [];

    for (const seg of sortedSegments) {
        if (!seg.video || !seg.video.url) {
            console.warn(`[Export] Segment ${seg.index} has no video, skipping.`);
            continue;
        }

        // Convert file:// URL back to filesystem path
        let videoPath = seg.video.url;
        if (videoPath.startsWith('file://')) {
            videoPath = videoPath.replace('file:///', '').replace('file://', '');
            // Decode URI encoding (e.g., %20 -> space)
            videoPath = decodeURIComponent(videoPath);
        }

        // Add to the internal timeline used by exportFinalVideo
        videoEditorService.timeline.push({
            index: seg.index,
            processedVideo: videoPath,
            duration: seg.duration || seg.video.duration || 5
        });

        console.log(`[Export] Added clip ${seg.index}: ${videoPath}`);
    }

    console.log(`[Export] Timeline prepared with ${videoEditorService.timeline.length} clips.`);
    console.log(`[Export] Narration audio loaded:`, videoEditorService.narrationAudio ? 'YES' : 'NO');

    // Build segments data for overlays (lower thirds + mandatory credits)
    const segmentsForOverlays = sortedSegments
        .filter(seg => seg.video && seg.video.url)
        .map((seg, idx) => ({
            index: idx,
            headline: seg.headline || seg.title || '',
            title: seg.title || seg.headline || '',
            duration: seg.duration || seg.video.duration || 5,
            startTime: seg.startTime || 0,
            endTime: seg.endTime || (seg.startTime || 0) + (seg.duration || 5),
            // Mandatory credit from video metadata (extracted from Viory Restrictions section)
            mandatoryCredit: seg.mandatoryCredit || seg.video?.mandatoryCredit || ''
        }));

    // Log mandatory credits found - DEBUG: Show each segment's mandatoryCredit
    const creditsFound = segmentsForOverlays.filter(s => s.mandatoryCredit).length;
    console.log(`[Export] Segments for overlays: ${segmentsForOverlays.length} (${creditsFound} with mandatory credits)`);

    // DEBUG: Log each segment's mandatory credit status
    segmentsForOverlays.forEach((seg, i) => {
        console.log(`[Export] Segment ${i}: headline="${(seg.headline || '').substring(0, 30)}..." mandatoryCredit="${seg.mandatoryCredit || '(EMPTY)'}"`);
    });

    // Merge options with segments data
    // Lower thirds and mandatory credits enabled - using pre-bundled Remotion
    const exportOptions = {
        ...options,
        segments: segmentsForOverlays,
        enableLowerThirds: true, // Lower third overlays (bottom, titulares)
        enableMandatoryCredits: true // Mandatory credit overlays (top-left corner)
    };

    return await videoEditorService.exportFinalVideo(exportOptions, (progress) => {
        mainWindow.webContents.send('smart-export-progress', progress);
    });
});

// Cancel export handler
ipcMain.handle('smart-cancel-export', async () => {
    console.log('[Export] Cancel requested');
    if (videoEditorService && videoEditorService.cancelExport) {
        videoEditorService.cancelExport();
        return { success: true };
    }
    return { success: false, error: 'No active export to cancel' };
});

// ============ GPU INFO FOR UI ============
ipcMain.handle('get-gpu-info', async () => {
    try {
        if (!videoEditorService) {
            await loadServices();
        }

        if (videoEditorService && videoEditorService.getGPUInfo) {
            const gpuInfo = videoEditorService.getGPUInfo();
            console.log('[GPU Info] Returning to UI:', gpuInfo);
            return gpuInfo;
        }

        return {
            detected: { type: 'Unknown', encoder: 'libx264', name: 'Unknown' },
            encoders: { h264: 'libx264', h265: 'libx265' },
            isHardwareAccelerated: false,
            scanComplete: false
        };
    } catch (err) {
        console.error('[GPU Info] Error:', err);
        return {
            detected: { type: 'Error', encoder: 'libx264', name: err.message },
            encoders: { h264: 'libx264', h265: 'libx265' },
            isHardwareAccelerated: false,
            scanComplete: false,
            error: err.message
        };
    }
});

ipcMain.handle('smart-sync-timeline', (event, blocks) => {
    if (timelineManagerService) {
        return timelineManagerService.loadSegmentsFromBlocks(blocks);
    }
    return [];
});

ipcMain.handle('smart-get-timeline', () => {
    if (timelineManagerService) return timelineManagerService.getTimelineForUI();
    return { segments: [] };
});

ipcMain.handle('smart-update-clip-option', (event, { index, prop, value }) => {
    if (timelineManagerService && timelineManagerService.segments[index] && timelineManagerService.segments[index].video) {
        if (!timelineManagerService.segments[index].video.options) timelineManagerService.segments[index].video.options = {};
        timelineManagerService.segments[index].video.options[prop] = value;
        return true;
    }
    return false;
});

// ============ PRE-RENDER OVERLAYS IN BACKGROUND ============
// This allows rendering lower thirds and mandatory credits while user works
// Speeds up final export significantly
// Uses OverlayPreRenderService for queue management and prioritization

let overlayPreRenderService = null;

async function getOverlayPreRenderService() {
    if (!overlayPreRenderService) {
        try {
            const module = await import('../services/overlayPreRenderService.js');
            overlayPreRenderService = module.default;
            await overlayPreRenderService.initialize();
            console.log('[PreRender] OverlayPreRenderService initialized');
        } catch (e) {
            console.error('[PreRender] Failed to initialize OverlayPreRenderService:', e.message);
            return null;
        }
    }
    return overlayPreRenderService;
}

ipcMain.handle('prerender-overlay', async (event, { type, data }) => {
    try {
        const service = await getOverlayPreRenderService();

        if (service) {
            if (type === 'lowerthird' && data.headline) {
                const task = service.enqueueLowerThird({
                    headline: data.headline,
                    segmentId: data.segmentId || 0,
                    durationInSeconds: data.duration || 5,
                    priority: data.priority || 3 // LOW priority by default
                });
                return { queued: true, type: 'lowerthird', taskId: task?.id };
            }

            if (type === 'mandatory' && data.text) {
                const task = service.enqueueMandatoryCredit({
                    text: data.text,
                    segmentId: data.segmentId || 0,
                    durationInSeconds: data.duration || 5,
                    priority: data.priority || 3
                });
                return { queued: true, type: 'mandatory', taskId: task?.id };
            }
        } else {
            // Fallback to direct renderer call if service unavailable
            if (type === 'lowerthird' && data.headline) {
                const lowerThirdRenderer = (await import('../services/lowerThirdRenderer.js')).default;
                lowerThirdRenderer.preRender({
                    headline: data.headline,
                    segmentId: data.segmentId || 0,
                    durationInSeconds: data.duration || 5
                }).catch(e => console.log('[PreRender] LowerThird background render:', e.message));
                return { queued: true, type: 'lowerthird' };
            }

            if (type === 'mandatory' && data.text) {
                const mandatoryCreditRenderer = (await import('../services/mandatoryCreditRenderer.js')).default;
                mandatoryCreditRenderer.preRender({
                    text: data.text,
                    segmentId: data.segmentId || 0,
                    durationInSeconds: data.duration || 5
                }).catch(e => console.log('[PreRender] MandatoryCredit background render:', e.message));
                return { queued: true, type: 'mandatory' };
            }
        }

        return { queued: false, error: 'Unknown type or missing data' };
    } catch (e) {
        console.error('[PreRender] Error:', e.message);
        return { queued: false, error: e.message };
    }
});

// Pre-render multiple overlays at once (batch) with priority queue
ipcMain.handle('prerender-overlays-batch', async (event, segments) => {
    if (!Array.isArray(segments)) return { queued: 0 };

    try {
        const service = await getOverlayPreRenderService();

        if (service) {
            // Use service's batch method for optimal scheduling
            const tasks = service.preRenderSegments(segments, 3); // LOW priority
            console.log(`[PreRender] Queued ${tasks.length} overlays for background rendering`);
            return { queued: tasks.length, total: segments.length };
        } else {
            // Fallback to direct renderer calls
            let queued = 0;
            const lowerThirdRenderer = (await import('../services/lowerThirdRenderer.js')).default;
            const mandatoryCreditRenderer = (await import('../services/mandatoryCreditRenderer.js')).default;

            for (let i = 0; i < segments.length; i++) {
                const seg = segments[i];

                if (seg.headline || seg.title) {
                    lowerThirdRenderer.preRender({
                        headline: seg.headline || seg.title,
                        segmentId: i,
                        durationInSeconds: 5
                    }).catch(() => { });
                    queued++;
                }

                if (seg.mandatoryCredit) {
                    mandatoryCreditRenderer.preRender({
                        text: seg.mandatoryCredit,
                        segmentId: i,
                        durationInSeconds: 5
                    }).catch(() => { });
                    queued++;
                }
            }

            console.log(`[PreRender] Queued ${queued} overlays for background rendering (fallback mode)`);
            return { queued, total: segments.length };
        }
    } catch (e) {
        console.error('[PreRender] Batch error:', e.message);
        return { queued: 0, error: e.message };
    }
});

// Prioritize a segment (when user selects it in editor)
ipcMain.handle('prerender-prioritize-segment', async (event, segmentId) => {
    try {
        const service = await getOverlayPreRenderService();
        if (service) {
            service.prioritizeSegment(segmentId);
            return { success: true };
        }
        return { success: false, error: 'Service not available' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Handle text change with debounce (from editor)
ipcMain.handle('prerender-text-change', async (event, { type, content, segmentId, durationInSeconds }) => {
    try {
        const service = await getOverlayPreRenderService();
        if (service) {
            service.onTextChange({ type, content, segmentId, durationInSeconds });
            return { success: true };
        }
        return { success: false, error: 'Service not available' };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Get cache statistics (enhanced with queue info)
ipcMain.handle('get-overlay-cache-stats', async () => {
    try {
        const service = await getOverlayPreRenderService();

        if (service) {
            return {
                service: service.getStats(),
                queue: service.getQueueStatus()
            };
        }

        // Fallback
        const lowerThirdRenderer = (await import('../services/lowerThirdRenderer.js')).default;
        const mandatoryCreditRenderer = (await import('../services/mandatoryCreditRenderer.js')).default;

        return {
            lowerThirds: lowerThirdRenderer.getCacheStats(),
            mandatoryCredits: mandatoryCreditRenderer.getCacheStats()
        };
    } catch (e) {
        return { error: e.message };
    }
});

// Pause/Resume pre-rendering (useful during export)
ipcMain.handle('prerender-pause', async () => {
    try {
        const service = await getOverlayPreRenderService();
        if (service) {
            service.pause();
            return { success: true };
        }
        return { success: false };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('prerender-resume', async () => {
    try {
        const service = await getOverlayPreRenderService();
        if (service) {
            service.resume();
            return { success: true };
        }
        return { success: false };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Clear pre-render cache
ipcMain.handle('prerender-clear-cache', async () => {
    try {
        const service = await getOverlayPreRenderService();
        if (service) {
            service.clearCache();
            return { success: true };
        }
        return { success: false };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// --- RECOVERY LOGIC (Persistent JSON) ---
// These handlers are registered at module load time to ensure they're available immediately

const getRecoveryPath = () => path.join(app.getPath('userData'), 'recovery.json');

ipcMain.handle('smart-save-recovery', async (event, data) => {
    console.log('[Recovery] smart-save-recovery called');
    try {
        const recoveryPath = getRecoveryPath();
        fs.writeFileSync(recoveryPath, JSON.stringify(data, null, 2));
        console.log('[Recovery] Saved recovery data to:', recoveryPath);
        return { success: true };
    } catch (e) {
        console.error('[Recovery] Failed to save recovery:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('smart-clear-recovery', async () => {
    console.log('[Recovery] smart-clear-recovery called');
    try {
        const recoveryPath = getRecoveryPath();
        if (fs.existsSync(recoveryPath)) {
            fs.unlinkSync(recoveryPath);
            console.log('[Recovery] Cleared recovery file');
        } else {
            console.log('[Recovery] No recovery file to clear');
        }
        return { success: true };
    } catch (e) {
        console.error('[Recovery] Failed to clear recovery:', e);
        return { success: false, error: e.message };
    }
});

ipcMain.handle('smart-check-recovery', async () => {
    console.log('[Recovery] smart-check-recovery called');
    try {
        const recoveryPath = getRecoveryPath();
        if (fs.existsSync(recoveryPath)) {
            const data = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
            console.log('[Recovery] Found recovery data for:', data.name);
            return { found: true, data };
        }
        console.log('[Recovery] No recovery data found');
        return { found: false };
    } catch (e) {
        console.error('[Recovery] Failed to check recovery:', e);
        return { found: false, error: e.message };
    }
});

// ============================================================================
// SEGMENT PRE-RENDER MANAGER - Full segment rendering (video + overlays)
// ============================================================================

let segmentPreRenderManager = null;

async function getSegmentPreRenderManager() {
    if (!segmentPreRenderManager) {
        const { default: manager } = await import('../services/segmentPreRenderManager.js');
        segmentPreRenderManager = manager;
        
        // Set up event listeners
        segmentPreRenderManager.on('renderComplete', ({ segmentIndex, isReady }) => {
            if (mainWindow) {
                mainWindow.webContents.send('segment-render-complete', { segmentIndex, isReady });
            }
        });
        
        segmentPreRenderManager.on('renderError', ({ segmentIndex, error }) => {
            if (mainWindow) {
                mainWindow.webContents.send('segment-render-error', { segmentIndex, error });
            }
        });
    }
    return segmentPreRenderManager;
}

// Trigger segment render after video assignment
async function triggerSegmentRender(segmentIndex, segmentData) {
    try {
        const manager = await getSegmentPreRenderManager();
        await manager.updateSegment(segmentIndex, {
            headline: segmentData.headline || segmentData.title || '',
            mandatoryCredit: segmentData.mandatoryCredit || '',
            videoPath: segmentData.video?.url || segmentData.videoPath,
            duration: segmentData.duration || 5
        });
        return true;
    } catch (error) {
        console.error('[SegmentPreRender] Trigger failed:', error.message);
        return false;
    }
}

// IPC handlers
ipcMain.handle('segment-video-assigned', async (event, { segmentIndex, segmentData }) => {
    try {
        await triggerSegmentRender(segmentIndex, segmentData);
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

ipcMain.handle('segment-overlays-status', async () => {
    try {
        const manager = await getSegmentPreRenderManager();
        return manager.getStatus();
    } catch (error) {
        return { error: error.message };
    }
});

ipcMain.handle('segment-overlays-clear', async () => {
    try {
        const manager = await getSegmentPreRenderManager();
        manager.clear();
        return { success: true };
    } catch (error) {
        return { success: false, error: error.message };
    }
});

// Get pre-rendered segments for export
ipcMain.handle('get-prerendered-segments', async () => {
    try {
        const manager = await getSegmentPreRenderManager();
        return manager.getRenderedSegments();
    } catch (error) {
        console.error('[SegmentPreRender] Get segments failed:', error);
        return [];
    }
});

// ============================================================================
// PROJECT MANAGEMENT - Save/Load/Restore project state
// ============================================================================

// Save current project state
ipcMain.handle('save-project-state', async (event, { projectId }) => {
    try {
        if (projectId) {
            saveProjectState(projectId);
            return { success: true };
        }
        return { success: false, error: 'No project ID provided' };
    } catch (error) {
        console.error('[Project] Save failed:', error);
        return { success: false, error: error.message };
    }
});

// Load project state
ipcMain.handle('load-project-state', async (event, { projectId }) => {
    try {
        if (projectId && loadProjectState(projectId)) {
            currentProjectId = projectId;
            return { 
                success: true, 
                segments: activeTimelineSegments,
                projectId: currentProjectId 
            };
        }
        return { success: false, error: 'Project not found' };
    } catch (error) {
        console.error('[Project] Load failed:', error);
        return { success: false, error: error.message };
    }
});

// Clear project state (when navigating away)
ipcMain.handle('clear-project-state', async () => {
    try {
        if (currentProjectId) {
            saveProjectState(currentProjectId);
        }
        clearProjectState();
        currentProjectId = null;
        return { success: true };
    } catch (error) {
        console.error('[Project] Clear failed:', error);
        return { success: false, error: error.message };
    }
});

// Get current project ID
ipcMain.handle('get-current-project', async () => {
    return { 
        projectId: currentProjectId, 
        segmentCount: activeTimelineSegments.length 
    };
});

// Save recovery state (for crash recovery)
ipcMain.handle('save-recovery-state', async (event, state) => {
    try {
        if (currentProjectId && activeTimelineSegments.length > 0) {
            const recoveryData = {
                projectId: currentProjectId,
                timestamp: Date.now(),
                segments: activeTimelineSegments,
                editorState: state,
                isDirty: true
            };
            
            const userDataPath = app.getPath('userData');
            const recoveryPath = path.join(userDataPath, 'crash-recovery.json');
            fs.writeFileSync(recoveryPath, JSON.stringify(recoveryData, null, 2));
            
            return { success: true };
        }
        return { success: false, error: 'No active project' };
    } catch (error) {
        console.error('[Recovery] Save failed:', error);
        return { success: false, error: error.message };
    }
});

// Check for recovery state
ipcMain.handle('check-recovery-state', async () => {
    try {
        const userDataPath = app.getPath('userData');
        const recoveryPath = path.join(userDataPath, 'crash-recovery.json');
        
        if (fs.existsSync(recoveryPath)) {
            const data = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
            
            // Check if recovery is recent (within last 24 hours)
            if (Date.now() - data.timestamp < 24 * 60 * 60 * 1000) {
                return { 
                    found: true, 
                    data: data,
                    timeAgo: Math.round((Date.now() - data.timestamp) / 60000) // minutes
                };
            } else {
                // Old recovery, delete it
                fs.unlinkSync(recoveryPath);
            }
        }
        
        return { found: false };
    } catch (error) {
        console.error('[Recovery] Check failed:', error);
        return { found: false, error: error.message };
    }
});

// Restore from recovery
ipcMain.handle('restore-from-recovery', async () => {
    try {
        const userDataPath = app.getPath('userData');
        const recoveryPath = path.join(userDataPath, 'crash-recovery.json');
        
        if (fs.existsSync(recoveryPath)) {
            const data = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
            
            // Restore state
            currentProjectId = data.projectId;
            activeTimelineSegments = data.segments || [];
            
            // Clear recovery file after successful restore
            fs.unlinkSync(recoveryPath);
            
            return { 
                success: true, 
                projectId: currentProjectId,
                segments: activeTimelineSegments
            };
        }
        
        return { success: false, error: 'No recovery data found' };
    } catch (error) {
        console.error('[Recovery] Restore failed:', error);
        return { success: false, error: error.message };
    }
});

// Clear recovery state
ipcMain.handle('clear-recovery-state', async () => {
    try {
        const userDataPath = app.getPath('userData');
        const recoveryPath = path.join(userDataPath, 'crash-recovery.json');
        
        if (fs.existsSync(recoveryPath)) {
            fs.unlinkSync(recoveryPath);
        }
        
        return { success: true };
    } catch (error) {
        console.error('[Recovery] Clear failed:', error);
        return { success: false, error: error.message };
    }
});
