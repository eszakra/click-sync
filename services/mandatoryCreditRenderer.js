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
     * Main render function - uses Remotion renderer, falls back to Canvas
     */
    async renderMandatoryCredit({ text, durationInSeconds = 3, segmentId, onProgress = null }) {
        // Initialize paths on first use
        this.initializePaths();

        logInfo(`[MandatoryCredit] ========================================`);
        logInfo(`[MandatoryCredit] Rendering: "${text}"`);
        logInfo(`[MandatoryCredit] Duration: ${durationInSeconds}s, Segment: ${segmentId}`);

        // Try Remotion renderer first
        if (this.bundlePath && this.binariesDir) {
            try {
                const result = await this.renderWithRemotion({ text, durationInSeconds, segmentId, onProgress });
                if (result && fs.existsSync(result)) {
                    logInfo(`[MandatoryCredit] ✨ Remotion SUCCESS: ${result}`);
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
        return this.renderWithCanvas({ text, segmentId });
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

            // OPTIMIZED: Use more CPU cores
            const cpuCount = os.cpus().length;
            const optimizedConcurrency = Math.min(cpuCount, 8);
            logInfo(`[MandatoryCredit] Using concurrency: ${optimizedConcurrency} (CPU cores: ${cpuCount})`);

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
                onProgress: ({ progress }) => {
                    const pct = Math.round(progress * 100);
                    if (pct % 25 === 0) {
                        logInfo(`[MandatoryCredit] Render progress: ${pct}%`);
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
        
        logInfo(`[MandatoryCredit] Pre-render: Starting for "${text.substring(0, 30)}..."`);
        
        try {
            return await this.renderMandatoryCredit({ text, durationInSeconds, segmentId });
        } catch (e) {
            logError(`[MandatoryCredit] Pre-render failed: ${e.message}`);
            return null;
        }
    }
    
    /**
     * Check if a credit is cached (stub - no cache in this version)
     */
    isCached(text, durationInSeconds = 3) {
        return false;
    }
    
    /**
     * Get cache statistics (stub for compatibility with main.cjs)
     */
    getCacheStats() {
        return {
            cached: 0,
            pending: 0,
            items: []
        };
    }
}

const mandatoryCreditRenderer = new MandatoryCreditRenderer();
export default mandatoryCreditRenderer;
export { MandatoryCreditRenderer };
