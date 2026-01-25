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

// Debug log file paths
const DEBUG_LOG_PATH = path.join(os.homedir(), 'ClickStudio', 'lowerthird-debug.log');
const AUDIO_LOG_PATH = path.join(os.homedir(), 'ClickStudio', 'audio-debug.log');

// Create log files immediately on module load
try {
    const dir = path.dirname(DEBUG_LOG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(DEBUG_LOG_PATH, `\n\n========== VideoEditor loaded at ${new Date().toISOString()} ==========\n`);
    fs.appendFileSync(AUDIO_LOG_PATH, `\n\n========== AUDIO DEBUG - ${new Date().toISOString()} ==========\n`);
} catch (e) {
    console.error('Failed to create debug log:', e);
}

// Helper for logging that goes to file
function editorLog(msg) {
    const logLine = `[${new Date().toISOString()}] [VideoEditor] ${msg}\n`;
    console.log(`[VideoEditor] ${msg}`);
    try {
        fs.appendFileSync(DEBUG_LOG_PATH, logLine);
    } catch (e) {
        console.error('Log write failed:', e);
    }
}

// Dedicated audio/music logging
function audioLog(msg) {
    const logLine = `[${new Date().toISOString()}] [AUDIO] ${msg}\n`;
    console.log(`[AUDIO] ${msg}`);
    try {
        fs.appendFileSync(AUDIO_LOG_PATH, logLine);
    } catch (e) {
        console.error('Audio log write failed:', e);
    }
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
        this.scanHardwareEncoders(); // Trigger async scan

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
     * Scan for available hardware encoders
     */
    scanHardwareEncoders() {
        ffmpeg.getAvailableEncoders((err, encoders) => {
            if (err) {
                console.error('[Editor] Failed to scan encoders:', err);
                return;
            }
            // Store keys of available encoders
            Object.keys(encoders).forEach(key => this.availableEncoders.add(key));

            console.log('[Editor] Encoder scan complete. HW Encoders found:',
                this.getBestEncoder('h264') !== 'libx264' ? 'YES' : 'NO',
                `(${this.getBestEncoder('h264')})`
            );
        });
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

            // Añadir o reemplazar en timeline
            const existingIndex = this.timeline.findIndex(c => c.index === segmentIndex);
            const clipData = {
                index: segmentIndex,
                originalVideo: videoPath,
                processedVideo: trimmedPath,
                previewUrl: `file://${trimmedPath}`, // Para Electron/React
                thumbnail: `file://${thumbnailPath}`,
                duration: clipDuration,
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
     * Recorta y prepara un clip individual
     */
    async trimAndPrepareClip(inputPath, outputPath, options) {
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
                const videoFilter = 'scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,setsar=1';

                // No logo here - use simple -vf filter (logo applied at export time)
                command.outputOptions([
                    '-vf', videoFilter,
                    '-c:v', 'libx264',
                    '-preset', 'ultrafast',
                    '-crf', '28',
                    '-pix_fmt', 'yuv420p',
                    '-avoid_negative_ts', 'make_zero'
                ]);
                console.log('[Editor] Using video filter (logo will be applied at export)');

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
     */
    async exportFinalVideo(options = {}, onProgress = () => { }) {
        // Handle case where options is strictly a callback (backward compatibility)
        if (typeof options === 'function') {
            onProgress = options;
            options = {};
        }

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

        // Map Codec
        // Use best detected hardware encoder
        const vCodec = this.getBestEncoder(codec); // codec is 'h264' or 'h265'

        // Determine Final Output Path
        // If filePath is provided (folder selected), use it. Otherwise default to outputDir
        const targetDir = filePath || this.outputDir;

        // Ensure not overwriting if name not unique? Date.now() handles it usually.
        // options.fileName comes from modal but might just be base name.
        const fileName = (options.fileName && options.fileName !== 'video_export')
            ? `${options.fileName}.${format}`
            : `${this.projectName}_FINAL_${Date.now()}.${format}`;

        const finalPath = path.join(targetDir, fileName);

        console.log(`[Editor] Starting final export: ${resolution} @ ${fps}fps, Codec: ${vCodec} (requested ${codec}), Bitrate: ${videoBitrate}`);
        console.log(`[Editor] Output Path: ${finalPath}`);

        onProgress({ stage: 'preparing', percent: 0 });

        const sortedClips = [...this.timeline].sort((a, b) => a.index - b.index);

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

        console.log('[Editor] Concat List Content Preview:\n', listContent.substring(0, 500) + '...');

        // Validate that we have clips to export
        if (!listContent || listContent.trim().length === 0) {
            const error = new Error('No video clips available for export. Please ensure videos have been downloaded for all segments.');
            onProgress({ stage: 'error', error: error.message });
            throw error;
        }

        fs.writeFileSync(listPath, listContent, 'utf8');

        // Reset cancellation state
        this.exportCancelled = false;

        // ============ OVERLAYS GENERATION (Lower Thirds + Mandatory Credits) ============
        // Fixed overlay duration for performance (5 seconds = 150 frames)
        // FFmpeg handles timing with enable='between(t,start,end)'
        const OVERLAY_DURATION_SECONDS = 5;

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
        if (enableMandatoryCredits && segments) {
            segmentsWithCredit = segments.filter(s => s.mandatoryCredit && s.mandatoryCredit.trim()).length;
            totalOverlays += segmentsWithCredit;
        }

        editorLog(`enableLowerThirds=${enableLowerThirds}, enableMandatoryCredits=${enableMandatoryCredits}`);
        editorLog(`Total overlays to generate: ${totalOverlays} (${segmentsWithHeadline} lower thirds, ${segmentsWithCredit} mandatory credits)`);

        if (totalOverlays > 0) {
            onProgress({
                stage: 'generating_overlays',
                percent: 0,
                totalOverlays,
                currentOverlay: 0,
                overlayType: 'preparing'
            });

            let overlaysGenerated = 0;
            let cumulativeTime = 0;

            for (let i = 0; i < sortedClips.length; i++) {
                const clip = sortedClips[i];
                const seg = segments[i];
                const clipDuration = clip.duration || 5;
                const headline = seg ? (seg.headline || seg.title) : null;
                const mandatoryCredit = seg ? seg.mandatoryCredit : null;

                // Generate MANDATORY CREDIT first (top-left corner)
                if (enableMandatoryCredits && mandatoryCredit && mandatoryCredit.trim()) {
                    editorLog(`Mandatory credit ${i + 1}: "${mandatoryCredit}"`);

                    onProgress({
                        stage: 'generating_overlays',
                        percent: Math.round((overlaysGenerated / totalOverlays) * 100),
                        totalOverlays,
                        currentOverlay: overlaysGenerated + 1,
                        overlayType: 'mandatory_credit',
                        overlayText: mandatoryCredit.substring(0, 40) + (mandatoryCredit.length > 40 ? '...' : ''),
                        segmentIndex: i + 1,
                        totalSegments: sortedClips.length
                    });

                    try {
                        const creditPath = await mandatoryCreditRenderer.renderMandatoryCredit({
                            text: mandatoryCredit,
                            durationInSeconds: OVERLAY_DURATION_SECONDS, // Fixed 5s duration
                            segmentId: i
                        });

                        if (creditPath) {
                            mandatoryCreditOverlays.push({
                                path: creditPath,
                                startTime: cumulativeTime,
                                endTime: cumulativeTime + clipDuration // Full segment duration for FFmpeg
                            });
                            editorLog(`✓ Mandatory credit: ${creditPath}`);
                        }
                        overlaysGenerated++;
                    } catch (error) {
                        editorLog(`ERROR mandatory credit ${i}: ${error.message}`);
                        overlaysGenerated++; // Still count as processed
                    }
                }

                // Generate LOWER THIRD (bottom center)
                if (enableLowerThirds && headline) {
                    editorLog(`Lower third ${i + 1}: "${headline}"`);

                    onProgress({
                        stage: 'generating_overlays',
                        percent: Math.round((overlaysGenerated / totalOverlays) * 100),
                        totalOverlays,
                        currentOverlay: overlaysGenerated + 1,
                        overlayType: 'lower_third',
                        overlayText: headline.substring(0, 40) + (headline.length > 40 ? '...' : ''),
                        segmentIndex: i + 1,
                        totalSegments: sortedClips.length
                    });

                    try {
                        const ltPath = await lowerThirdRenderer.renderLowerThird({
                            headline,
                            durationInSeconds: OVERLAY_DURATION_SECONDS, // Fixed 5s duration
                            segmentId: i
                        });

                        if (ltPath) {
                            lowerThirdOverlays.push({
                                path: ltPath,
                                startTime: cumulativeTime,
                                endTime: cumulativeTime + clipDuration // Full segment duration for FFmpeg
                            });
                            editorLog(`✓ Lower third: ${ltPath}`);
                        }
                        overlaysGenerated++;
                    } catch (error) {
                        editorLog(`ERROR lower third ${i}: ${error.message}`);
                        overlaysGenerated++; // Still count as processed
                    }
                }

                cumulativeTime += clipDuration;
            }

            editorLog(`Generated ${mandatoryCreditOverlays.length} mandatory credits, ${lowerThirdOverlays.length} lower thirds`);

            onProgress({
                stage: 'generating_overlays',
                percent: 100,
                totalOverlays,
                currentOverlay: totalOverlays,
                overlayType: 'complete'
            });
        }
        // ============ END OVERLAYS GENERATION ============

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

            if (vCodec === 'libx264' || vCodec === 'libx265') {
                // CPU Software Encoding with 2-pass style quality via maxrate/bufsize
                outputOptions.push(`-preset`, 'medium');
                outputOptions.push(`-b:v`, videoBitrate);
                outputOptions.push(`-maxrate`, videoBitrate);
                outputOptions.push(`-bufsize`, bufferSize);
            } else {
                // Hardware Encoding (NVENC/QSV/AMF) - use bitrate mode
                outputOptions.push(`-b:v`, videoBitrate);
                outputOptions.push(`-maxrate`, videoBitrate);
                outputOptions.push(`-bufsize`, bufferSize);

                if (vCodec.includes('nvenc')) {
                    outputOptions.push('-rc', 'vbr');
                    outputOptions.push('-preset', 'p4'); // Medium preset for NVENC
                } else if (vCodec.includes('qsv')) {
                    outputOptions.push('-preset', 'medium');
                } else if (vCodec.includes('amf')) {
                    outputOptions.push('-quality', 'balanced');
                }
            }

            command
                .outputOptions(outputOptions)

                .on('start', (commandLine) => {
                    console.log('[Editor] FFmpeg command:', commandLine);
                    editorLog(`FFmpeg command: ${commandLine}`);
                    audioLog('========== FFMPEG COMMAND ==========');
                    audioLog(commandLine);
                    audioLog('=====================================');
                })
                .on('progress', (progress) => {
                    // Calculate manual percentage because FFmpeg concat often reports > 100% or wrong values
                    let percent = 0;
                    if (progress.timemark) {
                        const parts = progress.timemark.split(':');
                        const seconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);

                        // Calculate total duration from timeline
                        const totalDuration = this.timeline.reduce((acc, clip) => acc + (clip.duration || 0), 0);

                        if (totalDuration > 0) {
                            percent = (seconds / totalDuration) * 100;
                        }
                    } else if (progress.percent) {
                        percent = progress.percent;
                    }

                    // Clamp
                    percent = Math.min(Math.max(percent, 0), 99);

                    onProgress({
                        stage: 'encoding',
                        percent: percent,
                        fps: progress.currentFps,
                        time: progress.timemark
                    });
                })
                .on('end', () => {
                    this.currentExportCommand = null;
                    if (!this.exportCancelled) {
                        onProgress({ stage: 'complete', percent: 100, outputPath: finalPath });
                        resolve(finalPath);
                    }
                })
                .on('error', (err) => {
                    this.currentExportCommand = null;
                    if (this.exportCancelled) {
                        // User cancelled - not an error
                        onProgress({ stage: 'cancelled', percent: 0 });
                        resolve(null);
                    } else {
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
