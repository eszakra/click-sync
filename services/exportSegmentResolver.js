// exportSegmentResolver.js - Connects pre-rendered segments with videoEditor export
// This module checks for pre-rendered segments and provides them to the export process

import path from 'path';
import fs from 'fs';
import os from 'os';

const CACHE_DIR = path.join(os.homedir(), 'ClickStudio', 'Temp', 'prerendered-segments');

/**
 * Check if pre-rendered segments exist and are valid
 */
export async function getPreRenderedSegments(segmentCount) {
    const segments = [];
    
    for (let i = 0; i < segmentCount; i++) {
        // Look for any pre-rendered segment file for this index
        try {
            if (fs.existsSync(CACHE_DIR)) {
                const files = fs.readdirSync(CACHE_DIR);
                const segmentFile = files.find(f => f.startsWith(`segment_${i}_`) && f.endsWith('.mp4'));
                
                if (segmentFile) {
                    const fullPath = path.join(CACHE_DIR, segmentFile);
                    segments.push({
                        index: i,
                        path: fullPath,
                        isPreRendered: true
                    });
                } else {
                    segments.push({
                        index: i,
                        path: null,
                        isPreRendered: false
                    });
                }
            }
        } catch (e) {
            console.error(`[ExportResolver] Error checking segment ${i}:`, e);
            segments.push({
                index: i,
                path: null,
                isPreRendered: false
            });
        }
    }
    
    return segments;
}

/**
 * Check if all segments are pre-rendered
 */
export function areAllSegmentsPreRendered(segments) {
    if (!segments || segments.length === 0) return false;
    return segments.every(seg => seg.isPreRendered && fs.existsSync(seg.path));
}

/**
 * Get export strategy based on pre-render status
 */
export async function getExportStrategy(timeline, options = {}) {
    const { usePreRendered = true } = options;
    
    if (!usePreRendered) {
        return {
            type: 'traditional',
            clips: timeline,
            message: 'Using traditional export (pre-render disabled)'
        };
    }
    
    const preRenderedSegments = await getPreRenderedSegments(timeline.length);
    const allPreRendered = areAllSegmentsPreRendered(preRenderedSegments);
    
    if (allPreRendered) {
        // Use pre-rendered segments - just concatenate
        return {
            type: 'prerendered',
            clips: preRenderedSegments.map(seg => ({
                index: seg.index,
                processedVideo: seg.path,
                duration: 0 // Will be detected from file
            })),
            message: `Using ${preRenderedSegments.length} pre-rendered segments`
        };
    } else {
        // Mix: some pre-rendered, some need traditional
        const mixedClips = timeline.map((clip, idx) => {
            const preRendered = preRenderedSegments.find(s => s.index === idx);
            if (preRendered?.isPreRendered) {
                return {
                    ...clip,
                    processedVideo: preRendered.path,
                    isPreRendered: true
                };
            }
            return {
                ...clip,
                isPreRendered: false
            };
        });
        
        const preRenderedCount = mixedClips.filter(c => c.isPreRendered).length;
        
        return {
            type: 'mixed',
            clips: mixedClips,
            message: `Using ${preRenderedCount} pre-rendered + ${timeline.length - preRenderedCount} traditional`
        };
    }
}

export default {
    getPreRenderedSegments,
    areAllSegmentsPreRendered,
    getExportStrategy
};
