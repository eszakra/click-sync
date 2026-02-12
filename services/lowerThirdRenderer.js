// lowerThirdRenderer.js - Generates animated lower third videos using Remotion
// Uses @remotion/renderer with pre-built bundle, falls back to Canvas PNG
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import { createCanvas } from 'canvas';
import log from 'electron-log';

// Configure electron-log
log.transports.file.level = 'info';
log.transports.console.level = 'info';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =============================================================================
// LOGGING CONFIGURATION
// All logs are centralized in ~/ClickStudio/logs/ for easy debugging
// =============================================================================
const LOG_DIR = path.join(os.homedir(), 'ClickStudio', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'lowerthird.log');

// Initialize log directory and file
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const separator = `\n${'='.repeat(70)}\n`;
    fs.appendFileSync(LOG_FILE, `${separator}[${new Date().toISOString()}] LowerThirdRenderer Session Started\n${'='.repeat(70)}\n`);
} catch (e) {
    console.error('[LowerThird] Failed to initialize log file:', e.message);
}

// Logging helpers
function logInfo(msg) {
    const logLine = `[${new Date().toISOString()}] [INFO] ${msg}\n`;
    console.log(msg);
    try { fs.appendFileSync(LOG_FILE, logLine); } catch (e) { /* ignore */ }
}

function logError(msg) {
    const logLine = `[${new Date().toISOString()}] [ERROR] ${msg}\n`;
    console.error(msg);
    try { fs.appendFileSync(LOG_FILE, logLine); } catch (e) { /* ignore */ }
}

// =============================================================================
// FIX: On macOS packaged Electron apps, process.cwd() resolves to '/' (root).
// Remotion uses process.cwd() to find its cache dir (.remotion), and tries to
// mkdir '/.remotion' which fails with ENOENT (no write permission to /).
// Fix: Change cwd to a writable directory before Remotion loads.
// This is safe because our code uses absolute paths everywhere.
// =============================================================================
if (process.platform === 'darwin') {
    try {
        const cwd = process.cwd();
        if (cwd === '/' || cwd === '/private/var') {
            const writableCwd = path.join(os.homedir(), 'ClickStudio', 'Temp');
            if (!fs.existsSync(writableCwd)) fs.mkdirSync(writableCwd, { recursive: true });
            process.chdir(writableCwd);
            logInfo(`[LowerThird] Fixed cwd: '${cwd}' -> '${writableCwd}'`);
        }
    } catch (e) {
        logError(`[LowerThird] Could not fix cwd: ${e.message}`);
    }
}

// Lazy load Remotion renderer
let renderMedia = null;
let selectComposition = null;
let remotionLoaded = false;

// Cache composition to avoid re-selecting for each render
let cachedComposition = null;
let cachedServeUrl = null;

// ============ OVERLAY CACHE SYSTEM ============
// Pre-renders overlays in background and caches them for faster export
const overlayCache = new Map(); // hash -> { path, timestamp, rendering: boolean }
const pendingRenders = new Map(); // hash -> Promise

/**
 * Generate a simple hash for cache key
 */
function generateCacheKey(line1, line2, durationInSeconds) {
    const content = `${line1 || ''}|${line2 || ''}|${durationInSeconds}`;
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash; // Convert to 32bit integer
    }
    return `lt_${Math.abs(hash).toString(36)}`;
}

/**
 * Check if overlay is already cached
 */
function getCachedOverlay(cacheKey) {
    const cached = overlayCache.get(cacheKey);
    if (cached && cached.path && fs.existsSync(cached.path)) {
        logInfo(`[LowerThird] Cache HIT: ${cacheKey}`);
        return cached.path;
    }
    return null;
}

/**
 * Save overlay to cache
 */
function setCachedOverlay(cacheKey, filePath) {
    overlayCache.set(cacheKey, {
        path: filePath,
        timestamp: Date.now(),
        rendering: false
    });
    logInfo(`[LowerThird] Cached: ${cacheKey} -> ${path.basename(filePath)}`);
}

// GPU detection cache
let gpuInfo = null;

