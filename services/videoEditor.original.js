import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobe from 'ffprobe-static';
import path from 'path';
import fs from 'fs';
import os from 'os';
import config from '../config.js';
import lowerThirdRenderer from './lowerThirdRenderer.js';
import mandatoryCreditRenderer from './mandatoryCreditRenderer.js';
import log from 'electron-log';

// =============================================================================
// LOGGING CONFIGURATION
// All logs are centralized in ~/ClickStudio/logs/ for easy debugging
//
// Log files:
//   - editor.log     : General video editor operations, GPU detection
//   - audio.log      : Background music search, audio processing
//   - timeline.log   : Segment timing, duration calculations
//   - export.log     : Final render, FFmpeg encoding, overlay composition
// =============================================================================
const LOG_DIR = path.join(os.homedir(), 'ClickStudio', 'logs');
const EDITOR_LOG = path.join(LOG_DIR, 'editor.log');
const AUDIO_LOG = path.join(LOG_DIR, 'audio.log');
const TIMELINE_LOG = path.join(LOG_DIR, 'timeline.log');
const EXPORT_LOG = path.join(LOG_DIR, 'export.log');

// Initialize log directory and files
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

    const timestamp = new Date().toISOString();
    const separator = `\n${'='.repeat(70)}\n`;

    fs.appendFileSync(EDITOR_LOG, `${separator}[${timestamp}] VideoEditor Session Started\n${'='.repeat(70)}\n`);
    fs.appendFileSync(AUDIO_LOG, `${separator}[${timestamp}] Audio Session Started\n${'='.repeat(70)}\n`);
    fs.appendFileSync(TIMELINE_LOG, `${separator}[${timestamp}] Timeline Session Started\n${'='.repeat(70)}\n`);
    fs.appendFileSync(EXPORT_LOG, `${separator}[${timestamp}] Export Session Started\n${'='.repeat(70)}\n`);
} catch (e) {
    console.error('[VideoEditor] Failed to initialize log files:', e.message);
}

// Centralized logging function
function writeLog(filePath, category, msg) {
    const logLine = `[${new Date().toISOString()}] [${category}] ${msg}\n`;
    console.log(`[${category}] ${msg}`);
    try { fs.appendFileSync(filePath, logLine); } catch (e) { /* ignore */ }
}

// Logging helpers for each category
function editorLog(msg) {
    writeLog(EDITOR_LOG, 'EDITOR', msg);
}

function audioLog(msg) {
    writeLog(AUDIO_LOG, 'AUDIO', msg);
}

function timelineLog(msg) {
    writeLog(TIMELINE_LOG, 'TIMELINE', msg);
}

function exportLog(msg) {
    writeLog(EXPORT_LOG, 'EXPORT', msg);
}

// Enhanced export logging with categories
const ExportLogger = {
    sessionId: null,
    startTime: null,
    phases: {},

    // Start a new export session
    startSession(outputPath) {
        this.sessionId = Date.now().toString(36);
        this.startTime = Date.now();
        this.phases = {};

        const separator = '\n' + '═'.repeat(100) + '\n';
        const header = `
${separator}
  EXPORT SESSION: ${this.sessionId}
  Started: ${new Date().toISOString()}
  Output: ${outputPath}
${separator}`;

        try {
            fs.appendFileSync(EXPORT_LOG_PATH, header);
        } catch (e) { }

        this.info('SESSION', 'Export session started');
        this.logSystemInfo();
    },

    // Log system info at start
    logSystemInfo() {
        const cpus = os.cpus();
        const totalMem = (os.totalmem() / 1024 / 1024 / 1024).toFixed(1);
        const freeMem = (os.freemem() / 1024 / 1024 / 1024).toFixed(1);

        this.info('SYSTEM', `Platform: ${os.platform()} ${os.arch()}`);
        this.info('SYSTEM', `CPU: ${cpus[0]?.model || 'Unknown'} (${cpus.length} cores)`);
        this.info('SYSTEM', `Memory: ${freeMem}GB free / ${totalMem}GB total`);
    },

    // Start a phase timer
    startPhase(phase) {
        this.phases[phase] = { start: Date.now(), end: null };
        this.info(phase, `Phase started`);
    },

    // End a phase timer
    endPhase(phase, success = true) {
        if (this.phases[phase]) {
            this.phases[phase].end = Date.now();
            const elapsed = ((this.phases[phase].end - this.phases[phase].start) / 1000).toFixed(2);
            this.info(phase, `Phase ${success ? 'completed' : 'FAILED'} in ${elapsed}s`);
            return parseFloat(elapsed);
        }
        return 0;
    },

    // Log info message
    info(category, msg) {
        const elapsed = this.startTime ? `+${((Date.now() - this.startTime) / 1000).toFixed(1)}s` : '';
        const logLine = `[${new Date().toISOString()}] [${elapsed.padStart(8)}] [${category.padEnd(12)}] ${msg}\n`;
        console.log(`[EXPORT/${category}] ${msg}`);
        try {
            fs.appendFileSync(EXPORT_LOG_PATH, logLine);
        } catch (e) { }
    },

    // Log warning
    warn(category, msg) {
        this.info(category, `⚠️ WARNING: ${msg}`);
    },

    // Log error
    error(category, msg, error = null) {
        this.info(category, `❌ ERROR: ${msg}`);
        if (error?.stack) {
            try {
                fs.appendFileSync(EXPORT_LOG_PATH, `    Stack: ${error.stack}\n`);
            } catch (e) { }
        }
    },

    // Log FFmpeg command
    logFFmpegCommand(command) {
        const separator = '-'.repeat(80);
        try {
            fs.appendFileSync(EXPORT_LOG_PATH, `\n${separator}\nFFMPEG COMMAND:\n${separator}\n${command}\n${separator}\n\n`);
        } catch (e) { }
        this.info('FFMPEG', `Command logged (${command.length} chars)`);
    },

    // Log progress
    progress(percent, fps, speed, eta) {
        // Only log every 10%
        if (percent % 10 === 0 || percent >= 99) {
            this.info('PROGRESS', `${percent}% | FPS: ${fps || 'N/A'} | Speed: ${speed || 'N/A'}x | ETA: ${eta || 'calculating...'}`);
        }
    },

    // Log overlay generation
    logOverlay(type, index, total, details) {
        this.info('OVERLAY', `[${index}/${total}] ${type}: ${details}`);
    },

    // Log encoder info
    logEncoder(encoder, hwAccel) {
        this.info('ENCODER', `Using: ${encoder} | Hardware Acceleration: ${hwAccel ? 'YES' : 'NO'}`);
    },

    // Log file info
    logFile(label, filePath, exists = null) {
        if (exists === null) exists = fs.existsSync(filePath);
        if (exists) {
            try {
                const stats = fs.statSync(filePath);
                const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
                this.info('FILE', `${label}: ${filePath} (${sizeMB} MB)`);
            } catch (e) {
                this.info('FILE', `${label}: ${filePath} (size unknown)`);
            }
        } else {
            this.warn('FILE', `${label}: ${filePath} (NOT FOUND)`);
        }
    },

    // End session with summary
    endSession(success, outputPath = null) {
        const totalTime = this.startTime ? ((Date.now() - this.startTime) / 1000).toFixed(2) : 'unknown';

        let summary = `\n${'═'.repeat(100)}\n  EXPORT ${success ? 'COMPLETED' : 'FAILED'}\n`;
        summary += `  Session: ${this.sessionId}\n`;
        summary += `  Total Time: ${totalTime}s\n`;

        if (outputPath && fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            summary += `  Output Size: ${sizeMB} MB\n`;
        }

        summary += `\n  Phase Timings:\n`;
        for (const [phase, times] of Object.entries(this.phases)) {
            if (times.end) {
                const elapsed = ((times.end - times.start) / 1000).toFixed(2);
                summary += `    - ${phase}: ${elapsed}s\n`;
            }
        }

        summary += `${'═'.repeat(100)}\n\n`;

        try {
            fs.appendFileSync(EXPORT_LOG_PATH, summary);
        } catch (e) { }

        this.info('SESSION', success ? 'Export completed successfully' : 'Export failed');

        // Return summary for UI
        return {
            success,
            sessionId: this.sessionId,
            totalTime: parseFloat(totalTime),
            phases: this.phases,
            outputPath
        };
    }
};

// Performance timing helper
function logTiming(label, startTime) {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    editorLog(`[TIMING] ${label}: ${elapsed}s`);
    return elapsed;
}

// Set ffmpeg path globally
if (ffmpegPath) {
    ffmpeg.setFfmpegPath(ffmpegPath.replace('app.asar', 'app.asar.unpacked'));
} else {
    console.warn('ffmpeg-static not found, expecting global installation');
}

if (ffprobe) {
    ffmpeg.setFfprobePath(ffprobe.path.replace('app.asar', 'app.asar.unpacked'));
}

class VideoEditorEngine {
    constructor(options = {}) {
        this.outputDir = config.paths.outputVideo;
        this.tempDir = config.paths.temp;
        this.timeline = [];
        this.narrationAudio = null;
        this.projectName = options.projectName || `project_${Date.now()}`;

        this.exportSettings = config.editor;

        // HW Acceleration State
        this.availableEncoders = new Set();
        this.encoderScanPromise = null;
        this.encoderScanComplete = false;
        this.detectedGPU = null;

        // Start async scan immediately
        this.encoderScanPromise = this.scanHardwareEncodersAsync();

        // Export cancellation state
        this.currentExportCommand = null;
        this.exportCancelled = false;

        this.ensureDirectories();
    }

    /**
     * Set the logo path from main process (which has access to app.getAppPath)
     */
    setLogoPath(logoPath) {
        if (logoPath && fs.existsSync(logoPath)) {
            this.logoPath = logoPath;
            console.log('[Editor] Logo path configured:', logoPath);
            return true;
        }
        console.warn('[Editor] Invalid logo path provided:', logoPath);
        return false;
    }

