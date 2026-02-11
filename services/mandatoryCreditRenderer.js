// mandatoryCreditRenderer.js - Generates animated mandatory credit overlays using Remotion
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
const LOG_FILE = path.join(LOG_DIR, 'mandatory-credit.log');

// Initialize log directory and file
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const separator = `\n${'='.repeat(70)}\n`;
    fs.appendFileSync(LOG_FILE, `${separator}[${new Date().toISOString()}] MandatoryCreditRenderer Session Started\n${'='.repeat(70)}\n`);
} catch (e) {
    console.error('[MandatoryCredit] Failed to initialize log file:', e.message);
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

// Lazy load Remotion renderer
let renderMedia = null;
let selectComposition = null;
let remotionLoaded = false;

// GPU detection cache (shared pattern with lowerThirdRenderer)
let gpuInfo = null;

/**
 * Detect available GPU and its capabilities for Remotion chromiumOptions
 * Returns: { hasNvidia, hasAmd, hasIntel, vram, recommended: 'gpu' | 'cpu', gl, concurrency }
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
                logInfo(`[MandatoryCredit] Detected NVIDIA GPU: ${name} (${gpuInfo.vram}MB VRAM)`);
            }
        } catch (e) { /* No NVIDIA */ }

        // Windows fallback: wmic
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
                }
            } catch (e) { /* wmic failed */ }
        }

        // macOS: Apple Silicon detection
        if (!gpuInfo.hasNvidia && !gpuInfo.hasAmd && process.platform === 'darwin') {
            try {
                const { stdout } = await execAsync('system_profiler SPDisplaysDataType', { timeout: 5000 });
                if (stdout.toLowerCase().includes('apple m')) {
                    gpuInfo.hasAppleSilicon = true;
                    gpuInfo.gpuName = 'Apple Silicon';
                    gpuInfo.recommended = 'gpu';
                    gpuInfo.gl = 'angle';
                    // Apple Silicon has unified memory - can handle higher concurrency
                    gpuInfo.concurrency = 3;
                    logInfo(`[MandatoryCredit] Detected Apple Silicon - GPU acceleration enabled`);
                }
            } catch (e) { /* Fall back to CPU */ }
        }

        if (gpuInfo.recommended === 'cpu') {
            logInfo(`[MandatoryCredit] No dedicated GPU detected - Using CPU rendering`);
        }
    } catch (e) {
        logError(`[MandatoryCredit] GPU detection failed: ${e.message}`);
    }

    return gpuInfo;
}

// ============ OVERLAY CACHE SYSTEM ============
const overlayCache = new Map();
const pendingRenders = new Map();

function generateCacheKey(text, durationInSeconds) {
    const content = `mc_${text || ''}|${durationInSeconds}`;
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return `mc_${Math.abs(hash).toString(36)}`;
}

function getCachedOverlay(cacheKey) {
    const cached = overlayCache.get(cacheKey);
    if (cached && cached.path && fs.existsSync(cached.path)) {
        logInfo(`[MandatoryCredit] Cache HIT: ${cacheKey}`);
        return cached.path;
    }
    return null;
}

function setCachedOverlay(cacheKey, filePath) {
    overlayCache.set(cacheKey, { path: filePath, timestamp: Date.now() });
}

async function loadRemotion() {
    if (remotionLoaded) return true;
    try {
        logInfo('[MandatoryCredit] Loading @remotion/renderer...');
        const renderer = await import('@remotion/renderer');
        renderMedia = renderer.renderMedia;
        selectComposition = renderer.selectComposition;
        remotionLoaded = true;
        logInfo('[MandatoryCredit] @remotion/renderer loaded successfully');

        // Detect GPU on first load
        await detectGPU();

        return true;
    } catch (e) {
        logError(`[MandatoryCredit] Failed to load @remotion/renderer: ${e.message}`);
        return false;
    }
}