// ProRes optimization settings
// IMPORTANT: Only 4444 and 4444-xq support ALPHA CHANNEL (transparency)
// Other profiles (proxy, lt, standard, hq) do NOT have alpha - they would have black backgrounds!
// For overlays we MUST use 4444 to maintain transparency
const PRORES_PROFILES = {
    PROXY: 'proxy',      // NO ALPHA - black background
    LT: 'lt',            // NO ALPHA - black background  
    STANDARD: 'standard', // NO ALPHA - black background
    HQ: 'hq',            // NO ALPHA - black background
    FULL: '4444',        // WITH ALPHA - transparent background (REQUIRED for overlays)
    XQ: '4444-xq'        // WITH ALPHA - highest quality transparent
};

// MUST use 4444 for overlays - it's the only way to get transparency
// File size is larger but quality/transparency is essential
let currentProResProfile = PRORES_PROFILES.FULL;

/**
 * Set ProRes profile for rendering
 * @param {string} profile - One of: 'proxy', 'lt', 'standard', 'hq', '4444', '4444-xq'
 */
function setProResProfile(profile) {
    if (Object.values(PRORES_PROFILES).includes(profile)) {
        currentProResProfile = profile;
        logInfo(`[LowerThird] ProRes profile set to: ${profile}`);
    } else {
        logError(`[LowerThird] Invalid ProRes profile: ${profile}`);
    }
}

/**
 * Get pixel format based on ProRes profile
 * Only 4444 and 4444-xq support alpha channel
 */
function getPixelFormat(profile) {
    if (profile === '4444' || profile === '4444-xq') {
        return 'yuva444p10le'; // 10-bit with alpha
    }
    // For non-alpha profiles, use standard pixel format
    // But since we need alpha for overlays, we fall back to 4444
    return 'yuva444p10le';
}

/**
 * Detect available GPU and its capabilities
 * Returns: { hasNvidia, hasAmd, hasIntel, vram, recommended: 'gpu' | 'cpu' }
 */
async function detectGPU() {
    if (gpuInfo) return gpuInfo;

    gpuInfo = {
        hasNvidia: false,
        hasAmd: false,
        hasIntel: false,
        hasAppleSilicon: false,
        vram: 0,
        gpuName: 'Unknown',
        recommended: 'cpu',
        concurrency: 1,
        gl: 'swiftshader'
    };

    try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec);

        // Try nvidia-smi first (NVIDIA GPUs)
        try {
            const { stdout } = await execAsync('nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits', { timeout: 5000 });
            if (stdout && stdout.trim()) {
                const [name, vram] = stdout.trim().split(',').map(s => s.trim());
                gpuInfo.hasNvidia = true;
                gpuInfo.gpuName = name;
                gpuInfo.vram = parseInt(vram) || 0;
                gpuInfo.recommended = 'gpu';
                gpuInfo.gl = 'angle';
                gpuInfo.concurrency = gpuInfo.vram >= 8000 ? 4 : gpuInfo.vram >= 4000 ? 3 : 2;
                logInfo(`[LowerThird] Detected NVIDIA GPU: ${name} (${gpuInfo.vram}MB VRAM) - Using GPU acceleration`);
            }
        } catch (e) {
            // No NVIDIA GPU or nvidia-smi not available
        }

        // If no NVIDIA, try to detect other GPUs via Windows (wmic)
        if (!gpuInfo.hasNvidia && process.platform === 'win32') {
            try {
                const { stdout } = await execAsync('wmic path win32_videocontroller get name,adapterram /format:csv', { timeout: 5000 });
                const lines = stdout.trim().split('\n').filter(l => l.trim() && !l.includes('Node'));
                for (const line of lines) {
                    const parts = line.split(',');
                    if (parts.length >= 3) {
                        const name = parts[1] || '';
                        const ram = parseInt(parts[2]) || 0;
                        const vramMB = Math.round(ram / 1024 / 1024);

                        if (name.toLowerCase().includes('nvidia')) {
                            gpuInfo.hasNvidia = true;
                            gpuInfo.recommended = 'gpu';
                            gpuInfo.gl = 'angle';
                        } else if (name.toLowerCase().includes('amd') || name.toLowerCase().includes('radeon')) {
                            gpuInfo.hasAmd = true;
                            gpuInfo.recommended = 'gpu';
                            gpuInfo.gl = 'angle';
                        } else if (name.toLowerCase().includes('intel')) {
                            gpuInfo.hasIntel = true;
                            if (!gpuInfo.hasNvidia && !gpuInfo.hasAmd) {
                                gpuInfo.recommended = 'cpu';
                                gpuInfo.gl = 'swiftshader';
                            }
                        }

                        if (vramMB > gpuInfo.vram) {
                            gpuInfo.vram = vramMB;
                            gpuInfo.gpuName = name;
                        }
                    }
                }

                if (gpuInfo.recommended === 'gpu') {
                    gpuInfo.concurrency = gpuInfo.vram >= 8000 ? 4 : gpuInfo.vram >= 4000 ? 3 : 2;
                    logInfo(`[LowerThird] Detected GPU: ${gpuInfo.gpuName} (${gpuInfo.vram}MB) - Using GPU acceleration`);
                }
            } catch (e) {
                // wmic failed, fall back to CPU
            }
        }

        // macOS GPU detection
        if (!gpuInfo.hasNvidia && !gpuInfo.hasAmd && process.platform === 'darwin') {
            try {
                const { stdout } = await execAsync('system_profiler SPDisplaysDataType', { timeout: 5000 });
                if (stdout.toLowerCase().includes('apple m')) {
                    gpuInfo.hasAppleSilicon = true;
                    gpuInfo.gpuName = 'Apple Silicon';
                    gpuInfo.recommended = 'gpu';
                    gpuInfo.gl = 'angle';
                    // Apple Silicon has unified memory with high bandwidth - can handle more concurrency
                    gpuInfo.concurrency = 3;
                    logInfo(`[LowerThird] Detected Apple Silicon - Using GPU acceleration (concurrency: 3)`);
                }
            } catch (e) {
                // Fall back to CPU
            }
        }

        if (gpuInfo.recommended === 'cpu') {
            logInfo(`[LowerThird] No dedicated GPU detected - Using CPU rendering`);
        }

    } catch (e) {
        logError(`[LowerThird] GPU detection failed: ${e.message} - Falling back to CPU`);
    }

    return gpuInfo;
}