    /**
     * Get logo path, verifying it exists
     * Handles both development and production (asar.unpacked) paths
     * Returns a "safe" path (copied to temp if original has spaces/special chars)
     */
    getLogoPath() {
        // If we already have a safe cached path, use it
        if (this.safeLogoPath && fs.existsSync(this.safeLogoPath)) {
            return this.safeLogoPath;
        }

        // Find the original logo
        let originalLogoPath = null;

        // If logoPath was set externally (from main.cjs), use it
        if (this.logoPath && fs.existsSync(this.logoPath)) {
            originalLogoPath = this.logoPath;
        } else {
            const possiblePaths = [
                // Development path
                path.join(config.paths.root, 'assets', 'branding', 'logo.png'),
                // Production path (asar.unpacked)
                path.join(config.paths.root.replace('app.asar', 'app.asar.unpacked'), 'assets', 'branding', 'logo.png'),
                // Alternative: relative to services folder
                path.join(path.dirname(config.paths.root), 'assets', 'branding', 'logo.png'),
                // Alternative with asar.unpacked
                path.join(path.dirname(config.paths.root).replace('app.asar', 'app.asar.unpacked'), 'assets', 'branding', 'logo.png')
            ];

            for (const logoPath of possiblePaths) {
                if (fs.existsSync(logoPath)) {
                    console.log('[Editor] Logo found at:', logoPath);
                    originalLogoPath = logoPath;
                    break;
                }
            }
        }

        if (!originalLogoPath) {
            console.warn('[Editor] Logo not found');
            return null;
        }

        // Check if path has problematic characters for FFmpeg
        const hasProblematicChars = /[ ()']/.test(originalLogoPath);

        if (hasProblematicChars) {
            // Copy to temp directory with safe name
            const tempDir = os.tmpdir();
            const safePath = path.join(tempDir, 'clicksync_logo.png');

            try {
                fs.copyFileSync(originalLogoPath, safePath);
                console.log('[Editor] Logo copied to safe path:', safePath);
                this.safeLogoPath = safePath;
                return safePath;
            } catch (err) {
                console.error('[Editor] Failed to copy logo to temp:', err.message);
                // Fall back to original (may fail with FFmpeg)
                return originalLogoPath;
            }
        }

        // Original path is safe, use it directly
        this.safeLogoPath = originalLogoPath;
        return originalLogoPath;
    }

    /**
     * Cancel the current export
     */
    cancelExport() {
        console.log('[Editor] Cancel export requested');
        this.exportCancelled = true;
        if (this.currentExportCommand) {
            try {
                this.currentExportCommand.kill('SIGKILL');
                console.log('[Editor] FFmpeg process killed');
            } catch (e) {
                console.error('[Editor] Failed to kill FFmpeg process:', e);
            }
        }
    }

    ensureDirectories() {
        [this.outputDir, this.tempDir].forEach(dir => {
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
        });
    }

    /**
     * Get background music file path
     * Looks for audio files in assets/music/ folder (bundled with app)
     * Copies to temp with safe path for FFmpeg
     * Supported formats: mp3, wav, m4a, aac, ogg, flac
     */
    getBackgroundMusicPath() {
        // If we already have a safe cached path, use it
        if (this.safeMusicPath && fs.existsSync(this.safeMusicPath)) {
            return this.safeMusicPath;
        }

        const supportedFormats = ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac'];

        // Build comprehensive list of possible music paths
        // PRODUCTION: resources/app.asar.unpacked/assets/music/
        // DEVELOPMENT: ./assets/music/ (relative to project root)
        const possibleDirs = [];

        // Method 1: Use __dirname of this file (services folder)
        const thisDir = path.dirname(import.meta.url.replace('file:///', '').replace('file://', ''));
        const parentDir = path.dirname(thisDir);

        // Production path: go from services/ up to app.asar.unpacked/, then assets/music/
        possibleDirs.push(path.join(parentDir.replace('app.asar', 'app.asar.unpacked'), 'assets', 'music'));

        // Development path: go from services/ up to project root, then assets/music/
        possibleDirs.push(path.join(parentDir, 'assets', 'music'));

        // Method 2: Use config.paths.root (backup)
        possibleDirs.push(path.join(config.paths.root.replace('app.asar', 'app.asar.unpacked'), 'assets', 'music'));
        possibleDirs.push(path.join(config.paths.root, 'assets', 'music'));

        // Method 3: Use process.resourcesPath (Electron production)
        if (process.resourcesPath) {
            possibleDirs.push(path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'music'));
        }

        // Method 4: Use process.cwd() as fallback
        possibleDirs.push(path.join(process.cwd(), 'assets', 'music'));

        audioLog('========== SEARCHING FOR BACKGROUND MUSIC ==========');
        audioLog(`Searching in ${possibleDirs.length} possible directories:`);
        possibleDirs.forEach((dir, i) => audioLog(`  [${i}] ${dir}`));

        let originalMusicPath = null;

        for (const musicDir of possibleDirs) {
            // Skip asar paths - FFmpeg can't read them
            if (musicDir.includes('app.asar') && !musicDir.includes('app.asar.unpacked')) {
                audioLog(`SKIP (asar): ${musicDir}`);
                continue;
            }

            if (!fs.existsSync(musicDir)) {
                audioLog(`NOT FOUND: ${musicDir}`);
                continue;
            }

            audioLog(`CHECKING: ${musicDir}`);
            const files = fs.readdirSync(musicDir);
            audioLog(`  Files in dir: ${files.join(', ')}`);
            for (const file of files) {
                const ext = path.extname(file).toLowerCase();
                if (supportedFormats.includes(ext)) {
                    originalMusicPath = path.join(musicDir, file);
                    audioLog(`SUCCESS! Found music: ${originalMusicPath}`);
                    break;
                }
            }
            if (originalMusicPath) break;
        }

        if (!originalMusicPath) {
            audioLog('ERROR: No background music found in any location!');
            return null;
        }

        // Copy to temp directory with safe name (no spaces, no special chars)
        const ext = path.extname(originalMusicPath);
        const safePath = path.join(os.tmpdir(), `clicksync_bgm${ext}`);

        try {
            fs.copyFileSync(originalMusicPath, safePath);
            audioLog(`Copied to temp: ${safePath}`);

            // Verify the file was copied and has content
            const stats = fs.statSync(safePath);
            audioLog(`File size: ${stats.size} bytes (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);

            if (stats.size === 0) {
                audioLog('ERROR: Music file is EMPTY!');
                return null;
            }

            this.safeMusicPath = safePath;
            audioLog(`Music ready at: ${safePath}`);
            return safePath;
        } catch (err) {
            audioLog(`ERROR copying music: ${err.message}`);
            return null;
        }
    }

    /**
     * Scan for available hardware encoders (async version)
     * Returns a Promise that resolves when scan is complete
     */
    async scanHardwareEncodersAsync() {
        return new Promise((resolve) => {
            const startTime = Date.now();
            editorLog('[GPU] Starting hardware encoder scan...');

            ffmpeg.getAvailableEncoders((err, encoders) => {
                if (err) {
                    console.error('[Editor] Failed to scan encoders:', err);
                    editorLog(`[GPU] Encoder scan failed: ${err.message}`);
                    this.encoderScanComplete = true;
                    resolve();
                    return;
                }

                // Store keys of available encoders
                Object.keys(encoders).forEach(key => this.availableEncoders.add(key));

                // Detect GPU type
                const hasNvenc = this.availableEncoders.has('h264_nvenc');
                const hasQsv = this.availableEncoders.has('h264_qsv');
                const hasAmf = this.availableEncoders.has('h264_amf');

                if (hasNvenc) {
                    this.detectedGPU = { type: 'NVIDIA', encoder: 'h264_nvenc', name: 'NVIDIA NVENC' };
                } else if (hasQsv) {
                    this.detectedGPU = { type: 'Intel', encoder: 'h264_qsv', name: 'Intel Quick Sync' };
                } else if (hasAmf) {
                    this.detectedGPU = { type: 'AMD', encoder: 'h264_amf', name: 'AMD AMF' };
                } else {
                    this.detectedGPU = { type: 'CPU', encoder: 'libx264', name: 'CPU (Software)' };
                }

                this.encoderScanComplete = true;
                const elapsed = Date.now() - startTime;

                // Detailed logging
                editorLog(`[GPU] ═══════════════════════════════════════════════════════`);
                editorLog(`[GPU] Hardware Encoder Detection Complete (${elapsed}ms)`);
                editorLog(`[GPU] ───────────────────────────────────────────────────────`);
                editorLog(`[GPU] Detected: ${this.detectedGPU.name}`);
                editorLog(`[GPU] H.264 Encoder: ${this.getBestEncoder('h264')}`);
                editorLog(`[GPU] H.265 Encoder: ${this.getBestEncoder('h265')}`);
                editorLog(`[GPU] NVENC: ${hasNvenc ? '✓ Available' : '✗ Not found'}`);
                editorLog(`[GPU] Quick Sync: ${hasQsv ? '✓ Available' : '✗ Not found'}`);
                editorLog(`[GPU] AMF: ${hasAmf ? '✓ Available' : '✗ Not found'}`);
                editorLog(`[GPU] ═══════════════════════════════════════════════════════`);

                console.log(`[Editor] GPU Detection: ${this.detectedGPU.name} - Using ${this.getBestEncoder('h264')} for H.264`);

                resolve();
            });
        });
    }

    /**
     * Ensure encoder scan is complete before using encoders
     * Call this before any encoding operation
     */
    async ensureEncodersReady() {
        if (this.encoderScanComplete) {
            return;
        }

        if (this.encoderScanPromise) {
            editorLog('[GPU] Waiting for encoder scan to complete...');
            await this.encoderScanPromise;
        }
    }

    /**
     * Get GPU info for UI display
     */
    getGPUInfo() {
        return {
            detected: this.detectedGPU,
            encoders: {
                h264: this.getBestEncoder('h264'),
                h265: this.getBestEncoder('h265'),
            },
            isHardwareAccelerated: this.detectedGPU && this.detectedGPU.type !== 'CPU',
            scanComplete: this.encoderScanComplete
        };
    }

    /**
     * Get best available encoder for codec
     */
    getBestEncoder(codecBase) { // 'h264' or 'h265'
        const base = codecBase === 'h264' ? 'h264' : 'hevc';
        const libFallback = codecBase === 'h264' ? 'libx264' : 'libx265';

        // Priority: NVIDIA > Intel QSV > AMD AMF > CPU
        if (this.availableEncoders.has(`${base}_nvenc`)) return `${base}_nvenc`;
        if (this.availableEncoders.has(`${base}_qsv`)) return `${base}_qsv`;
        if (this.availableEncoders.has(`${base}_amf`)) return `${base}_amf`;

        return libFallback;
    }

    /**
     * Get encoder-specific options for optimal quality/speed
     */
    getEncoderOptions(encoder, preset = 'fast') {
        const options = [];

        if (encoder.includes('nvenc')) {
            // NVIDIA NVENC optimized settings
            // OPTIMIZED: p2 is faster than p4 with minimal quality loss
            options.push('-rc', 'vbr');
            options.push('-preset', preset === 'fast' ? 'p2' : 'p4');
            options.push('-tune', 'hq');
            options.push('-rc-lookahead', '15');
            options.push('-spatial-aq', '1');
            options.push('-temporal-aq', '1');
        } else if (encoder.includes('qsv')) {
            // Intel Quick Sync settings
            options.push('-preset', preset === 'fast' ? 'faster' : 'medium');
            options.push('-async_depth', '4');
        } else if (encoder.includes('amf')) {
            // AMD AMF settings
            options.push('-quality', preset === 'fast' ? 'speed' : 'balanced');
            options.push('-rc', 'vbr_latency');
        } else {
            // CPU libx264 settings
            options.push('-preset', preset === 'fast' ? 'ultrafast' : 'medium');
        }

        return options;
    }

    /**
     * PASO 1: Cargar audio de narración (opcional)
     * Si se proporciona, los tiempos se calculan del audio real
     */
    async loadNarrationAudio(audioPath) {

        if (!fs.existsSync(audioPath)) {
            console.warn('[Editor] No narration audio provided, using text-based timing');
            return null;
        }

        const duration = await this.getMediaDuration(audioPath);
        this.narrationAudio = {
            path: audioPath,
            duration
        };

        console.log(`[Editor] Loaded narration: ${this.narrationAudio.duration}s`);
        return this.narrationAudio;
    }

    /**
     * PASO 2: Añadir clip a la timeline
     * Recorta automáticamente el video a la duración del segmento
     */
    async addClipToTimeline(segmentIndex, videoPath, segmentDuration, options = {}) {
        if (!fs.existsSync(videoPath)) {
            throw new Error(`Video file not found: ${videoPath}`);
        }

        const {
            startOffset = 0,        // Desde qué segundo del video empezar
            fadeIn = 0,             // Fade in en segundos
            fadeOut = 0,            // Fade out en segundos
            volume = 0,             // 0 = mute video audio (narración domina)
            speed = 1.0,            // Velocidad (1.0 = normal)
            headline = ''           // Para overlay de texto
        } = options;

        // Obtener duración real del video descargado
        const videoDuration = await this.getMediaDuration(videoPath);

        let clipDuration = segmentDuration;
        let actualStartOffset = startOffset;

        // Crear clip recortado en carpeta temporal
        // Usamos un hash o timestamp para evitar colisiones
        const trimmedPath = path.join(this.tempDir, `clip_${segmentIndex}_trimmed_${Date.now()}.mp4`);
        const thumbnailPath = path.join(this.tempDir, `clip_${segmentIndex}_thumb_${Date.now()}.jpg`);

        console.log(`[Editor] Preparing clip ${segmentIndex} of ${clipDuration}s from ${videoPath}`);

        try {
            await this.trimAndPrepareClip(videoPath, trimmedPath, {
                startOffset: actualStartOffset,
                duration: clipDuration,
                fadeIn,
                fadeOut,
                volume,
                speed
            });

            // Generar thumbnail para UI
            await this.generateThumbnail(trimmedPath, thumbnailPath);

            // CRITICAL: Verify actual duration of processed clip
            // This ensures timeline calculations use real durations, not expected ones
            let actualDuration = clipDuration;
            try {
                actualDuration = await this.getMediaDuration(trimmedPath);
                const durationDiff = Math.abs(actualDuration - clipDuration);

                if (durationDiff > 0.1) {
                    editorLog(`[Duration] Segment ${segmentIndex}: Expected ${clipDuration.toFixed(2)}s, Actual ${actualDuration.toFixed(2)}s (diff: ${durationDiff.toFixed(2)}s)`);
                } else {
                    editorLog(`[Duration] Segment ${segmentIndex}: ${actualDuration.toFixed(2)}s (OK)`);
                }
            } catch (e) {
                editorLog(`[Duration] Warning: Could not verify duration for segment ${segmentIndex}: ${e.message}`);
            }

            // Añadir o reemplazar en timeline
            const existingIndex = this.timeline.findIndex(c => c.index === segmentIndex);
            const clipData = {
                index: segmentIndex,
                originalVideo: videoPath,
                processedVideo: trimmedPath,
                previewUrl: `file://${trimmedPath}`, // Para Electron/React
                thumbnail: `file://${thumbnailPath}`,
                duration: actualDuration,  // Use ACTUAL duration, not expected
                expectedDuration: clipDuration,  // Keep expected for reference
                headline,
                options
            };

            if (existingIndex !== -1) {
                console.log(`[Editor] Replacing existing clip at index ${segmentIndex}`);
                // Borrar archivo temp anterior
                try {
                    if (fs.existsSync(this.timeline[existingIndex].processedVideo)) {
                        fs.unlinkSync(this.timeline[existingIndex].processedVideo);
                    }
                } catch (e) {/* ignore */ }
                this.timeline[existingIndex] = clipData;
            } else {
                this.timeline.push(clipData);
            }

            console.log(`[Editor] Added clip ${segmentIndex} to timeline`);
            return clipData;
        } catch (error) {
            console.error(`[Editor] Failed to process clip ${segmentIndex}:`, error);
            throw error;
        }
    }

