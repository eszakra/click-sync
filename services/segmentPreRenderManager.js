// segmentPreRenderManager.js - Pre-renders complete segments (video + overlays)
// This creates fully-rendered segment videos ready for fast export

import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { EventEmitter } from 'events';

const LOG_DIR = path.join(os.homedir(), 'ClickStudio', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'segment-prerender.log');

// Ensure log directory exists
try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) { /* ignore */ }

function logInfo(msg) {
    const line = `[${new Date().toISOString()}] [INFO] ${msg}\n`;
    console.log(`[SegmentPreRender] ${msg}`);
    try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
}

function logError(msg, error = null) {
    const line = `[${new Date().toISOString()}] [ERROR] ${msg}\n`;
    console.error(`[SegmentPreRender] ERROR: ${msg}`);
    try {
        fs.appendFileSync(LOG_FILE, line);
        if (error?.stack) fs.appendFileSync(LOG_FILE, `    Stack: ${error.stack}\n`);
    } catch (e) {}
}

/**
 * Generate hash for segment identification
 */
function getSegmentHash(videoPath, headline, credit, duration) {
    // FIX: Ensure duration is a number with consistent precision (1 decimal place)
    // This prevents hash mismatches between pre-render and export
    const normalizedDuration = typeof duration === 'number' ? duration.toFixed(1) : parseFloat(duration).toFixed(1);
    const data = `${videoPath}|${headline}|${credit}|${normalizedDuration}`;
    return crypto.createHash('md5').update(data).digest('hex').substring(0, 16);
}

/**
 * Segment State
 */
class SegmentState {
    constructor(segmentIndex, segmentData = {}) {
        this.segmentIndex = segmentIndex;
        
        // Content
        this.headline = segmentData.headline || segmentData.title || '';
        this.mandatoryCredit = segmentData.mandatoryCredit || '';
        
        // Video info
        this.videoPath = segmentData.videoPath || null;
        this.videoDuration = segmentData.duration || 5;
        
        // Hash for cache identification
        this.segmentHash = getSegmentHash(
            this.videoPath,
            this.headline,
            this.mandatoryCredit,
            this.videoDuration
        );
        
        // Pre-rendered video path
        this.renderedVideoPath = null;
        
        // State
        this.isRendering = false;
        this.renderError = null;
        this.lastRenderTime = null;
    }

    /**
     * Check if needs re-render
     */
    needsReRender(newSegmentData) {
        const newHeadline = newSegmentData.headline || newSegmentData.title || '';
        const newCredit = newSegmentData.mandatoryCredit || '';
        const newVideoPath = newSegmentData.videoPath || null;
        const newDuration = newSegmentData.duration || 5;
        
        const newHash = getSegmentHash(newVideoPath, newHeadline, newCredit, newDuration);
        
        if (newHash !== this.segmentHash) {
            logInfo(`Segment ${this.segmentIndex}: Hash changed, needs re-render`);
            return true;
        }
        
        return false;
    }

    /**
     * Update segment data
     */
    update(newSegmentData) {
        const needsRender = this.needsReRender(newSegmentData);
        
        this.headline = newSegmentData.headline || newSegmentData.title || '';
        this.mandatoryCredit = newSegmentData.mandatoryCredit || '';
        this.videoPath = newSegmentData.videoPath || null;
        this.videoDuration = newSegmentData.duration || 5;
        
        // Recalculate hash
        const oldHash = this.segmentHash;
        this.segmentHash = getSegmentHash(
            this.videoPath,
            this.headline,
            this.mandatoryCredit,
            this.videoDuration
        );
        
        if (needsRender) {
            logInfo(`Segment ${this.segmentIndex}: Invalidating old render (${oldHash} -> ${this.segmentHash})`);
            this.renderedVideoPath = null;
            this.renderError = null;
        }
        
        return needsRender;
    }

    /**
     * Check if ready for export
     */
    isReady() {
        return this.renderedVideoPath && 
               fs.existsSync(this.renderedVideoPath) && 
               !this.isRendering;
    }