async function loadRemotion() {
    if (remotionLoaded) return true;
    try {
        logInfo('[LowerThird] Loading @remotion/renderer...');
        const renderer = await import('@remotion/renderer');
        renderMedia = renderer.renderMedia;
        selectComposition = renderer.selectComposition;
        remotionLoaded = true;
        logInfo('[LowerThird] @remotion/renderer loaded successfully');

        // Detect GPU on first load
        await detectGPU();

        return true;
    } catch (e) {
        logError(`[LowerThird] Failed to load @remotion/renderer: ${e.message}`);
        return false;
    }
}

class LowerThirdRenderer {
    constructor() {
        this.outputDir = path.join(os.homedir(), 'ClickStudio', 'Temp', 'lower-thirds');
        this.bundlePath = null;
        this.binariesDir = null;
        this.browserPath = null;
        this.initialized = false;
        this.ensureOutputDir();
    }

    /**
     * Lazy initialization - called when first render is requested
     */
    initializePaths() {
        if (this.initialized) return;
        this.initialized = true;

        try {
            this.bundlePath = this.findRemotionBundle();
            this.binariesDir = this.findBinariesDirectory();
            this.browserPath = this.findBrowserExecutable();

            logInfo(`[LowerThird] Bundle path: ${this.bundlePath || 'NOT FOUND'}`);
            logInfo(`[LowerThird] Binaries dir: ${this.binariesDir || 'NOT FOUND'}`);
            logInfo(`[LowerThird] Browser path: ${this.browserPath || 'auto'}`);
        } catch (e) {
            logError(`[LowerThird] Failed to initialize paths: ${e.message}`);
        }
    }

