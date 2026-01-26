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

// Debug log file path
const DEBUG_LOG_PATH = path.join(os.homedir(), 'ClickStudio', 'mandatory-credit-debug.log');

// Create log file immediately on module load
try {
    const dir = path.dirname(DEBUG_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] MandatoryCreditRenderer module loaded\n`);
} catch (e) {
    console.error('Failed to create debug log:', e);
}

// Helper to log to file
function logInfo(msg) {
    const logLine = `[${new Date().toISOString()}] ${msg}\n`;
    console.log(msg);
    try {
        fs.appendFileSync(DEBUG_LOG_PATH, logLine);
    } catch (e) { /* ignore */ }
}

function logError(msg) {
    const logLine = `[${new Date().toISOString()}] ERROR: ${msg}\n`;
    console.error(msg);
    try {
        fs.appendFileSync(DEBUG_LOG_PATH, logLine);
    } catch (e) { /* ignore */ }
}

// Lazy load Remotion renderer
let renderMedia = null;
let selectComposition = null;
let remotionLoaded = false;

// ============ OVERLAY CACHE SYSTEM ============
const creditCache = new Map(); // hash -> { path, timestamp }
const pendingCreditRenders = new Map(); // hash -> Promise

function generateCreditCacheKey(text, durationInSeconds) {
    const content = `${text || ''}|${durationInSeconds}`;
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
        const char = content.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return `mc_${Math.abs(hash).toString(36)}`;
}

function getCachedCredit(cacheKey) {
    const cached = creditCache.get(cacheKey);
    if (cached && cached.path && fs.existsSync(cached.path)) {
        logInfo(`[MandatoryCredit] Cache HIT: ${cacheKey}`);
        return cached.path;
    }
    return null;
}

function setCachedCredit(cacheKey, filePath) {
    creditCache.set(cacheKey, { path: filePath, timestamp: Date.now() });
    logInfo(`[MandatoryCredit] Cached: ${cacheKey} -> ${path.basename(filePath)}`);
}

// GPU detection cache
let gpuInfo = null;

// ProRes optimization settings - shared with lowerThirdRenderer
// IMPORTANT: Only 4444 and 4444-xq support ALPHA CHANNEL (transparency)
const PRORES_PROFILES = {
    PROXY: 'proxy',      // NO ALPHA
    LT: 'lt',            // NO ALPHA
    STANDARD: 'standard', // NO ALPHA
    HQ: 'hq',            // NO ALPHA
    FULL: '4444',        // WITH ALPHA (REQUIRED)
    XQ: '4444-xq'        // WITH ALPHA (highest quality)
};

// MUST use 4444 for overlays to maintain transparency
let currentProResProfile = PRORES_PROFILES.FULL;

function setProResProfile(profile) {
    if (Object.values(PRORES_PROFILES).includes(profile)) {
        currentProResProfile = profile;
        logInfo(`[MandatoryCredit] ProRes profile set to: ${profile}`);
    }
}

function getPixelFormat(profile) {
    if (profile === '4444' || profile === '4444-xq') {
        return 'yuva444p10le';
    }
    return 'yuva444p10le'; // Always need alpha for overlays
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
                gpuInfo.concurrency = gpuInfo.vram >= 8000 ? 4 : gpuInfo.vram >= 4000 ? 2 : 1;
                logInfo(`[MandatoryCredit] Detected NVIDIA GPU: ${name} (${gpuInfo.vram}MB VRAM) - Using GPU acceleration`);
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
                    gpuInfo.concurrency = gpuInfo.vram >= 8000 ? 4 : gpuInfo.vram >= 4000 ? 2 : 1;
                    logInfo(`[MandatoryCredit] Detected GPU: ${gpuInfo.gpuName} (${gpuInfo.vram}MB) - Using GPU acceleration`);
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
                    gpuInfo.gpuName = 'Apple Silicon';
                    gpuInfo.recommended = 'gpu';
                    gpuInfo.gl = 'angle';
                    gpuInfo.concurrency = 2;
                    logInfo(`[MandatoryCredit] Detected Apple Silicon - Using GPU acceleration`);
                }
            } catch (e) {
                // Fall back to CPU
            }
        }

    } catch (e) {
        logError(`[MandatoryCredit] GPU detection failed: ${e.message}`);
    }

    if (gpuInfo.recommended === 'cpu') {
        logInfo(`[MandatoryCredit] Using CPU rendering (SwiftShader) - concurrency: 1`);
    }

    return gpuInfo;
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

        const possiblePaths = [];

        if (isProduction && process.resourcesPath) {
            possiblePaths.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '@remotion', 'compositor-win32-x64-msvc'));
        }

        // Development path
        possiblePaths.push(path.join(__dirname, '..', 'node_modules', '@remotion', 'compositor-win32-x64-msvc'));

        for (const p of possiblePaths) {
            logInfo(`[MandatoryCredit] Checking binaries at: ${p}`);
            const exePath = path.join(p, 'remotion.exe');
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
     * Main render function - uses Remotion renderer, falls back to Canvas
     */
    async renderMandatoryCredit({ text, durationInSeconds = 5, segmentId, onProgress = null }) {
        // Initialize paths on first use
        this.initializePaths();

        logInfo(`[MandatoryCredit] ========================================`);
        logInfo(`[MandatoryCredit] Rendering: "${text}"`);
        logInfo(`[MandatoryCredit] Duration: ${durationInSeconds}s, Segment: ${segmentId}`);
        
        // Helper to report progress to callback
        const reportProgress = (percent) => {
            if (onProgress && typeof onProgress === 'function') {
                onProgress({ percent, text, segmentId, type: 'mandatory_credit' });
            }
        };
        
        reportProgress(0);

        // ============ CHECK CACHE FIRST ============
        const cacheKey = generateCreditCacheKey(text, durationInSeconds);
        
        const cachedPath = getCachedCredit(cacheKey);
        if (cachedPath) {
            logInfo(`[MandatoryCredit] ✨ Using CACHED overlay: ${cachedPath}`);
            // Report progress even for cached items
            reportProgress(100);
            return cachedPath;
        }
        
        // Check if already being rendered
        if (pendingCreditRenders.has(cacheKey)) {
            logInfo(`[MandatoryCredit] Waiting for pending render: ${cacheKey}`);
            return pendingCreditRenders.get(cacheKey);
        }

        const renderPromise = (async () => {
            try {
                // Try Remotion renderer first
                if (this.bundlePath && this.binariesDir) {
                    try {
                        const result = await this.renderWithRemotion({ text, durationInSeconds, segmentId, reportProgress });
                        if (result && fs.existsSync(result)) {
                            logInfo(`[MandatoryCredit] ✨ Remotion SUCCESS: ${result}`);
                            reportProgress(100);
                            setCachedCredit(cacheKey, result);
                            return result;
                        }
                    } catch (e) {
                        logError(`[MandatoryCredit] ❌ Remotion FAILED: ${e.message}`);
                        logError(`[MandatoryCredit] Stack: ${e.stack}`);
                    }
                } else {
                    logInfo('[MandatoryCredit] Remotion requirements not met, using Canvas fallback');
                }

                // Fallback to Canvas (static PNG)
                logInfo('[MandatoryCredit] Using Canvas fallback (static PNG)...');
                const canvasResult = await this.renderWithCanvas({ text, segmentId });
                if (canvasResult) {
                    reportProgress(100);
                    setCachedCredit(cacheKey, canvasResult);
                }
                return canvasResult;
            } finally {
                pendingCreditRenders.delete(cacheKey);
            }
        })();
        
        pendingCreditRenders.set(cacheKey, renderPromise);
        return renderPromise;
    }

    /**
     * Render using @remotion/renderer with pre-built bundle
     */
    async renderWithRemotion({ text, durationInSeconds, segmentId, reportProgress = null }) {
        const loaded = await loadRemotion();
        if (!loaded) {
            throw new Error('@remotion/renderer not available');
        }

        // ProRes 4444 for reliable alpha channel with FFmpeg
        const outputPath = path.join(this.outputDir, `mc_${segmentId}_${Date.now()}.mov`);

        // Calculate frames (minimum 90 for animation to complete)
        const durationFrames = Math.max(90, Math.round(durationInSeconds * 30));

        const inputProps = {
            text: text || '',
            durationInSeconds
        };

        logInfo(`[MandatoryCredit] Remotion render config:`);
        logInfo(`[MandatoryCredit]   serveUrl: ${this.bundlePath}`);
        logInfo(`[MandatoryCredit]   binaries: ${this.binariesDir}`);
        logInfo(`[MandatoryCredit]   browser: ${this.browserPath || 'auto (Remotion will download)'}`);
        logInfo(`[MandatoryCredit]   output: ${outputPath}`);
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

            logInfo(`[MandatoryCredit] Composition: ${composition.width}x${composition.height} @ ${composition.fps}fps, ${composition.durationInFrames} frames`);

            logInfo('[MandatoryCredit] Starting render...');

            // Get GPU configuration (auto-detected)
            const gpu = await detectGPU();
            
            const proResProfile = currentProResProfile;
            const pixelFormat = getPixelFormat(proResProfile);
            
            logInfo(`[MandatoryCredit] Using ProRes profile: ${proResProfile} (pixel format: ${pixelFormat})`);
            
            const renderOptions = {
                composition: {
                    ...composition,
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
                concurrency: gpu.concurrency,
                jpegQuality: 85,
                chromiumOptions: {
                    disableWebSecurity: true,
                    headless: true,
                    gl: gpu.gl,
                    enableGPU: gpu.recommended === 'gpu',
                },
                onProgress: ({ progress }) => {
                    const pct = Math.round(progress * 100);
                    // Log every 10%, send to UI every update
                    if (pct % 10 === 0 || pct === 1 || pct >= 99) {
                        logInfo(`[MandatoryCredit] Render progress: ${pct}%`);
                    }
                    // Always send to UI
                    if (reportProgress) {
                        reportProgress(pct);
                    }
                },
            };
            logInfo(`[MandatoryCredit] Rendering with: ${gpu.recommended.toUpperCase()} (${gpu.gpuName}, concurrency: ${gpu.concurrency}, profile: ${proResProfile})`);
            
            if (this.browserPath) {
                renderOptions.browserExecutable = this.browserPath;
            }

            await renderMedia(renderOptions);

            // Check if MOV was created
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
            creditCache.clear();
            pendingCreditRenders.clear();
            logInfo('[MandatoryCredit] Cache cleared');
        } catch (e) {
            logError(`[MandatoryCredit] Cleanup failed: ${e.message}`);
        }
    }
    
    /**
     * PRE-RENDER: Queue a mandatory credit for background rendering
     */
    async preRender({ text, segmentId = 0, durationInSeconds = 5 }) {
        if (!text || !text.trim()) {
            return null;
        }
        
        const cacheKey = generateCreditCacheKey(text, durationInSeconds);
        
        const cached = getCachedCredit(cacheKey);
        if (cached) {
            logInfo(`[MandatoryCredit] Pre-render: Already cached ${cacheKey}`);
            return cached;
        }
        
        if (pendingCreditRenders.has(cacheKey)) {
            logInfo(`[MandatoryCredit] Pre-render: Already in progress ${cacheKey}`);
            return pendingCreditRenders.get(cacheKey);
        }
        
        logInfo(`[MandatoryCredit] Pre-render: Starting background render for "${text.substring(0, 30)}..."`);
        
        try {
            return await this.renderMandatoryCredit({ text, durationInSeconds, segmentId });
        } catch (e) {
            logError(`[MandatoryCredit] Pre-render failed: ${e.message}`);
            return null;
        }
    }
    
    isCached(text, durationInSeconds = 5) {
        if (!text) return false;
        const cacheKey = generateCreditCacheKey(text, durationInSeconds);
        return getCachedCredit(cacheKey) !== null;
    }
    
    getCacheStats() {
        return {
            cached: creditCache.size,
            pending: pendingCreditRenders.size,
            items: Array.from(creditCache.keys())
        };
    }
}

const mandatoryCreditRenderer = new MandatoryCreditRenderer();
export default mandatoryCreditRenderer;
export { MandatoryCreditRenderer, setProResProfile, PRORES_PROFILES };
