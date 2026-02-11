// segmentVideoRenderer.js - Renders complete segment with overlays
// Creates a single video file per segment with everything baked in

import path from 'path';
import fs from 'fs';
import os from 'os';
import { pathToFileURL, fileURLToPath } from 'url';
import ffmpeg from 'fluent-ffmpeg';
import { execSync } from 'child_process';

const LOG_DIR = path.join(os.homedir(), 'ClickStudio', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'segment-video-renderer.log');

// Ensure log directory exists
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) { /* ignore */ }

function logInfo(msg) {
    const line = `[${new Date().toISOString()}] [INFO] ${msg}\n`;
    console.log(`[SegmentVideoRenderer] ${msg}`);
    try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

function logError(msg, error = null) {
    const line = `[${new Date().toISOString()}] [ERROR] ${msg}\n`;
    console.error(`[SegmentVideoRenderer] ERROR: ${msg}`);
    try {
        fs.appendFileSync(LOG_FILE, line);
        if (error?.stack) fs.appendFileSync(LOG_FILE, `    Stack: ${error.stack}\n`);
    } catch (e) {}
}

// Cache detected encoder and GPU type to avoid repeated ffmpeg calls
let cachedEncoder = null;
let cachedGPUType = null;

/**
 * Get hardware encoder (cached)
 */
function getHardwareEncoder() {
    if (cachedEncoder) return cachedEncoder;
    try {
        const result = execSync('ffmpeg -encoders 2>&1', { encoding: 'utf8' });
        if (result.includes('h264_nvenc')) { cachedGPUType = 'NVIDIA'; cachedEncoder = 'h264_nvenc'; }
        else if (result.includes('h264_videotoolbox')) { cachedGPUType = 'Apple'; cachedEncoder = 'h264_videotoolbox'; }
        else if (result.includes('h264_qsv')) { cachedGPUType = 'Intel'; cachedEncoder = 'h264_qsv'; }
        else if (result.includes('h264_amf')) { cachedGPUType = 'AMD'; cachedEncoder = 'h264_amf'; }
        else { cachedGPUType = 'CPU'; cachedEncoder = 'libx264'; }
    } catch (e) {
        cachedGPUType = 'CPU';
        cachedEncoder = 'libx264';
    }
    logInfo(`Detected GPU: ${cachedGPUType}, Encoder: ${cachedEncoder}`);
    return cachedEncoder;
}

/**
 * Get hwaccel input options for hardware-accelerated decoding
 */
function getHwaccelInputOptions() {
    if (!cachedGPUType) getHardwareEncoder(); // ensure detection ran
    
    if (cachedGPUType === 'NVIDIA') return ['-hwaccel', 'cuda'];
    if (cachedGPUType === 'Apple') return ['-hwaccel', 'videotoolbox'];
    if (cachedGPUType === 'Intel') return ['-hwaccel', 'qsv'];
    if (cachedGPUType === 'AMD' && process.platform === 'win32') return ['-hwaccel', 'd3d11va'];
    return [];
}

/**
 * Get encoder-specific output options
 */
function getEncoderOutputOptions(encoder) {
    const opts = [];
    if (encoder.includes('nvenc')) {
        opts.push('-rc', 'vbr', '-cq', '23', '-preset', 'p2');
    } else if (encoder.includes('videotoolbox')) {
        opts.push('-realtime', '1', '-allow_sw', '0');
    } else if (encoder.includes('qsv')) {
        opts.push('-preset', 'faster', '-async_depth', '4');
    } else if (encoder.includes('amf')) {
        opts.push('-quality', 'speed', '-rc', 'vbr_latency');
    } else {
        opts.push('-preset', 'fast', '-crf', '23');
    }
    return opts;
}

/**
 * Render complete segment with overlays
 * This creates a single MP4 file with video + overlays + audio
 */
export async function renderSegmentVideo({
    segmentIndex,
    videoPath,
    lowerThirdPath = null,
    mandatoryCreditPath = null,
    duration,
    outputPath,
    onProgress = () => {}
}) {
    logInfo(`Starting segment ${segmentIndex} render`);
    logInfo(`  Video: ${videoPath}`);
    logInfo(`  Lower Third: ${lowerThirdPath || 'none'}`);
    logInfo(`  Credit: ${mandatoryCreditPath || 'none'}`);
    logInfo(`  Duration: ${duration}s`);
    logInfo(`  Output: ${outputPath}`);

    return new Promise((resolve, reject) => {
        // Convert file URL to file path if needed
        let videoFilePath = videoPath;
        if (videoPath.startsWith('file://')) {
            try {
                videoFilePath = fileURLToPath(videoPath);
                logInfo(`Converted file URL to path: ${videoFilePath}`);
            } catch (e) {
                logError(`Failed to convert file URL: ${videoPath}`, e);
            }
        }
        
        // Also convert overlay paths
        let ltFilePath = lowerThirdPath;
        if (lowerThirdPath && lowerThirdPath.startsWith('file://')) {
            try {
                ltFilePath = fileURLToPath(lowerThirdPath);
            } catch (e) {
                logError(`Failed to convert lower third URL: ${lowerThirdPath}`, e);
            }
        }
        
        let mcFilePath = mandatoryCreditPath;
        if (mandatoryCreditPath && mandatoryCreditPath.startsWith('file://')) {
            try {
                mcFilePath = fileURLToPath(mandatoryCreditPath);
            } catch (e) {
                logError(`Failed to convert credit URL: ${mandatoryCreditPath}`, e);
            }
        }
        
        // Verify input video exists
        if (!fs.existsSync(videoFilePath)) {
            reject(new Error(`Video not found: ${videoFilePath}`));
            return;
        }

        // Build ffmpeg command with hardware-accelerated decoding
        let command = ffmpeg(videoFilePath);
        
        // Add hwaccel input options for faster decoding
        const hwaccelOpts = getHwaccelInputOptions();
        if (hwaccelOpts.length > 0) {
            for (let i = 0; i < hwaccelOpts.length; i += 2) {
                command.inputOption(hwaccelOpts[i], hwaccelOpts[i + 1]);
            }
            logInfo(`Using HW-accelerated decoding: ${hwaccelOpts.join(' ')}`);
        }

        // Add overlay inputs if they exist
        const overlayInputs = [];
        
        if (ltFilePath && fs.existsSync(ltFilePath)) {
            command = command.input(ltFilePath);
            overlayInputs.push({ type: 'lowerThird', index: 1 });
        }
        
        if (mcFilePath && fs.existsSync(mcFilePath)) {
            command = command.input(mcFilePath);
            overlayInputs.push({ type: 'credit', index: overlayInputs.length + 1 });
        }

        // Build filter complex
        // CRITICAL: Apply vignette FIRST (before overlays), so overlays appear ON TOP of vignette
        let filterComplex = '';
        let currentInput = '0:v';
        
        // Step 1: Apply vignette to base video (bottom layer)
        // Split video, apply vignette to one copy, blend at reduced opacity
        filterComplex += `[${currentInput}]split[vig_base][vig_src];`;
        filterComplex += `[vig_src]vignette=angle=PI/4[vig_dark];`;
        filterComplex += `[vig_base][vig_dark]blend=all_mode=normal:all_opacity=0.10[vignetted];`;
        currentInput = 'vignetted';
        
        logInfo('Applied vignette effect (bottom layer)');

        // Step 2: Apply overlays on top of vignetted video
        overlayInputs.forEach((overlay, idx) => {
            const outputLabel = `overlay${idx}`;
            
            if (overlay.type === 'lowerThird') {
                // Lower third at bottom (on top of vignette)
                filterComplex += `[${currentInput}][${overlay.index}:v]overlay=0:H-h:format=auto[${outputLabel}];`;
            } else if (overlay.type === 'credit') {
                // Credit at top-left (on top of vignette)
                filterComplex += `[${currentInput}][${overlay.index}:v]overlay=0:0:format=auto[${outputLabel}];`;
            }
            
            currentInput = outputLabel;
        });

        // Remove trailing semicolon
        if (filterComplex.endsWith(';')) {
            filterComplex = filterComplex.slice(0, -1);
        }

        logInfo(`Filter complex: ${filterComplex || '(none)'}`);

        // Get encoder
        const encoder = getHardwareEncoder();
        logInfo(`Using encoder: ${encoder}`);

        // Apply filter complex if we have overlays
        if (filterComplex) {
            command = command.complexFilter(filterComplex, currentInput);
        }

        // Set output options with encoder-specific optimization
        const encoderOpts = getEncoderOutputOptions(encoder);
        const outputOptions = [
            '-c:v', encoder,
            ...encoderOpts,
            '-pix_fmt', 'yuv420p',
            '-c:a', 'copy', // Copy audio as-is
            '-movflags', '+faststart',
            '-threads', '0',  // Use all CPU threads
            '-t', duration.toString() // Limit to segment duration
        ];

        command
            .outputOptions(outputOptions)
            .on('start', (cmd) => {
                logInfo(`FFmpeg command: ${cmd.substring(0, 200)}...`);
                onProgress({ stage: 'rendering', percent: 0 });
            })
            .on('progress', (progress) => {
                const percent = Math.round(progress.percent || 0);
                onProgress({ stage: 'rendering', percent });
            })
            .on('end', () => {
                logInfo(`Segment ${segmentIndex} render complete: ${outputPath}`);
                
                // Verify output exists
                if (fs.existsSync(outputPath)) {
                    const stats = fs.statSync(outputPath);
                    logInfo(`Output file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                    resolve(outputPath);
                } else {
                    reject(new Error('Output file not created'));
                }
            })
            .on('error', (err) => {
                logError(`Segment ${segmentIndex} render failed`, err);
                reject(err);
            })
            .save(outputPath);
    });
}

/**
 * Check if segment video is already rendered and up to date
 */
export function isSegmentRendered(outputPath, sourceVideoPath) {
    if (!fs.existsSync(outputPath)) {
        return false;
    }
    
    // Check if source video is newer than rendered output
    try {
        const outputStat = fs.statSync(outputPath);
        const sourceStat = fs.statSync(sourceVideoPath);
        
        // If source is newer, need to re-render
        if (sourceStat.mtime > outputStat.mtime) {
            logInfo(`Source video newer than rendered output, re-render needed`);
            return false;
        }
        
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Get cache path for segment video
 */
export function getSegmentCachePath(segmentIndex, videoHash) {
    const cacheDir = path.join(os.homedir(), 'ClickStudio', 'Temp', 'segment-videos');
    
    if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    return path.join(cacheDir, `segment_${segmentIndex}_${videoHash}.mp4`);
}

export default {
    renderSegmentVideo,
    isSegmentRendered,
    getSegmentCachePath
};