    /**
     * PASO 2b: Añadir clip de relleno (Placeholder) para errores
     * Genera un video negro silente para mantener la sincronización
     */
    async addPlaceholderClip(segmentIndex, duration) {
        console.log(`[Editor] Generating placeholder clip for segment ${segmentIndex} (${duration}s)`);
        const placeholderPath = path.join(this.tempDir, `placeholder_${segmentIndex}_${Date.now()}.mp4`);
        const thumbnailPath = path.join(this.tempDir, `placeholder_${segmentIndex}_thumb_${Date.now()}.jpg`);

        try {
            await this.ensureEncodersReady();

            return new Promise((resolve, reject) => {
                const command = ffmpeg();

                // Generate black video using lavfi
                command.input('color=c=black:s=1920x1080:r=30')
                    .inputFormat('lavfi')
                    .duration(duration);

                // Add silent audio to prevent issues
                command.input('anullsrc=r=44100:cl=stereo')
                    .inputFormat('lavfi')
                    .duration(duration);

                const encoder = this.getBestEncoder('h264');
                const isHardwareEncoder = encoder !== 'libx264';

                const outputOpts = [
                    '-c:v', encoder,
                    '-pix_fmt', 'yuv420p',
                    '-c:a', 'aac',
                    '-shortest',
                    '-video_track_timescale', '30000'
                ];

                if (isHardwareEncoder) {
                    outputOpts.push('-b:v', '5000k');
                } else {
                    outputOpts.push('-preset', 'ultrafast');
                }

                command
                    .outputOptions(outputOpts)
                    .on('end', async () => {
                        // Create dummy thumbnail
                        try {
                            await this.generateThumbnail(placeholderPath, thumbnailPath);
                        } catch (e) { /* ignore thumb error */ }

                        const clipData = {
                            index: segmentIndex,
                            originalVideo: null,
                            processedVideo: placeholderPath,
                            previewUrl: `file://${placeholderPath}`,
                            thumbnail: `file://${thumbnailPath}`,
                            duration: duration,
                            expectedDuration: duration,
                            headline: 'VIDEO MISSING (ERROR)',
                            isPlaceholder: true
                        };

                        const existingIndex = this.timeline.findIndex(c => c.index === segmentIndex);
                        if (existingIndex !== -1) {
                            this.timeline[existingIndex] = clipData;
                        } else {
                            this.timeline.push(clipData);
                        }

                        console.log(`[Editor] Added placeholder ${segmentIndex} to timeline`);
                        resolve(clipData);
                    })
                    .on('error', (err) => {
                        console.error('[Editor] Failed to generate placeholder:', err);
                        reject(err);
                    })
                    .save(placeholderPath);
            });
        } catch (error) {
            console.error('[Editor] Placeholder error:', error);
            throw error;
        }
    }