    /**
     * Get cache path for rendered video
     */
    getCachePath(cacheDir) {
        return path.join(cacheDir, `segment_${this.segmentIndex}_${this.segmentHash}.mp4`);
    }
}

/**
 * Segment Pre-Render Manager
 */
class SegmentPreRenderManager extends EventEmitter {
    constructor() {
        super();
        
        this.segments = new Map();
        this.renderQueue = [];
        this.isProcessingQueue = false;
        
        // Cache directory
        this.cacheDir = path.join(os.homedir(), 'ClickStudio', 'Temp', 'prerendered-segments');
        this.ensureCacheDir();
        
        // Renderer references
        this.lowerThirdRenderer = null;
        this.mandatoryCreditRenderer = null;
        this.videoRenderer = null;
        
        // Limits
        this.maxConcurrentRenders = 1; // One at a time to avoid overwhelming system
        this.activeRenders = 0;
        
        logInfo('SegmentPreRenderManager initialized');
    }

    ensureCacheDir() {
        if (!fs.existsSync(this.cacheDir)) {
            fs.mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    /**
     * Initialize renderers
     */
    async initializeRenderers() {
        if (this.lowerThirdRenderer && this.mandatoryCreditRenderer && this.videoRenderer) {
            return;
        }

        try {
            const { default: ltRenderer } = await import('./lowerThirdRenderer.js');
            this.lowerThirdRenderer = ltRenderer;
            logInfo('LowerThird renderer loaded');
        } catch (e) {
            logError('Failed to load LowerThird renderer', e);
        }

        try {
            const { default: mcRenderer } = await import('./mandatoryCreditRenderer.js');
            this.mandatoryCreditRenderer = mcRenderer;
            logInfo('MandatoryCredit renderer loaded');
        } catch (e) {
            logError('Failed to load MandatoryCredit renderer', e);
        }

        try {
            const { renderSegmentVideo } = await import('./segmentVideoRenderer.js');
            this.videoRenderer = renderSegmentVideo;
            logInfo('Video renderer loaded');
        } catch (e) {
            logError('Failed to load video renderer', e);
        }
    }

    /**
     * Update or create segment
     */
    async updateSegment(segmentIndex, segmentData) {
        logInfo(`Updating segment ${segmentIndex}: ${segmentData.headline || '(no headline)'}`);
        
        let segment = this.segments.get(segmentIndex);
        let needsRender = false;
        
        if (!segment) {
            segment = new SegmentState(segmentIndex, segmentData);
            this.segments.set(segmentIndex, segment);
            
            // Check if already cached
            const cachePath = segment.getCachePath(this.cacheDir);
            if (fs.existsSync(cachePath)) {
                segment.renderedVideoPath = cachePath;
                logInfo(`Segment ${segmentIndex}: Found in cache`);
            } else {
                needsRender = true;
            }
        } else {
            needsRender = segment.update(segmentData);
        }
        
        if (needsRender) {
            logInfo(`Segment ${segmentIndex}: Queuing for render`);
            this.queueSegmentRender(segmentIndex);
        } else {
            logInfo(`Segment ${segmentIndex}: Ready (cached)`);
        }
        
        this.emit('segmentUpdated', {
            segmentIndex,
            isReady: segment.isReady(),
            isRendering: segment.isRendering
        });
        
        return segment;
    }

    /**
     * Queue segment for rendering
     */
    queueSegmentRender(segmentIndex) {
        const segment = this.segments.get(segmentIndex);
        if (!segment) return;
        
        // Remove existing entry
        this.renderQueue = this.renderQueue.filter(idx => idx !== segmentIndex);
        
        // Add to front
        this.renderQueue.unshift(segmentIndex);
        
        // Start processing
        this.processRenderQueue();
    }

    /**
     * Process render queue
     */
    async processRenderQueue() {
        if (this.isProcessingQueue) return;
        if (this.renderQueue.length === 0) return;
        if (this.activeRenders >= this.maxConcurrentRenders) return;
        
        this.isProcessingQueue = true;
        
        try {
            await this.initializeRenderers();
            
            while (this.renderQueue.length > 0 && this.activeRenders < this.maxConcurrentRenders) {
                const segmentIndex = this.renderQueue.shift();
                const segment = this.segments.get(segmentIndex);
                
                if (!segment || segment.isReady() || segment.isRendering) {
                    continue;
                }
                
                this.activeRenders++;
                this.renderSegment(segment).finally(() => {
                    this.activeRenders--;
                    setImmediate(() => this.processRenderQueue());
                });
            }
        } finally {
            this.isProcessingQueue = false;
        }
    }

    /**
     * Render complete segment
     */
    async renderSegment(segment) {
        const { segmentIndex } = segment;
        segment.isRendering = true;
        segment.renderError = null;
        
        logInfo(`Segment ${segmentIndex}: Starting full render`);
        this.emit('renderStarted', { segmentIndex });
        
        try {
            // Step 1: Render overlays first
            let lowerThirdPath = null;
            let creditPath = null;
            
            if (segment.headline && this.lowerThirdRenderer) {
                logInfo(`Segment ${segmentIndex}: Rendering lower third`);
                lowerThirdPath = await this.lowerThirdRenderer.renderLowerThird({
                    headline: segment.headline,
                    durationInSeconds: Math.min(segment.videoDuration, 5),
                    segmentId: segmentIndex
                });
            }
            
            if (segment.mandatoryCredit && this.mandatoryCreditRenderer) {
                logInfo(`Segment ${segmentIndex}: Rendering credit`);
                creditPath = await this.mandatoryCreditRenderer.renderMandatoryCredit({
                    text: segment.mandatoryCredit,
                    durationInSeconds: Math.min(segment.videoDuration, 5),
                    segmentId: segmentIndex
                });
            }
            
            // Step 2: Render complete segment video
            if (this.videoRenderer && segment.videoPath) {
                const outputPath = segment.getCachePath(this.cacheDir);
                
                logInfo(`Segment ${segmentIndex}: Rendering final video`);
                await this.videoRenderer({
                    segmentIndex,
                    videoPath: segment.videoPath,
                    lowerThirdPath,
                    mandatoryCreditPath: creditPath,
                    duration: segment.videoDuration,
                    outputPath,
                    onProgress: (progress) => {
                        this.emit('renderProgress', { segmentIndex, ...progress });
                    }
                });
                
                segment.renderedVideoPath = outputPath;
            }
            
            segment.isRendering = false;
            segment.lastRenderTime = Date.now();
            
            logInfo(`Segment ${segmentIndex}: Render complete`);
            this.emit('renderComplete', { 
                segmentIndex, 
                isReady: segment.isReady(),
                path: segment.renderedVideoPath
            });
            
        } catch (error) {
            segment.isRendering = false;
            segment.renderError = error.message;
            
            logError(`Segment ${segmentIndex}: Render failed`, error);
            this.emit('renderError', { segmentIndex, error: error.message });
        }
    }

    /**
     * Get rendered segments for export
     */
    getRenderedSegments() {
        const segments = [];
        
        for (const [index, segment] of this.segments) {
            if (segment.isReady()) {
                segments.push({
                    index,
                    path: segment.renderedVideoPath,
                    duration: segment.videoDuration
                });
            }
        }
        
        return segments.sort((a, b) => a.index - b.index);
    }

    /**
     * Get status for UI
     */
    getStatus() {
        let readyCount = 0;
        
        for (const segment of this.segments.values()) {
            if (segment.isReady()) readyCount++;
        }
        
        return {
            totalSegments: this.segments.size,
            readyCount,
            isExportReady: this.segments.size > 0 && readyCount === this.segments.size,
            queueLength: this.renderQueue.length,
            activeRenders: this.activeRenders
        };
    }

    /**
     * Clear all segments
     */
    clear() {
        logInfo('Clearing all segments');
        this.segments.clear();
        this.renderQueue = [];
        this.activeRenders = 0;
        this.emit('cleared');
    }
}

// Singleton
const segmentPreRenderManager = new SegmentPreRenderManager();

export default segmentPreRenderManager;
export { SegmentPreRenderManager, SegmentState };