    ensureOutputDir() {
        try {
            if (!fs.existsSync(this.outputDir)) {
                fs.mkdirSync(this.outputDir, { recursive: true });
            }
        } catch (e) {
            // If we can't create in home dir, try temp directory
            logError(`[LowerThird] Cannot create output dir at ${this.outputDir}: ${e.message}`);
            this.outputDir = path.join(os.tmpdir(), 'clickstudio-lowerthirds');
            try {
                if (!fs.existsSync(this.outputDir)) {
                    fs.mkdirSync(this.outputDir, { recursive: true });
                }
                logInfo(`[LowerThird] Using temp directory: ${this.outputDir}`);
            } catch (e2) {
                logError(`[LowerThird] Cannot create temp dir either: ${e2.message}`);
            }
        }
    }

    /**
     * Find the pre-built Remotion bundle
     */
    findRemotionBundle() {
        // Check if we're in production (app.asar exists in path)
        const isProduction = __dirname.includes('app.asar');

        const possiblePaths = [];

        if (isProduction && process.resourcesPath) {
            // Production - use resourcesPath for reliable path
            possiblePaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'remotion-bundle'));
        }

        // Development path
        possiblePaths.push(path.join(__dirname, '..', 'remotion-bundle'));

        for (const p of possiblePaths) {
            logInfo(`[LowerThird] Checking bundle at: ${p}`);
            const indexPath = path.join(p, 'index.html');
            if (fs.existsSync(indexPath)) {
                logInfo(`[LowerThird] ✓ Found bundle at: ${p}`);
                return p;
            }
        }

        logError('[LowerThird] Remotion bundle not found');
        return null;
    }

    /**
     * Find Remotion compositor binaries
     */
    findBinariesDirectory() {
        const isProduction = __dirname.includes('app.asar');

        // Determine platform-specific compositor package name
        let compositorPkgs = [];
        if (process.platform === 'win32') {
            compositorPkgs = ['compositor-win32-x64-msvc'];
        } else if (process.platform === 'darwin') {
            // Try both arm64 (Apple Silicon) and x64 (Intel)
            if (process.arch === 'arm64') {
                compositorPkgs = ['compositor-darwin-arm64', 'compositor-darwin-x64'];
            } else {
                compositorPkgs = ['compositor-darwin-x64', 'compositor-darwin-arm64'];
            }
        } else {
            compositorPkgs = ['compositor-linux-x64-gnu'];
        }
        const binaryName = process.platform === 'win32' ? 'remotion.exe' : 'remotion';

        const possiblePaths = [];

        for (const pkg of compositorPkgs) {
            if (isProduction && process.resourcesPath) {
                // Production - use resourcesPath
                possiblePaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@remotion', pkg));
            }

            // Development path
            possiblePaths.push(path.join(__dirname, '..', 'node_modules', '@remotion', pkg));
        }

        for (const p of possiblePaths) {
            logInfo(`[LowerThird] Checking binaries at: ${p}`);
            const exePath = path.join(p, binaryName);
            if (fs.existsSync(exePath)) {
                logInfo(`[LowerThird] ✓ Found binaries at: ${p}`);
                return p;
            }
        }

        logError('[LowerThird] Remotion binaries not found');
        return null;
    }

    /**
     * Find Chrome Headless Shell or Chrome browser
     * Remotion prefers chrome-headless-shell for newer versions
     */
    findBrowserExecutable() {
        // Don't specify browser - let Remotion download its own headless shell
        // This is more reliable than bundling Chrome
        logInfo('[LowerThird] Browser: letting Remotion use its own headless shell');
        return null;
    }

    splitHeadlineIntoLines(headline) {
        // Clean up headline
        let clean = headline.replace(/^ON\s*SCREEN\s*:?\s*/i, '').trim().toUpperCase();

        const words = clean.split(/\s+/);

        // If 3 or fewer words, put all on line 1
        if (words.length <= 3) {
            return { line1: clean, line2: '' };
        }

        // If 4-5 words, split roughly in half
        if (words.length <= 5) {
            const mid = Math.ceil(words.length / 2);
            return {
                line1: words.slice(0, mid).join(' '),
                line2: words.slice(mid).join(' ')
            };
        }

        // For longer headlines, split at ~45%
        const split = Math.floor(words.length * 0.45);
        return {
            line1: words.slice(0, split).join(' '),
            line2: words.slice(split).join(' ')
        };
    }

    /**
     * Main render function - uses Remotion renderer, falls back to Canvas
     * OPTIMIZED: Reduced logging, efficient cache checking
     */
    async renderLowerThird({ headline, durationInSeconds = 5, segmentId, onProgress = null }) {
        // Initialize paths on first use
        this.initializePaths();

        const { line1, line2 } = this.splitHeadlineIntoLines(headline);

        // Helper to report progress to callback
        const reportProgress = (percent) => {
            if (onProgress && typeof onProgress === 'function') {
                onProgress({ percent, text: headline, segmentId, type: 'lower_third' });
            }
        };

        reportProgress(0);

        // ============ CHECK CACHE FIRST ============
        const cacheKey = generateCacheKey(line1, line2, durationInSeconds);

        // Check if already cached - FAST PATH
        const cachedPath = getCachedOverlay(cacheKey);
        if (cachedPath) {
            // Report progress even for cached items
            reportProgress(100);
            return cachedPath;
        }

        // Check if already being rendered (avoid duplicate work)
        if (pendingRenders.has(cacheKey)) {
            logInfo(`[LowerThird] seg=${segmentId}: Waiting for pending render`);
            return pendingRenders.get(cacheKey);
        }

        // Log only when actually rendering (not cached)
        logInfo(`[LowerThird] seg=${segmentId}: Rendering "${(line1 || '').substring(0, 25)}..."`);

        // Create render promise
        const renderPromise = (async () => {
            try {
                // Try Remotion renderer first (need bundle and binaries, browser is optional)
                if (this.bundlePath && this.binariesDir) {
                    try {
                        const result = await this.renderWithRemotion({ line1, line2, durationInSeconds, segmentId, reportProgress });
                        if (result && fs.existsSync(result)) {
                            reportProgress(100);
                            setCachedOverlay(cacheKey, result);
                            return result;
                        }
                    } catch (e) {
                        logError(`[LowerThird] seg=${segmentId}: Remotion failed - ${e.message}`);
                    }
                }

                // Fallback to Canvas (static PNG)
                logInfo(`[LowerThird] seg=${segmentId}: Using Canvas fallback`);
                const canvasResult = await this.renderWithCanvas({ line1, line2, segmentId });
                if (canvasResult) {
                    reportProgress(100);
                    setCachedOverlay(cacheKey, canvasResult);
                }
                return canvasResult;
            } finally {
                pendingRenders.delete(cacheKey);
            }
        })();

        pendingRenders.set(cacheKey, renderPromise);
        return renderPromise;
    }

    /**
     * Render using @remotion/renderer with pre-built bundle
     * OPTIMIZED: Caches composition, reduces logging, uses shared GPU config
     */
    async renderWithRemotion({ line1, line2, durationInSeconds, segmentId, reportProgress = null }) {
        const loaded = await loadRemotion();
        if (!loaded) {
            throw new Error('@remotion/renderer not available');
        }

        // Use ProRes 4444 for reliable alpha channel with FFmpeg overlay
        const outputPath = path.join(this.outputDir, `lt_${segmentId}_${Date.now()}.mov`);

        // Calculate frames (minimum 90 for animation to complete)
        const durationFrames = Math.max(90, Math.round(durationInSeconds * 30));

        const inputProps = {
            line1: line1 || '',
            line2: line2 || '',
            durationInSeconds
        };

        // Reduced logging - only log essential info
        logInfo(`[LowerThird] Render: seg=${segmentId}, frames=${durationFrames}, text="${(line1 || '').substring(0, 20)}..."`);

        try {
            // OPTIMIZATION DISABLED: Always select composition to avoid text stickiness in parallel renders
            // The overhead is small compared to correctness
            // if (!cachedComposition || cachedServeUrl !== this.bundlePath) {
            // logInfo('[LowerThird] Selecting composition (first time or bundle changed)...');

            const selectOptions = {
                serveUrl: this.bundlePath,
                id: 'SegmentLowerThird',
                inputProps,
                binariesDirectory: this.binariesDir,
                timeoutInMilliseconds: 30000,
            };
            if (this.browserPath) {
                selectOptions.browserExecutable = this.browserPath;
            }

            cachedComposition = await selectComposition(selectOptions);
            cachedServeUrl = this.bundlePath;

            // logInfo(`[LowerThird] Composition cached: ${cachedComposition.width}x${cachedComposition.height} @ ${cachedComposition.fps}fps`);
            // }

            // Get GPU configuration (auto-detected and cached)
            const gpu = await detectGPU();

            const proResProfile = currentProResProfile;
            const pixelFormat = getPixelFormat(proResProfile);

            // OPTIMIZED: Use more CPU cores for faster frame rendering (os is already imported at top)
            const cpuCount = os.cpus().length;
            const optimizedConcurrency = Math.max(gpu.concurrency, Math.min(cpuCount, 8));
            logInfo(`[LowerThird] Using concurrency: ${optimizedConcurrency} (CPU cores: ${cpuCount}, GPU concurrency: ${gpu.concurrency})`);

            const renderOptions = {
                composition: {
                    ...cachedComposition,
                    durationInFrames: durationFrames,
                },
                serveUrl: this.bundlePath,
                // ProRes with alpha channel
                codec: 'prores',
                proResProfile: proResProfile,
                imageFormat: 'png',
                pixelFormat: pixelFormat,
                outputLocation: outputPath,
                inputProps,
                binariesDirectory: this.binariesDir,
                timeoutInMilliseconds: 120000,
                verbose: false,
                concurrency: optimizedConcurrency,
                jpegQuality: 85,
                chromiumOptions: {
                    disableWebSecurity: true,
                    headless: true,
                    gl: gpu.gl,
                    enableGPU: gpu.recommended === 'gpu',
                },
                onProgress: ({ progress }) => {
                    const pct = Math.round(progress * 100);
                    // Reduced logging - only at 50% and 100%
                    if (pct === 50 || pct >= 99) {
                        logInfo(`[LowerThird] seg=${segmentId}: ${pct}%`);
                    }
                    // Always send to UI
                    if (reportProgress) {
                        reportProgress(pct);
                    }
                },
            };

            if (this.browserPath) {
                renderOptions.browserExecutable = this.browserPath;
            }

            await renderMedia(renderOptions);

            // Check if MOV was created
            if (fs.existsSync(outputPath)) {
                const stats = fs.statSync(outputPath);
                logInfo(`[LowerThird] ✓ seg=${segmentId}: ${(stats.size / 1024).toFixed(1)} KB`);
                return outputPath;
            }

            throw new Error('Output file not created');

        } catch (error) {
            logError(`[LowerThird] Render error seg=${segmentId}: ${error.message}`);
            throw error;
        }
    }

    /**
     * Render with Canvas (static PNG fallback)
     */
    async renderWithCanvas({ line1, line2, segmentId }) {
        const outputPath = path.join(this.outputDir, `lt_${segmentId}_${Date.now()}.png`);

        const width = 1920;
        const height = 1080;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // Clear with transparency
        ctx.clearRect(0, 0, width, height);

        // Lower third design - centered at bottom
        const barPadding = 40;
        const barHeight1 = 70;
        const barHeight2 = 85;
        const barGap = 8;
        const bottomMargin = 40;

        // Calculate bar positions
        const bar2Y = height - bottomMargin - barHeight2;
        const bar1Y = bar2Y - barGap - barHeight1;

        // Measure text to size bars
        ctx.font = 'bold 46px Arial';
        const text1Width = line1 ? ctx.measureText(line1).width : 0;

        ctx.font = 'bold 54px Arial';
        const text2Width = line2 ? ctx.measureText(line2).width : 0;

        // Draw top bar (red gradient)
        if (line1) {
            const bar1Width = text1Width + barPadding * 2;
            const bar1X = (width - bar1Width) / 2;

            // Red gradient (bottom to top)
            const gradient1 = ctx.createLinearGradient(bar1X, bar1Y + barHeight1, bar1X, bar1Y);
            gradient1.addColorStop(0, '#8B0000');
            gradient1.addColorStop(0.4, '#CC0000');
            gradient1.addColorStop(1, '#FF0000');

            this.roundRect(ctx, bar1X, bar1Y, bar1Width, barHeight1, 10);
            ctx.fillStyle = gradient1;
            ctx.fill();

            // Draw text
            ctx.font = 'bold 46px Arial';
            ctx.fillStyle = 'white';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(line1, width / 2, bar1Y + barHeight1 / 2);
        }

        // Draw bottom bar (gray to white gradient)
        if (line2) {
            const bar2Width = text2Width + barPadding * 2;
            const bar2X = (width - bar2Width) / 2;

            // Gray to white gradient (bottom to top)
            const gradient2 = ctx.createLinearGradient(bar2X, bar2Y + barHeight2, bar2X, bar2Y);
            gradient2.addColorStop(0, '#666666');
            gradient2.addColorStop(0.3, '#AAAAAA');
            gradient2.addColorStop(1, '#FFFFFF');

            this.roundRect(ctx, bar2X, bar2Y, bar2Width, barHeight2, 10);
            ctx.fillStyle = gradient2;
            ctx.fill();

            // Draw text
            ctx.font = 'bold 54px Arial';
            ctx.fillStyle = '#111111';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(line2, width / 2, bar2Y + barHeight2 / 2);
        }

        // Save PNG
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(outputPath, buffer);

        logInfo(`[LowerThird] Canvas fallback: ${outputPath}`);
        return outputPath;
    }

    roundRect(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x + radius, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x + radius, y + height);
        ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
        ctx.lineTo(x, y + radius);
        ctx.quadraticCurveTo(x, y, x + radius, y);
        ctx.closePath();
    }

    cleanup() {
        try {
            if (fs.existsSync(this.outputDir)) {
                for (const file of fs.readdirSync(this.outputDir)) {
                    fs.unlinkSync(path.join(this.outputDir, file));
                }
            }
            // Clear cache
            overlayCache.clear();
            pendingRenders.clear();
            logInfo('[LowerThird] Cache cleared');
        } catch (e) {
            logError(`[LowerThird] Cleanup failed: ${e.message}`);
        }
    }

    /**
     * PRE-RENDER: Queue a lower third for background rendering
     * Call this when a segment is added/updated to render ahead of time
     * @returns {Promise<string|null>} Path to rendered overlay or null if failed
     */
    async preRender({ headline, segmentId = 0, durationInSeconds = 5 }) {
        if (!headline || !headline.trim()) {
            return null;
        }

        const line1 = headline.length > 50 ? headline.substring(0, 50) : headline;
        const line2 = headline.length > 50 ? headline.substring(50, 100) : '';

        const cacheKey = generateCacheKey(line1, line2, durationInSeconds);

        // Already cached?
        const cached = getCachedOverlay(cacheKey);
        if (cached) {
            logInfo(`[LowerThird] Pre-render: Already cached ${cacheKey}`);
            return cached;
        }

        // Already rendering?
        if (pendingRenders.has(cacheKey)) {
            logInfo(`[LowerThird] Pre-render: Already in progress ${cacheKey}`);
            return pendingRenders.get(cacheKey);
        }

        logInfo(`[LowerThird] Pre-render: Starting background render for "${headline.substring(0, 30)}..."`);

        // Render in background (don't await - fire and forget)
        try {
            return await this.renderLowerThird({ headline, durationInSeconds, segmentId });
        } catch (e) {
            logError(`[LowerThird] Pre-render failed: ${e.message}`);
            return null;
        }
    }

    /**
     * Check if a lower third is already cached
     */
    isCached(headline, durationInSeconds = 5) {
        if (!headline) return false;
        const line1 = headline.length > 50 ? headline.substring(0, 50) : headline;
        const line2 = headline.length > 50 ? headline.substring(50, 100) : '';
        const cacheKey = generateCacheKey(line1, line2, durationInSeconds);
        return getCachedOverlay(cacheKey) !== null;
    }

    /**
     * Get cache statistics
     */
    getCacheStats() {
        return {
            cached: overlayCache.size,
            pending: pendingRenders.size,
            items: Array.from(overlayCache.keys())
        };
    }
}

const lowerThirdRenderer = new LowerThirdRenderer();
export default lowerThirdRenderer;
export { LowerThirdRenderer, setProResProfile, PRORES_PROFILES };