    /**
     * Recorta y prepara un clip individual
     * NOW WITH GPU ACCELERATION when available
     */
    async trimAndPrepareClip(inputPath, outputPath, options) {
        // Ensure encoders are ready before processing
        await this.ensureEncodersReady();

        return new Promise((resolve, reject) => {
            // Check input duration first to decide on looping
            this.getMediaDuration(inputPath).then(inputDuration => {
                let command = ffmpeg(inputPath);
                const targetDuration = options.duration;

                // If input is shorter than target, we need to loop
                // stream_loop -1 means infinite, but we can just loop enough times
                // or use stream_loop before input
                const shouldLoop = inputDuration < targetDuration;

                if (shouldLoop) {
                    console.log(`[Editor] Video shorter than audio (${inputDuration}s < ${targetDuration}s). Looping.`);
                    // -stream_loop -1 must be BEFORE input
                    command = ffmpeg();
                    command.inputOption('-stream_loop', '-1');
                    command.input(inputPath);
                }

                command
                    .setStartTime(options.startOffset || 0)
                    .setDuration(targetDuration); // Exact duration of the SEGMENT

                // Video filter for scaling (logo is applied ONLY in exportFinalVideo to avoid duplication)
                // CRITICAL: Include fps=30 to standardize frame rate across ALL clips
                // This prevents freezing/stuttering when concatenating clips with different source FPS
                const videoFilter = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1,fps=30';

                // Get best encoder (GPU if available, CPU fallback)
                const encoder = this.getBestEncoder('h264');
                const isHardwareEncoder = encoder !== 'libx264';
                const encoderOptions = this.getEncoderOptions(encoder, 'fast');

                // Build output options based on encoder type
                const outputOpts = [
                    '-vf', videoFilter,
                    '-r', '30',           // Force 30fps output (matches fps filter)
                    '-vsync', 'cfr',      // Constant frame rate (prevents dropped/duplicated frames)
                    '-c:v', encoder,
                    '-pix_fmt', 'yuv420p',
                    '-avoid_negative_ts', 'make_zero',
                    '-video_track_timescale', '30000'  // Consistent timescale for smooth concat
                ];

                // Add encoder-specific options
                if (isHardwareEncoder) {
                    // Hardware encoder: use bitrate mode for consistent quality
                    outputOpts.push('-b:v', '8000k');
                    outputOpts.push('-maxrate', '10000k');
                    outputOpts.push('-bufsize', '16000k');
                    outputOpts.push(...encoderOptions);
                } else {
                    // CPU encoder: use CRF for quality
                    outputOpts.push('-preset', 'ultrafast');
                    outputOpts.push('-crf', '28');
                }

                command.outputOptions(outputOpts);

                editorLog(`[Clip] Processing with ${isHardwareEncoder ? 'GPU' : 'CPU'} encoder: ${encoder}`);
                editorLog(`[Clip] Filter: ${videoFilter}`);

                // Audio - Mute original video audio to prioritize narration
                if (options.volume === 0) {
                    command.noAudio();
                } else {
                    command.audioFilters(`volume=${options.volume}`);
                }

                // Execute the command
                command
                    .on('end', () => resolve(outputPath))
                    .on('error', (err) => {
                        console.error('[ffmpeg] Error processing clip:', err);
                        reject(err);
                    })
                    .save(outputPath);
            }).catch(reject);
        });
    }

    async generateThumbnail(videoPath, imagePath) {
        return new Promise((resolve, reject) => {
            ffmpeg(videoPath)
                .screenshots({
                    timestamps: ['50%'],
                    filename: path.basename(imagePath),
                    folder: path.dirname(imagePath),
                    size: '320x180'
                })
                .on('end', () => resolve(imagePath))
                .on('error', reject);
        });
    }