class MandatoryCreditRenderer {
    constructor() {
        this.outputDir = path.join(os.homedir(), 'ClickStudio', 'Temp', 'mandatory-credits');
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

            logInfo(`[MandatoryCredit] Bundle path: ${this.bundlePath || 'NOT FOUND'}`);
            logInfo(`[MandatoryCredit] Binaries dir: ${this.binariesDir || 'NOT FOUND'}`);
            logInfo(`[MandatoryCredit] Browser path: ${this.browserPath || 'auto'}`);
        } catch (e) {
            logError(`[MandatoryCredit] Failed to initialize paths: ${e.message}`);
        }
    }

    ensureOutputDir() {
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Find the pre-built Remotion bundle
     */
    findRemotionBundle() {
        const isProduction = __dirname.includes('app.asar');

        const possiblePaths = [];

        if (isProduction && process.resourcesPath) {
            possiblePaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'remotion-bundle'));
        }

        // Development path
        possiblePaths.push(path.join(__dirname, '..', 'remotion-bundle'));

        for (const p of possiblePaths) {
            logInfo(`[MandatoryCredit] Checking bundle at: ${p}`);
            const indexPath = path.join(p, 'index.html');
            if (fs.existsSync(indexPath)) {
                logInfo(`[MandatoryCredit] ✓ Found bundle at: ${p}`);
                return p;
            }
        }

        logError('[MandatoryCredit] Remotion bundle not found');
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
                possiblePaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@remotion', pkg));
            }

            // Development path
            possiblePaths.push(path.join(__dirname, '..', 'node_modules', '@remotion', pkg));
        }

        for (const p of possiblePaths) {
            logInfo(`[MandatoryCredit] Checking binaries at: ${p}`);
            const exePath = path.join(p, binaryName);
            if (fs.existsSync(exePath)) {
                logInfo(`[MandatoryCredit] ✓ Found binaries at: ${p}`);
                return p;
            }
        }

        logError('[MandatoryCredit] Remotion binaries not found');
        return null;
    }

    /**
     * Find Chrome Headless Shell or Chrome browser
     */
    findBrowserExecutable() {
        logInfo('[MandatoryCredit] Browser: letting Remotion use its own headless shell');
        return null;
    }

    /**
     * Main render function - uses cache, Remotion renderer, falls back to Canvas
     */
    async renderMandatoryCredit({ text, durationInSeconds = 3, segmentId, onProgress = null }) {
        // Initialize paths on first use
        this.initializePaths();

        // ============ CHECK CACHE FIRST ============
        const cacheKey = generateCacheKey(text, durationInSeconds);

        const cachedPath = getCachedOverlay(cacheKey);
        if (cachedPath) {
            if (onProgress) onProgress({ percent: 100, text, segmentId, type: 'mandatory_credit' });
            return cachedPath;
        }

        // Check if already being rendered (avoid duplicate work)
        if (pendingRenders.has(cacheKey)) {
            logInfo(`[MandatoryCredit] seg=${segmentId}: Waiting for pending render`);
            return pendingRenders.get(cacheKey);
        }

        logInfo(`[MandatoryCredit] seg=${segmentId}: Rendering "${(text || '').substring(0, 30)}..."`);

        const renderPromise = (async () => {
            try {
                // Try Remotion renderer first
                if (this.bundlePath && this.binariesDir) {
                    try {
                        const result = await this.renderWithRemotion({ text, durationInSeconds, segmentId, onProgress });
                        if (result && fs.existsSync(result)) {
                            setCachedOverlay(cacheKey, result);
                            if (onProgress) onProgress({ percent: 100, text, segmentId, type: 'mandatory_credit' });
                            return result;
                        }
                    } catch (e) {
                        logError(`[MandatoryCredit] Remotion FAILED: ${e.message}`);
                    }
                }

                // Fallback to Canvas (static PNG)
                logInfo('[MandatoryCredit] Using Canvas fallback (static PNG)...');
                const canvasResult = await this.renderWithCanvas({ text, segmentId });
                if (canvasResult) {
                    setCachedOverlay(cacheKey, canvasResult);
                    if (onProgress) onProgress({ percent: 100, text, segmentId, type: 'mandatory_credit' });
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
     * OPTIMIZED: Uses more CPU cores for faster rendering
     */
    async renderWithRemotion({ text, durationInSeconds, segmentId, onProgress = null }) {
        const loaded = await loadRemotion();
        if (!loaded) {
            throw new Error('@remotion/renderer not available');
        }

        // Use MOV (ProRes) for reliable alpha channel support
        const outputPath = path.join(this.outputDir, `mc_${segmentId}_${Date.now()}.mov`);

        // OPTIMIZED: Animation completes by frame 20, render only what's needed + buffer
        // 3 seconds * 30fps = 90 frames (plenty of buffer for ~20 frame animation)
        const durationFrames = Math.round(durationInSeconds * 30);

        const inputProps = {
            text: text || '',
            durationInSeconds
        };

        logInfo(`[MandatoryCredit] Remotion render config:`);
        logInfo(`[MandatoryCredit]   serveUrl: ${this.bundlePath}`);
        logInfo(`[MandatoryCredit]   binaries: ${this.binariesDir}`);
        logInfo(`[MandatoryCredit]   browser: ${this.browserPath || 'auto (Remotion will download)'}`);
        logInfo(`[MandatoryCredit]   output: ${outputPath}`);
        logInfo(`[MandatoryCredit]   frames: ${durationFrames}`);
        logInfo(`[MandatoryCredit]   props: ${JSON.stringify(inputProps)}`);

        try {
            logInfo('[MandatoryCredit] Selecting composition...');

            const selectOptions = {
                serveUrl: this.bundlePath,
                id: 'SegmentMandatoryCredit',
                inputProps,
                binariesDirectory: this.binariesDir,
                timeoutInMilliseconds: 30000,
            };
            if (this.browserPath) {
                selectOptions.browserExecutable = this.browserPath;
            }

            const composition = await selectComposition(selectOptions);

            logInfo(`[MandatoryCredit] Composition: ${composition.width}x${composition.height} @ ${composition.fps}fps`);

            logInfo('[MandatoryCredit] Starting render...');

            // Get GPU configuration (auto-detected and cached)
            const gpu = await detectGPU();

            // OPTIMIZED: Use GPU concurrency + CPU cores for maximum throughput
            const cpuCount = os.cpus().length;
            const optimizedConcurrency = Math.max(gpu.concurrency, Math.min(cpuCount, 8));
            logInfo(`[MandatoryCredit] Using concurrency: ${optimizedConcurrency} (CPU: ${cpuCount}, GPU: ${gpu.gpuName})`);

            const renderOptions = {
                composition: {
                    ...composition,
                    durationInFrames: durationFrames,
                },
                serveUrl: this.bundlePath,
                codec: 'prores',
                proResProfile: '4444',
                imageFormat: 'png',
                pixelFormat: 'yuva444p10le',
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
                    if (pct === 50 || pct >= 99) {
                        logInfo(`[MandatoryCredit] seg=${segmentId}: ${pct}%`);
                    }
                    if (onProgress) {
                        onProgress({ percent: pct, text, segmentId, type: 'mandatory_credit' });
                    }
                },
            };
            if (this.browserPath) {
                renderOptions.browserExecutable = this.browserPath;
            }

            await renderMedia(renderOptions);

            if (fs.existsSync(outputPath)) {
                const stats = fs.statSync(outputPath);
                logInfo(`[MandatoryCredit] ✓ Output: ${outputPath} (${(stats.size / 1024).toFixed(1)} KB)`);
                return outputPath;
            }

            throw new Error('Output file not created');

        } catch (error) {
            logError(`[MandatoryCredit] Render error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Render with Canvas (static PNG fallback)
     */
    async renderWithCanvas({ text, segmentId }) {
        const outputPath = path.join(this.outputDir, `mc_${segmentId}_${Date.now()}.png`);

        const width = 1920;
        const height = 1080;
        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');

        // Clear with transparency
        ctx.clearRect(0, 0, width, height);

        // Mandatory credit design - top left corner
        const padding = 30;
        const barPaddingH = 20;
        const barPaddingV = 10;
        const accentWidth = 4;

        // Measure text
        ctx.font = '300 22px Arial';
        const textWidth = ctx.measureText(text).width;
        const barWidth = textWidth + barPaddingH * 2 + accentWidth;
        const barHeight = 42;

        // Draw red accent line
        ctx.fillStyle = '#CC0000';
        ctx.fillRect(padding, padding, accentWidth, barHeight);

        // Draw dark bar
        const gradient = ctx.createLinearGradient(padding + accentWidth, padding, padding + accentWidth, padding + barHeight);
        gradient.addColorStop(0, 'rgba(30, 30, 30, 0.95)');
        gradient.addColorStop(1, 'rgba(15, 15, 15, 0.98)');

        ctx.fillStyle = gradient;
        this.roundRectRight(ctx, padding + accentWidth, padding, barWidth - accentWidth, barHeight, 6);
        ctx.fill();

        // Draw text
        ctx.font = '300 22px Arial';
        ctx.fillStyle = '#FFFFFF';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, padding + accentWidth + barPaddingH, padding + barHeight / 2);

        // Save PNG
        const buffer = canvas.toBuffer('image/png');
        fs.writeFileSync(outputPath, buffer);

        logInfo(`[MandatoryCredit] Canvas fallback: ${outputPath}`);
        return outputPath;
    }

    roundRectRight(ctx, x, y, width, height, radius) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + width - radius, y);
        ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
        ctx.lineTo(x + width, y + height - radius);
        ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
        ctx.lineTo(x, y + height);
        ctx.lineTo(x, y);
        ctx.closePath();
    }

    cleanup() {
        try {
            if (fs.existsSync(this.outputDir)) {
                for (const file of fs.readdirSync(this.outputDir)) {
                    fs.unlinkSync(path.join(this.outputDir, file));
                }
            }
            overlayCache.clear();
            pendingRenders.clear();
            logInfo('[MandatoryCredit] Cache cleared');
        } catch (e) {
            logError(`[MandatoryCredit] Cleanup failed: ${e.message}`);
        }
    }
    
    /**
     * PRE-RENDER: Queue a mandatory credit for background rendering
     * Called by main.cjs when segments are loaded
     */
    async preRender({ text, segmentId = 0, durationInSeconds = 3 }) {
        if (!text || !text.trim()) {
            return null;
        }

        const cacheKey = generateCacheKey(text, durationInSeconds);
        const cached = getCachedOverlay(cacheKey);
        if (cached) {
            logInfo(`[MandatoryCredit] Pre-render: Already cached ${cacheKey}`);
            return cached;
        }

        if (pendingRenders.has(cacheKey)) {
            logInfo(`[MandatoryCredit] Pre-render: Already in progress ${cacheKey}`);
            return pendingRenders.get(cacheKey);
        }
        
        logInfo(`[MandatoryCredit] Pre-render: Starting for "${text.substring(0, 30)}..."`);
        
        try {
            return await this.renderMandatoryCredit({ text, durationInSeconds, segmentId });
        } catch (e) {
            logError(`[MandatoryCredit] Pre-render failed: ${e.message}`);
            return null;
        }
    }
    
    /**
     * Check if a credit is cached
     */
    isCached(text, durationInSeconds = 3) {
        if (!text) return false;
        const cacheKey = generateCacheKey(text, durationInSeconds);
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

const mandatoryCreditRenderer = new MandatoryCreditRenderer();
export default mandatoryCreditRenderer;
export { MandatoryCreditRenderer };