    /**
     * PASO 5: Generar preview del video COMPLETO (baja calidad, rápido)
     */
    async generateFullPreview() {
        if (this.timeline.length === 0) throw new Error('Timeline is empty');

        const previewPath = path.join(this.tempDir, `full_preview_${Date.now()}.mp4`);
        const sortedClips = [...this.timeline].sort((a, b) => a.index - b.index);

        // Crear archivo de lista para concat
        const listPath = path.join(this.tempDir, 'preview_list.txt');
        // Importante: ffmpeg concat requiere paths absolutos y escapados
        const listContent = sortedClips.map(c => `file '${c.processedVideo.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(listPath, listContent);

        return new Promise((resolve, reject) => {
            let command = ffmpeg()
                .input(listPath)
                .inputOptions(['-f', 'concat', '-safe', '0']);

            // Check for logo (getLogoPath returns a safe path without spaces)
            const logoPath = this.getLogoPath();
            const hasLogo = !!logoPath;

            console.log(`[Editor] Full preview - Logo available: ${hasLogo}`);

            // Audio input index (right after video concat)
            let audioInputIndex = 1;

            // Add narration if exists
            if (this.narrationAudio) {
                command = command.input(this.narrationAudio.path);
            }

            // Preview filter with logo (720p, logo scaled proportionally)
            const previewLogoHeight = 67; // ~100px scaled to 720p
            const previewLogoPadding = 14; // ~20px scaled to 720p

            const outputOptions = [
                '-c:v', 'libx264',
                '-preset', 'ultrafast'
            ];

            if (hasLogo) {
                // Convert to forward slashes and escape colons for FFmpeg
                const ffmpegLogoPath = logoPath.replace(/\\/g, '/').replace(/:/g, '\\:');

                // Use movie= filter with format=rgba to preserve PNG colors correctly
                const filterComplex = [
                    `[0:v]scale=1280:720[scaled]`,
                    `movie='${ffmpegLogoPath}',format=rgba,scale=-1:${previewLogoHeight}[logo]`,
                    `[scaled][logo]overlay=W-w-${previewLogoPadding}:${previewLogoPadding}:format=auto[out]`
                ].join(';');
                outputOptions.unshift('-filter_complex', filterComplex, '-map', '[out]');
            } else {
                outputOptions.unshift('-vf', 'scale=1280:720');
            }

            if (this.narrationAudio) {
                outputOptions.push('-map', `${audioInputIndex}:a`);
            }

            command
                .outputOptions(outputOptions)
                .on('end', () => resolve(previewPath))
                .on('error', reject)
                .save(previewPath);
        });
    }

    /**
     * PASO 6: EXPORTAR VIDEO FINAL (alta calidad)
     * NOW WITH GPU ACCELERATION - automatically uses best available encoder
     */
    async exportFinalVideo(options = {}, onProgress = () => { }) {
        // Handle case where options is strictly a callback (backward compatibility)
        if (typeof options === 'function') {
            onProgress = options;
            options = {};
        }

        // CRITICAL: Ensure encoder scan is complete before starting export
        await this.ensureEncodersReady();

        const {
            resolution = '1080p',
            bitrate = 8000, // Now in kbps (YouTube optimized default)
            codec = 'h264',
            format = 'mp4',
            fps = 30,
            filePath, // Use correct dest path
            segments = [], // Segment data for lower thirds (headline, duration, startTime, mandatoryCredit)
            enableLowerThirds = false, // Enable lower third overlays
            enableMandatoryCredits = false // Enable mandatory credit overlays (top-left)
        } = options;

        // Map Resolution
        let width = 1920;
        let height = 1080;
        if (resolution === '720p') { width = 1280; height = 720; }
        if (resolution === '480p') { width = 854; height = 480; }

        // Convert bitrate from kbps to string for FFmpeg (e.g., "8000k")
        // Handle both new format (number) and legacy format (string 'high'/'medium'/'low')
        let videoBitrateKbps = 8000; // Default
        if (typeof bitrate === 'number') {
            videoBitrateKbps = bitrate;
        } else if (bitrate === 'high') {
            videoBitrateKbps = 12000;
        } else if (bitrate === 'medium') {
            videoBitrateKbps = 8000;
        } else if (bitrate === 'low') {
            videoBitrateKbps = 5000;
        }
        const videoBitrate = `${videoBitrateKbps}k`;

        // Map Codec - Use best detected hardware encoder (GPU if available)
        const vCodec = this.getBestEncoder(codec); // codec is 'h264' or 'h265'
        const isHardwareEncoder = !vCodec.includes('lib'); // libx264/libx265 are software

        // Determine Final Output Path
        // If filePath is provided (folder selected), use it. Otherwise default to outputDir
        const targetDir = filePath || this.outputDir;

        // Ensure not overwriting if name not unique? Date.now() handles it usually.
        // options.fileName comes from modal but might just be base name.
        const fileName = (options.fileName && options.fileName !== 'video_export')
            ? `${options.fileName}.${format}`
            : `${this.projectName}_FINAL_${Date.now()}.${format}`;

        const finalPath = path.join(targetDir, fileName);

        // ============ ENHANCED EXPORT LOGGING WITH GPU INFO ============
        ExportLogger.startSession(finalPath);
        ExportLogger.startPhase('INITIALIZATION');

        // GPU/Encoder info
        const gpuInfo = this.getGPUInfo();
        const encoderType = isHardwareEncoder ? 'GPU' : 'CPU';
        const gpuName = gpuInfo.detected ? gpuInfo.detected.name : 'Unknown';

        ExportLogger.info('CONFIG', `Resolution: ${width}x${height} (${resolution})`);
        ExportLogger.info('CONFIG', `FPS: ${fps}, Codec: ${codec}, Bitrate: ${videoBitrate}`);
        ExportLogger.info('CONFIG', `Lower Thirds: ${enableLowerThirds ? 'ON' : 'OFF'}, Mandatory Credits: ${enableMandatoryCredits ? 'ON' : 'OFF'}`);
        ExportLogger.logEncoder(vCodec, isHardwareEncoder);
        ExportLogger.logFile('Output', finalPath, false);

        // Detailed GPU logging
        editorLog(`[EXPORT] ═══════════════════════════════════════════════════════`);
        editorLog(`[EXPORT] Starting Final Export`);
        editorLog(`[EXPORT] ───────────────────────────────────────────────────────`);
        editorLog(`[EXPORT] Encoder: ${vCodec} (${encoderType})`);
        editorLog(`[EXPORT] GPU: ${gpuName}`);
        editorLog(`[EXPORT] Hardware Accelerated: ${isHardwareEncoder ? 'YES ✓' : 'NO (using CPU)'}`);
        editorLog(`[EXPORT] Resolution: ${width}x${height} @ ${fps}fps`);
        editorLog(`[EXPORT] Bitrate: ${videoBitrate}`);
        editorLog(`[EXPORT] ═══════════════════════════════════════════════════════`);

        console.log(`[Editor] Starting final export: ${resolution} @ ${fps}fps`);
        console.log(`[Editor] Encoder: ${vCodec} (${encoderType} - ${gpuName})`);
        console.log(`[Editor] Output Path: ${finalPath}`);

        onProgress({ stage: 'preparing', percent: 0 });

        const sortedClips = [...this.timeline].sort((a, b) => a.index - b.index);

        ExportLogger.info('TIMELINE', `Clips: ${sortedClips.length}`);

        // Prepare list with robust path handling
        const listPath = path.join(this.tempDir, 'final_list.txt');

        // Helper to safely format paths for ffmpeg concat demuxer
        // 1. Convert backslashes to forward slashes
        // 2. Escape single quotes (which enclose the path)
        const listContent = sortedClips.map(c => {
            if (!c.processedVideo && !c.videoPath) return null;
            let p = c.processedVideo || c.videoPath;
            // Ensure absolute path
            if (!path.isAbsolute(p)) p = path.resolve(p);

            // Windows: Convert \ to /
            let safePath = p.replace(/\\/g, '/');

            // Escape single quotes for FFmpeg concat file: ' becomes '\''
            safePath = safePath.replace(/'/g, "'\\''");

            return `file '${safePath}'`;
        }).filter(Boolean).join('\n');

        // ============ TIMELINE VALIDATION & LOGGING ============
        exportLog('========== EXPORT STARTED ==========');
        exportLog(`Resolution: ${resolution}, FPS: ${fps}, Codec: ${codec}, Bitrate: ${videoBitrate}`);
        exportLog(`Output: ${finalPath}`);

        // Log timeline details
        timelineLog('========== TIMELINE CLIPS ==========');
        let totalExpectedDuration = 0;
        sortedClips.forEach((clip, i) => {
            const actualDur = clip.duration || 0;
            const expectedDur = clip.expectedDuration || actualDur;
            totalExpectedDuration += actualDur;
            timelineLog(`Clip ${i}: idx=${clip.index}, duration=${actualDur.toFixed(2)}s (expected: ${expectedDur.toFixed(2)}s), file=${path.basename(clip.processedVideo || 'N/A')}`);
            ExportLogger.info('TIMELINE', `Clip ${i}: ${actualDur.toFixed(2)}s - ${path.basename(clip.processedVideo || 'N/A')}`);
            ExportLogger.logFile(`Clip ${i}`, clip.processedVideo || clip.videoPath);
        });
        timelineLog(`Total timeline duration: ${totalExpectedDuration.toFixed(2)}s`);
        ExportLogger.info('TIMELINE', `Total duration: ${totalExpectedDuration.toFixed(2)}s`);

        exportLog(`Concat list: ${sortedClips.length} clips, total duration: ${totalExpectedDuration.toFixed(2)}s`);

        ExportLogger.endPhase('INITIALIZATION');

        // Validate that we have clips to export
        if (!listContent || listContent.trim().length === 0) {
            const error = new Error('No video clips available for export. Please ensure videos have been downloaded for all segments.');
            exportLog(`ERROR: ${error.message}`);
            ExportLogger.error('VALIDATION', 'No video clips available', error);
            ExportLogger.endSession(false);
            onProgress({ stage: 'error', error: error.message });
            throw error;
        }

        fs.writeFileSync(listPath, listContent, 'utf8');

        // Reset cancellation state
        this.exportCancelled = false;

        // ============ OVERLAYS GENERATION (Lower Thirds + Mandatory Credits) ============
        // OPTIMIZED: Reduced to 3 seconds (90 frames) - animation completes by ~80 frames
        // LowerThird: bars slide in (0-28 frames), saber effect (20-80 frames)
        // MandatoryCredit: bar slides in (0-20 frames)
        // FFmpeg handles timing with enable='between(t,start,end)' and eof_action=repeat
        const OVERLAY_DURATION_SECONDS = 3;
        exportLog(`Overlay duration: ${OVERLAY_DURATION_SECONDS}s per segment`);

        const lowerThirdOverlays = []; // { path, startTime, endTime }
        const mandatoryCreditOverlays = []; // { path, startTime, endTime }

        // Count total overlays to generate for progress calculation
        let totalOverlays = 0;
        let segmentsWithHeadline = 0;
        let segmentsWithCredit = 0;

        if (enableLowerThirds && segments) {
            segmentsWithHeadline = segments.filter(s => s.headline || s.title).length;
            totalOverlays += segmentsWithHeadline;
        }


        // DEBUG: Dump all segments credit status
        if (enableMandatoryCredits) {
            console.log('[Editor] DEBUG: Checking all segments for mandatory credits:');
            if (segments) segments.forEach((s, idx) => {
                console.log(`[Editor] Seg ${idx}: credit="${s.mandatoryCredit}" (Truthiness: ${!!(s.mandatoryCredit && s.mandatoryCredit.trim())})`);
            });
        }


        if (totalOverlays > 0) {
            ExportLogger.startPhase('OVERLAYS');
            ExportLogger.info('OVERLAYS', `Generating ${totalOverlays} overlays (${segmentsWithHeadline} lower thirds, ${segmentsWithCredit} mandatory credits) - PARALLEL MODE`);

            onProgress({
                stage: 'generating_overlays',
                percent: 0,
                totalOverlays,
                currentOverlay: 0,
                overlayType: 'preparing'
            });

            const overlayStartTime = Date.now();
            exportLog('========== GENERATING OVERLAYS (PARALLEL) ==========');

            // ============ PARALLEL OVERLAY RENDERING ============
            // Step 1: Prepare all overlay tasks with timing information
            const overlayTasks = [];
            let cumulativeTime = 0;

            // IMPORTANT: Use segments count for overlay generation, not clips count
            // This handles the case where 1 physical clip contains multiple logical segments
            const segmentCount = segments ? segments.length : sortedClips.length;
            const clipsCount = sortedClips.length;

            // Calculate total video duration from all clips
            const totalVideoDuration = sortedClips.reduce((sum, clip) => sum + (clip.duration || 5), 0);

            // When we have more segments than clips, divide the total duration evenly
            // When we have matching counts, use individual clip durations
            const useEvenDivision = segmentCount > clipsCount;
            const evenSegmentDuration = useEvenDivision ? totalVideoDuration / segmentCount : 0;

            editorLog(`[OVERLAY] Segment count: ${segmentCount}, Clips count: ${clipsCount}, Total duration: ${totalVideoDuration.toFixed(2)}s`);
            if (useEvenDivision) {
                editorLog(`[OVERLAY] Using even division: ${evenSegmentDuration.toFixed(2)}s per segment`);
            }

            for (let i = 0; i < segmentCount; i++) {
                // Get clip OR use the single clip if only 1 exists
                const clip = sortedClips[Math.min(i, clipsCount - 1)];
                const seg = segments ? segments[i] : null;

                // Calculate segment duration
                const segmentDuration = useEvenDivision ? evenSegmentDuration : (clip.duration || 5);

                const headline = seg ? (seg.headline || seg.title) : null;
                const mandatoryCredit = seg ? seg.mandatoryCredit : null;
                const segmentStartTime = cumulativeTime;
                const segmentEndTime = cumulativeTime + segmentDuration;

                timelineLog(`Segment ${i}: startTime=${segmentStartTime.toFixed(2)}s, duration=${segmentDuration.toFixed(2)}s, endTime=${segmentEndTime.toFixed(2)}s`);
                // DEBUG: Log mandatory credit status for each segment
                console.log(`[Editor] Segment ${i} mandatoryCredit: "${mandatoryCredit || '(empty)'}"`);
                exportLog(`Segment ${i} mandatoryCredit: "${mandatoryCredit || '(empty)'}"`);
                if (seg) {
                    console.log(`[Editor] Segment ${i} full data:`, JSON.stringify({ mandatoryCredit: seg.mandatoryCredit, headline: seg.headline, title: seg.title }, null, 2));
                }

                // Queue mandatory credit task
                if (enableMandatoryCredits && mandatoryCredit && mandatoryCredit.trim()) {
                    overlayTasks.push({
                        type: 'mandatory_credit',
                        segmentIndex: i,
                        text: mandatoryCredit,
                        startTime: segmentStartTime,
                        endTime: segmentEndTime
                    });
                }

                // Queue lower third task
                if (enableLowerThirds && headline) {
                    overlayTasks.push({
                        type: 'lower_third',
                        segmentIndex: i,
                        text: headline,
                        startTime: segmentStartTime,
                        endTime: segmentEndTime
                    });
                }

                cumulativeTime += segmentDuration;
            }

            // Step 2: Sort tasks by segment index (keeps order consistent)
            overlayTasks.sort((a, b) => {
                // First by segment index
                if (a.segmentIndex !== b.segmentIndex) return a.segmentIndex - b.segmentIndex;
                // Then mandatory credits before lower thirds (within same segment)
                if (a.type === 'mandatory_credit' && b.type === 'lower_third') return -1;
                if (a.type === 'lower_third' && b.type === 'mandatory_credit') return 1;
                return 0;
            });

            // Step 3: Execute tasks in PARALLEL BATCHES for speed
            // Limit concurrency to avoid overwhelming system resources
            const PARALLEL_OVERLAY_LIMIT = 3; // Render 3 overlays simultaneously
            let completedCount = 0;
            const results = [];

            // Track current display task for UI (prevents flickering from parallel updates)
            let currentDisplayTask = null;
            let lastProgressUpdate = 0;
            const PROGRESS_UPDATE_THROTTLE = 100; // Only update UI every 100ms

            editorLog(`[OVERLAY] Starting parallel rendering with concurrency limit: ${PARALLEL_OVERLAY_LIMIT}`);

            // Helper function to send throttled progress updates
            const sendProgressUpdate = (task, renderPercent) => {
                const now = Date.now();
                if (now - lastProgressUpdate < PROGRESS_UPDATE_THROTTLE) return;
                lastProgressUpdate = now;

                // Calculate total percentage: completed tasks + current task progress
                const totalPercent = Math.round(((completedCount * 100) + renderPercent) / totalOverlays);

                onProgress({
                    stage: 'generating_overlays',
                    percent: totalPercent,
                    totalOverlays,
                    currentOverlay: completedCount + 1,
                    overlayType: task.type,
                    overlayText: task.text.substring(0, 50) + (task.text.length > 50 ? '...' : ''),
                    segmentIndex: task.segmentIndex + 1,
                    totalSegments: sortedClips.length,
                    renderProgress: renderPercent
                });
            };

            // Helper function to render a single overlay task
            const renderOverlayTask = async (task, taskIndex) => {
                const taskType = task.type === 'mandatory_credit' ? 'MC' : 'LT';
                const taskNum = taskIndex + 1;

                editorLog(`[OVERLAY] Starting ${taskType} #${taskNum}/${totalOverlays} for segment ${task.segmentIndex}: "${task.text.substring(0, 30)}..."`);

                try {
                    let resultPath;

                    // Progress callback - throttled to prevent UI flickering
                    const onRenderProgress = (progressInfo) => {
                        // Only update UI if this is the "first" task in current batch (prevents parallel chaos)
                        if (!currentDisplayTask || currentDisplayTask === task) {
                            currentDisplayTask = task;
                            sendProgressUpdate(task, progressInfo.percent || 0);
                        }
                    };

                    if (task.type === 'mandatory_credit') {
                        resultPath = await mandatoryCreditRenderer.renderMandatoryCredit({
                            text: task.text,
                            durationInSeconds: OVERLAY_DURATION_SECONDS,
                            segmentId: task.segmentIndex,
                            onProgress: onRenderProgress
                        });
                    } else {
                        resultPath = await lowerThirdRenderer.renderLowerThird({
                            headline: task.text,
                            durationInSeconds: OVERLAY_DURATION_SECONDS,
                            segmentId: task.segmentIndex,
                            onProgress: onRenderProgress
                        });
                    }

                    if (resultPath) {
                        editorLog(`[OVERLAY] ✓ ${taskType} #${taskNum}/${totalOverlays}: ${path.basename(resultPath)}`);
                        return {
                            success: true,
                            path: resultPath,
                            type: task.type,
                            startTime: task.startTime,
                            endTime: task.endTime,
                            segmentIndex: task.segmentIndex
                        };
                    } else {
                        return { success: false, type: task.type, segmentIndex: task.segmentIndex };
                    }
                } catch (error) {
                    editorLog(`[OVERLAY] ✗ ${taskType} #${taskNum}/${totalOverlays} FAILED: ${error.message}`);
                    return { success: false, type: task.type, segmentIndex: task.segmentIndex, error: error.message };
                }
            };

            // Process overlays in parallel batches
            for (let batchStart = 0; batchStart < overlayTasks.length; batchStart += PARALLEL_OVERLAY_LIMIT) {
                const batchEnd = Math.min(batchStart + PARALLEL_OVERLAY_LIMIT, overlayTasks.length);
                const batch = overlayTasks.slice(batchStart, batchEnd);
                const batchNum = Math.floor(batchStart / PARALLEL_OVERLAY_LIMIT) + 1;
                const totalBatches = Math.ceil(overlayTasks.length / PARALLEL_OVERLAY_LIMIT);

                editorLog(`[OVERLAY] Processing batch ${batchNum}/${totalBatches} (${batch.length} overlays in parallel)`);

                // Reset display task for new batch
                currentDisplayTask = batch[0]; // First task in batch controls UI

                // Send batch start progress to UI
                const batchStartPercent = Math.round((completedCount / totalOverlays) * 100);
                onProgress({
                    stage: 'generating_overlays',
                    percent: batchStartPercent,
                    totalOverlays,
                    currentOverlay: completedCount + 1,
                    overlayType: batch[0].type,
                    overlayText: batch[0].text.substring(0, 50) + (batch[0].text.length > 50 ? '...' : ''),
                    segmentIndex: batch[0].segmentIndex + 1,
                    totalSegments: sortedClips.length,
                    renderProgress: 0
                });

                // Execute batch in parallel
                const batchPromises = batch.map((task, idx) =>
                    renderOverlayTask(task, batchStart + idx)
                );

                const batchResults = await Promise.all(batchPromises);

                // Collect results and update completed count
                for (const result of batchResults) {
                    results.push(result);
                    if (result.success) {
                        completedCount++;
                    }
                }

                // Send batch complete progress
                const batchEndPercent = Math.round((completedCount / totalOverlays) * 100);
                onProgress({
                    stage: 'generating_overlays',
                    percent: batchEndPercent,
                    totalOverlays,
                    currentOverlay: completedCount,
                    overlayType: batch[batch.length - 1].type,
                    overlayText: `Batch ${batchNum}/${totalBatches} complete`,
                    renderProgress: 100
                });

                editorLog(`[OVERLAY] Batch ${batchNum}/${totalBatches} complete. Total completed: ${completedCount}/${totalOverlays}`);
            }

            // Step 4: Collect results and sort into correct arrays
            for (const result of results) {
                if (result && result.success && result.path) {
                    const overlayData = {
                        path: result.path,
                        startTime: result.startTime,
                        endTime: result.endTime
                    };

                    if (result.type === 'mandatory_credit') {
                        mandatoryCreditOverlays.push(overlayData);
                    } else if (result.type === 'lower_third') {
                        lowerThirdOverlays.push(overlayData);
                    }
                }
            }

            // Sort overlays by startTime to ensure correct order
            mandatoryCreditOverlays.sort((a, b) => a.startTime - b.startTime);
            lowerThirdOverlays.sort((a, b) => a.startTime - b.startTime);

            const overlayElapsed = ((Date.now() - overlayStartTime) / 1000).toFixed(2);
            const successCount = mandatoryCreditOverlays.length + lowerThirdOverlays.length;
            const failedCount = totalOverlays - successCount;

            exportLog(`Generated ${mandatoryCreditOverlays.length} mandatory credits, ${lowerThirdOverlays.length} lower thirds in ${overlayElapsed}s (${failedCount} failed)`);

            ExportLogger.endPhase('OVERLAYS');
            ExportLogger.info('OVERLAYS', `Generated ${successCount}/${totalOverlays} overlays in ${overlayElapsed}s`);

            // Log overlay timing details
            timelineLog('========== OVERLAY TIMING SUMMARY ==========');
            mandatoryCreditOverlays.forEach((mc, i) => {
                timelineLog(`MandatoryCredit ${i}: ${mc.startTime.toFixed(2)}s - ${mc.endTime.toFixed(2)}s`);
                ExportLogger.logOverlay('MandatoryCredit', i + 1, mandatoryCreditOverlays.length, `${mc.startTime.toFixed(2)}s - ${mc.endTime.toFixed(2)}s`);
            });
            lowerThirdOverlays.forEach((lt, i) => {
                timelineLog(`LowerThird ${i}: ${lt.startTime.toFixed(2)}s - ${lt.endTime.toFixed(2)}s`);
                ExportLogger.logOverlay('LowerThird', i + 1, lowerThirdOverlays.length, `${lt.startTime.toFixed(2)}s - ${lt.endTime.toFixed(2)}s`);
            });

            onProgress({
                stage: 'generating_overlays',
                percent: 100,
                totalOverlays,
                currentOverlay: totalOverlays,
                overlayType: 'complete',
                overlayText: `${successCount} overlays generated`,
                renderProgress: 100
            });
        }
        // ============ END OVERLAYS GENERATION ============

        ExportLogger.startPhase('FFMPEG_ENCODE');
        exportLog('========== STARTING FFMPEG ENCODE ==========');

        return new Promise((resolve, reject) => {
            let command = ffmpeg()
                .input(listPath)
                .inputOptions(['-f', 'concat', '-safe', '0']);

            // Store reference for cancellation
            this.currentExportCommand = command;

            // Check for logo (getLogoPath returns a safe path without spaces)
            const logoPath = this.getLogoPath();
            const hasLogo = !!logoPath;

            console.log(`[Editor] Export - Logo available: ${hasLogo}${hasLogo ? ` at ${logoPath}` : ''}`);

            // Track input indices for proper mapping
            let nextInputIndex = 1; // 0 is the video concat

            // Add narration audio if exists
            let narrationInputIndex = -1;
            if (this.narrationAudio) {
                command.input(this.narrationAudio.path);
                narrationInputIndex = nextInputIndex;
                nextInputIndex++;
            }

            // Add background music if exists (with infinite loop)
            let musicInputIndex = -1;
            audioLog('========== ADDING BACKGROUND MUSIC TO FFMPEG ==========');
            const backgroundMusicPath = this.getBackgroundMusicPath();
            audioLog(`getBackgroundMusicPath() returned: ${backgroundMusicPath || 'NULL'}`);

            if (backgroundMusicPath) {
                // Verify file exists and has content before adding
                if (fs.existsSync(backgroundMusicPath)) {
                    const musicStats = fs.statSync(backgroundMusicPath);
                    audioLog(`Music file verified: ${musicStats.size} bytes`);

                    // IMPORTANT: For -stream_loop to work, it must be an inputOption
                    // fluent-ffmpeg applies inputOptions to the LAST added input
                    command
                        .input(backgroundMusicPath)
                        .inputOptions(['-stream_loop', '-1']); // Infinite loop - MUST come after .input()
                    musicInputIndex = nextInputIndex;
                    nextInputIndex++;

                    audioLog(`Music added as FFmpeg input #${musicInputIndex}`);
                    audioLog(`Input options: -stream_loop -1`);
                    editorLog(`Background music added as input ${musicInputIndex}: ${backgroundMusicPath}`);
                } else {
                    audioLog(`ERROR: Music file does not exist at: ${backgroundMusicPath}`);
                }
            } else {
                audioLog('WARNING: No background music path available');
            }

            // Audio input index (for backward compatibility)
            let audioInputIndex = narrationInputIndex;

            // Add lower third video files as separate inputs for alpha support
            // MOV (ProRes 4444) and WebM files have alpha channel
            const lowerThirdInputIndices = [];
            for (const lt of lowerThirdOverlays) {
                const ext = lt.path.toLowerCase();
                const isVideo = ext.endsWith('.webm') || ext.endsWith('.mov') || ext.endsWith('.mp4');
                if (isVideo) {
                    // Add video with appropriate decoder
                    // ProRes and MOV files work natively with FFmpeg alpha
                    command.input(lt.path);
                    lowerThirdInputIndices.push({ index: nextInputIndex, ...lt });
                    nextInputIndex++;
                } else {
                    // PNG files use movie filter
                    lowerThirdInputIndices.push({ index: -1, ...lt }); // -1 = use movie filter
                }
            }

            console.log(`[Editor] Lower thirds: ${lowerThirdOverlays.length} overlays (${lowerThirdInputIndices.filter(x => x.index >= 0).length} as inputs)`);

            // Add mandatory credit video files as separate inputs for alpha support
            const mandatoryCreditInputIndices = [];
            for (const mc of mandatoryCreditOverlays) {
                const ext = mc.path.toLowerCase();
                const isVideo = ext.endsWith('.webm') || ext.endsWith('.mov') || ext.endsWith('.mp4');
                if (isVideo) {
                    command.input(mc.path);
                    mandatoryCreditInputIndices.push({ index: nextInputIndex, ...mc });
                    nextInputIndex++;
                } else {
                    // PNG files use movie filter
                    mandatoryCreditInputIndices.push({ index: -1, ...mc }); // -1 = use movie filter
                }
            }

            console.log(`[Editor] Mandatory credits: ${mandatoryCreditOverlays.length} overlays (${mandatoryCreditInputIndices.filter(x => x.index >= 0).length} as inputs)`);

            // Video filter with logo overlay using movie= (logo path is now safe)
            // Scale logo to appropriate size (100px height for 1080p, proportionally scaled for other resolutions)
            const logoHeight = Math.round(height * 0.093); // ~100px for 1080p
            const logoPadding = Math.round(height * 0.019); // ~20px padding for 1080p

            // Build filter_complex with logo and lower thirds
            let filterParts = [];
            let currentOutput = 'scaled';

            // Step 1: Scale input video
            filterParts.push(`[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[scaled]`);

            // Step 1.5: Add vignette effect (subtle darkening at edges, appears BEHIND all overlays)
            // Split video, apply vignette to one, blend at reduced opacity for subtle effect
            // OPTIMIZED: Reduced from 0.15 to 0.10 for softer vignette
            // ORIGINAL: all_opacity=0.15
            filterParts.push(`[scaled]split[vig_base][vig_src]`);
            filterParts.push(`[vig_src]vignette=angle=PI/4[vig_dark]`);
            filterParts.push(`[vig_base][vig_dark]blend=all_mode=normal:all_opacity=0.10[vignetted]`);
            currentOutput = 'vignetted';

            // Step 2: Apply logo (if exists)
            if (hasLogo) {
                const ffmpegLogoPath = logoPath.replace(/\\/g, '/').replace(/:/g, '\\:');
                console.log('[Editor] FFmpeg logo path:', ffmpegLogoPath);

                // Use format=rgba to preserve PNG colors correctly (fixes orange tint issue)
                // The colorspace issue happens because FFmpeg assumes rec601 for PNG, but PNG is sRGB
                filterParts.push(`movie='${ffmpegLogoPath}',format=rgba,scale=-1:${logoHeight}[logo]`);
                filterParts.push(`[${currentOutput}][logo]overlay=W-w-${logoPadding}:${logoPadding}:format=auto[withlogo]`);
                currentOutput = 'withlogo';
            }

            // Step 3: Apply mandatory credit overlays (top-left corner)
            // MOV (ProRes 4444) files have alpha channel
            if (mandatoryCreditInputIndices.length > 0) {
                console.log(`[Editor] Adding ${mandatoryCreditInputIndices.length} mandatory credit overlays`);

                for (let i = 0; i < mandatoryCreditInputIndices.length; i++) {
                    const mc = mandatoryCreditInputIndices[i];
                    const outputLabel = `mc${i}`;

                    const isPNG = mc.path.toLowerCase().endsWith('.png');
                    const startOffset = mc.startTime.toFixed(2);
                    const endOffset = mc.endTime.toFixed(2);

                    if (isPNG) {
                        // PNG image overlay (static from Canvas fallback) - use movie filter
                        const ffmpegPath = mc.path.replace(/\\/g, '/').replace(/:/g, '\\:');
                        filterParts.push(`movie='${ffmpegPath}',format=rgba[mc${i}img]`);
                        filterParts.push(
                            `[${currentOutput}][mc${i}img]overlay=0:0:format=auto:enable='between(t,${startOffset},${endOffset})'[${outputLabel}]`
                        );
                    } else if (mc.index >= 0) {
                        // Video overlay (MOV) - use input stream for alpha support
                        filterParts.push(
                            `[${mc.index}:v]setpts=PTS-STARTPTS+${startOffset}/TB[mc${i}vid]`
                        );
                        filterParts.push(
                            `[${currentOutput}][mc${i}vid]overlay=0:0:format=auto:eof_action=repeat:enable='between(t,${startOffset},${endOffset})'[${outputLabel}]`
                        );
                    } else {
                        // Fallback for other formats - use movie filter
                        editorLog(`WARNING: Unknown mandatory credit format: ${mc.path}`);
                        const ffmpegPath = mc.path.replace(/\\/g, '/').replace(/:/g, '\\:');
                        filterParts.push(`movie='${ffmpegPath}',setpts=PTS-STARTPTS+${startOffset}/TB[mc${i}vid]`);
                        filterParts.push(
                            `[${currentOutput}][mc${i}vid]overlay=0:0:format=auto:enable='between(t,${startOffset},${endOffset})'[${outputLabel}]`
                        );
                    }
                    currentOutput = outputLabel;
                }
            }

            // Step 4: Apply lower third overlays (PNG images or WebM videos with alpha)
            // WebM files are added as separate inputs with libvpx decoder for proper alpha support
            if (lowerThirdInputIndices.length > 0) {
                console.log(`[Editor] Adding ${lowerThirdInputIndices.length} lower third overlays`);

                for (let i = 0; i < lowerThirdInputIndices.length; i++) {
                    const lt = lowerThirdInputIndices[i];
                    const outputLabel = `lt${i}`;

                    const isPNG = lt.path.toLowerCase().endsWith('.png');
                    const isWebM = lt.path.toLowerCase().endsWith('.webm');
                    const startOffset = lt.startTime.toFixed(2);
                    const endOffset = lt.endTime.toFixed(2);

                    if (isPNG) {
                        // PNG image overlay (static from Canvas fallback) - use movie filter
                        const ffmpegPath = lt.path.replace(/\\/g, '/').replace(/:/g, '\\:');
                        filterParts.push(`movie='${ffmpegPath}',format=rgba[lt${i}img]`);
                        filterParts.push(
                            `[${currentOutput}][lt${i}img]overlay=0:0:format=auto:enable='between(t,${startOffset},${endOffset})'[${outputLabel}]`
                        );
                    } else if (lt.index >= 0) {
                        // Video overlay (MOV/WebM) - use input stream for alpha support
                        // ProRes 4444 and WebM with alpha are handled natively by FFmpeg
                        // Uses SAME logic as Mandatory Credits which works correctly
                        filterParts.push(
                            `[${lt.index}:v]setpts=PTS-STARTPTS+${startOffset}/TB[lt${i}vid]`
                        );
                        // eof_action=repeat: when overlay video ends, repeat last frame
                        // format=auto lets FFmpeg auto-detect the best format for alpha blending
                        filterParts.push(
                            `[${currentOutput}][lt${i}vid]overlay=0:0:format=auto:eof_action=repeat:enable='between(t,${startOffset},${endOffset})'[${outputLabel}]`
                        );
                    } else {
                        // Fallback for other formats - use movie filter
                        editorLog(`WARNING: Unknown lower third format: ${lt.path}`);
                        const ffmpegPath = lt.path.replace(/\\/g, '/').replace(/:/g, '\\:');
                        filterParts.push(`movie='${ffmpegPath}',setpts=PTS-STARTPTS+${startOffset}/TB[lt${i}vid]`);
                        filterParts.push(
                            `[${currentOutput}][lt${i}vid]overlay=0:0:format=auto:enable='between(t,${startOffset},${endOffset})'[${outputLabel}]`
                        );
                    }
                    currentOutput = outputLabel;
                }
            }

            // Ensure final output is named [out]
            if (currentOutput !== 'out') {
                // If we only have scaled video (no logo, no lower thirds), modify the first filter
                if (currentOutput === 'scaled' && filterParts.length === 1) {
                    filterParts[0] = `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1[out]`;
                } else {
                    // Copy stream with null filter to create [out] label
                    filterParts.push(`[${currentOutput}]null[out]`);
                }
            }

            const filterComplex = filterParts.join(';');

            // Prepare output options (YouTube optimized)
            const outputOptions = [
                `-filter_complex`, filterComplex,
                `-map`, `[out]`,     // Map filtered video output
                `-c:v`, vCodec,
                `-r`, `${fps}`,      // Force Frame Rate
                `-c:a`, 'aac',
                `-b:a`, '320k',      // High quality audio (YouTube recommended)
                `-ar`, '48000',      // 48kHz sample rate (YouTube standard)
                `-movflags`, '+faststart'  // Fast web playback start
            ];

            // Audio Mapping Logic
            audioLog('========== AUDIO MIXING CONFIGURATION ==========');
            audioLog(`Narration input index: ${narrationInputIndex}`);
            audioLog(`Music input index: ${musicInputIndex}`);
            editorLog(`Audio mapping - narrationIdx: ${narrationInputIndex}, musicIdx: ${musicInputIndex}`);

            if (narrationInputIndex >= 0 && musicInputIndex >= 0) {
                // Both narration and music - use amix with normalize=0 to preserve volumes
                audioLog('MODE: Narration + Music (both available)');
                const currentFilterIdx = outputOptions.indexOf('-filter_complex');
                let currentFilter = outputOptions[currentFilterIdx + 1];

                // Use amix with normalize=0 to prevent volume reduction
                // This mixes both audio streams at their original levels
                const audioFilter = `[${narrationInputIndex}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[narr];[${musicInputIndex}:a]aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[bgm];[narr][bgm]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]`;

                audioLog(`Audio filter: ${audioFilter}`);

                outputOptions[currentFilterIdx + 1] = currentFilter + ';' + audioFilter;
                outputOptions.push('-map', '[aout]');
                outputOptions.push('-shortest');

                audioLog('Output mapping: -map [aout] -shortest');
                audioLog(`Full filter_complex length: ${outputOptions[currentFilterIdx + 1].length} chars`);
                editorLog(`Audio: narration(${narrationInputIndex}) + music(${musicInputIndex}) mixed with amerge+pan`);
            } else if (narrationInputIndex >= 0) {
                // Only narration - exactly as before
                audioLog('MODE: Narration only (no music)');
                outputOptions.push('-map', `${narrationInputIndex}:a`);
                outputOptions.push('-shortest');
                editorLog(`Audio: narration only`);
            } else if (musicInputIndex >= 0) {
                // Only music (no narration) - use original volume
                audioLog('MODE: Music only (no narration)');
                const currentFilterIdx = outputOptions.indexOf('-filter_complex');
                let currentFilter = outputOptions[currentFilterIdx + 1];

                const audioFilter = `[${musicInputIndex}:a]volume=1.0[aout]`;
                audioLog(`Audio filter: ${audioFilter}`);

                outputOptions[currentFilterIdx + 1] = currentFilter + ';' + audioFilter;
                outputOptions.push('-map', '[aout]');
                outputOptions.push('-shortest');
                editorLog(`Audio: music only at original volume`);
            } else {
                audioLog('MODE: No audio sources available!');
                outputOptions.push('-map', '0:a?'); // Optional audio from video (if present)
            }

            audioLog('========== END AUDIO CONFIG ==========')


            // Use target bitrate for consistent YouTube-optimized output
            // This ensures predictable file sizes and quality
            const bufferSize = `${videoBitrateKbps * 2}k`; // 2x bitrate buffer

            // Use all available CPU threads for faster encoding
            outputOptions.push('-threads', '0');

            if (vCodec === 'libx264' || vCodec === 'libx265') {
                // CPU Software Encoding with 2-pass style quality via maxrate/bufsize
                outputOptions.push('-preset', 'medium');
                outputOptions.push('-b:v', videoBitrate);
                outputOptions.push('-maxrate', videoBitrate);
                outputOptions.push('-bufsize', bufferSize);
            } else {
                // Hardware Encoding (NVENC/QSV/AMF) - use bitrate mode
                outputOptions.push('-b:v', videoBitrate);
                outputOptions.push('-maxrate', videoBitrate);
                outputOptions.push('-bufsize', bufferSize);

                if (vCodec.includes('nvenc')) {
                    // NVIDIA NVENC optimized settings
                    outputOptions.push('-rc', 'vbr');
                    outputOptions.push('-preset', 'p5');  // Faster than p4, same quality with VBR
                    outputOptions.push('-tune', 'hq');    // High quality tuning
                    outputOptions.push('-rc-lookahead', '20'); // Lookahead for better quality
                } else if (vCodec.includes('qsv')) {
                    // Intel Quick Sync optimized settings
                    outputOptions.push('-preset', 'medium');
                    outputOptions.push('-async_depth', '4'); // Async encoding for better throughput
                } else if (vCodec.includes('amf')) {
                    // AMD AMF optimized settings
                    outputOptions.push('-quality', 'balanced');
                    outputOptions.push('-rc', 'vbr_latency'); // VBR with low latency
                }
            }

            // Track encoding stats for logging
            let lastLoggedPercent = 0;
            let encodingStartTime = null;
            const totalDuration = this.timeline.reduce((acc, clip) => acc + (clip.duration || 0), 0);

            command
                .outputOptions(outputOptions)

                .on('start', (commandLine) => {
                    encodingStartTime = Date.now();
                    console.log('[Editor] FFmpeg command:', commandLine);
                    editorLog(`FFmpeg command: ${commandLine}`);
                    ExportLogger.logFFmpegCommand(commandLine);
                    ExportLogger.info('FFMPEG', `Starting encode. Total duration: ${totalDuration.toFixed(2)}s`);
                    audioLog('========== FFMPEG COMMAND ==========');
                    audioLog(commandLine);
                    audioLog('=====================================');
                })
                .on('progress', (progress) => {
                    // Calculate manual percentage because FFmpeg concat often reports > 100% or wrong values
                    let percent = 0;
                    let currentSeconds = 0;
                    if (progress.timemark) {
                        const parts = progress.timemark.split(':');
                        currentSeconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);

                        if (totalDuration > 0) {
                            percent = (currentSeconds / totalDuration) * 100;
                        }
                    } else if (progress.percent) {
                        percent = progress.percent;
                    }

                    // Clamp
                    percent = Math.min(Math.max(percent, 0), 99);
                    const roundedPercent = Math.round(percent);

                    // Calculate ETA
                    let eta = 'calculating...';
                    if (encodingStartTime && currentSeconds > 0 && percent > 0) {
                        const elapsed = (Date.now() - encodingStartTime) / 1000;
                        const estimatedTotal = elapsed / (percent / 100);
                        const remaining = Math.max(0, estimatedTotal - elapsed);
                        if (remaining < 60) {
                            eta = `${Math.round(remaining)}s`;
                        } else {
                            eta = `${Math.floor(remaining / 60)}m ${Math.round(remaining % 60)}s`;
                        }
                    }

                    // Log every 10% progress
                    if (roundedPercent >= lastLoggedPercent + 10) {
                        lastLoggedPercent = Math.floor(roundedPercent / 10) * 10;
                        ExportLogger.progress(lastLoggedPercent, progress.currentFps, null, eta);
                    }

                    onProgress({
                        stage: 'encoding',
                        percent: percent,
                        fps: progress.currentFps,
                        time: progress.timemark,
                        eta: eta
                    });
                })
                .on('end', () => {
                    this.currentExportCommand = null;
                    ExportLogger.endPhase('FFMPEG_ENCODE');

                    if (!this.exportCancelled) {
                        ExportLogger.logFile('Final Output', finalPath);
                        const summary = ExportLogger.endSession(true, finalPath);
                        onProgress({
                            stage: 'complete',
                            percent: 100,
                            outputPath: finalPath,
                            exportSummary: summary
                        });
                        resolve(finalPath);
                    }
                })
                .on('error', (err) => {
                    this.currentExportCommand = null;
                    ExportLogger.error('FFMPEG', `Encoding failed: ${err.message}`, err);
                    ExportLogger.endPhase('FFMPEG_ENCODE', false);

                    if (this.exportCancelled) {
                        // User cancelled - not an error
                        ExportLogger.info('SESSION', 'Export cancelled by user');
                        ExportLogger.endSession(false);
                        onProgress({ stage: 'cancelled', percent: 0 });
                        resolve(null);
                    } else {
                        ExportLogger.endSession(false);
                        onProgress({ stage: 'error', error: err.message });
                        reject(err);
                    }
                })
                .save(finalPath);
        });
    }

    async getMediaDuration(filePath) {
        return new Promise((resolve, reject) => {
            ffmpeg.ffprobe(filePath, (err, metadata) => {
                if (err) reject(err);
                else resolve(metadata.format.duration);
            });
        });
    }

    /**
     * Merge multiple video files into one (for Short Video logic)
     */
    async mergeVideos(videoPaths, outputPath) {
        if (!videoPaths || videoPaths.length < 2) throw new Error('Need at least 2 videos to merge');

        console.log(`[Editor] Merging ${videoPaths.length} videos into ${outputPath}`);

        const listPath = path.join(this.tempDir, `merge_list_${Date.now()}.txt`);
        const listContent = videoPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(listPath, listContent);

        return new Promise((resolve, reject) => {
            ffmpeg()
                .input(listPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions([
                    '-c', 'copy', // Stream copy for speed (assuming same format)
                    '-movflags', '+faststart'
                ])
                .on('end', () => resolve(outputPath))
                .on('error', (err) => {
                    // Fallback: Re-encode if copy fails
                    console.warn('[Editor] Stream copy failed, re-encoding...', err.message);
                    this.mergeVideosRecomp(videoPaths, outputPath).then(resolve).catch(reject);
                })
                .save(outputPath);
        });
    }

    // Fallback merge with re-encoding
    async mergeVideosRecomp(videoPaths, outputPath) {
        const listPath = path.join(this.tempDir, `merge_recomp_${Date.now()}.txt`);
        const listContent = videoPaths.map(p => `file '${p.replace(/\\/g, '/')}'`).join('\n');
        fs.writeFileSync(listPath, listContent);

        return new Promise((resolve, reject) => {
            ffmpeg()
                .input(listPath)
                .inputOptions(['-f', 'concat', '-safe', '0'])
                .outputOptions([
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-crf', '28'
                ])
                .on('end', () => resolve(outputPath))
                .on('error', reject)
                .save(outputPath);
        });
    }
}

export default new VideoEditorEngine();
