import React, { useRef, useEffect, useState, useCallback, memo } from 'react';
import { PeakData, computePeaks, computePeaksFromUrl, drawWaveform } from '../../utils/WaveformPeaks';
import { AudioClip } from '../../types';

// Segment type matching existing data flow
export interface TimelineSegment {
    index: number;
    title?: string;
    headline?: string;
    text?: string;
    start_time: number;
    end_time: number;
    duration: number;
    blobUrl?: string;
    video?: {
        previewUrl?: string;
        thumbnail?: string;
        title?: string;
    };
    status?: 'pending' | 'searching' | 'found' | 'approved' | 'error';
}

interface TimelineCanvasProps {
    segments: TimelineSegment[];
    currentTime: number;
    duration: number;
    audioUrl: string | null;
    audioBuffer?: AudioBuffer | null; // Unified buffer support
    audioClips?: AudioClip[];
    onUpdateAudioClip?: (id: string, updates: Partial<AudioClip>) => void;
    selectedSegmentIndex: number | null;
    onSegmentClick: (segment: TimelineSegment) => void;
    onSeek: (time: number) => void;
    onInteractionStart?: () => void;
    onInteractionEnd?: () => void;
    isPlaying: boolean;
    height?: number;
}


// Constants
const RULER_HEIGHT = 24;
const VIDEO_TRACK_HEIGHT = 50;
const AUDIO_TRACK_HEIGHT = 55;
const TRACK_LABEL_WIDTH = 50;
const MIN_PIXELS_PER_SECOND = 10;
const MAX_PIXELS_PER_SECOND = 500;
const DEFAULT_PIXELS_PER_SECOND = 50;
const ZOOM_LERP = 0.2;
const SCROLL_LERP = 0.22;
const SCROLL_FRICTION = 0.86;

// Colors - Professional dark theme with subtle, muted accents
const COLORS = {
    // Backgrounds
    background: '#0a0a0c',
    rulerBackground: '#08080a',
    trackBackground: 'rgba(255, 255, 255, 0.02)',
    trackAltBackground: 'rgba(255, 255, 255, 0.015)',
    
    // Ruler
    rulerText: '#4a4a4a',
    rulerLine: '#1a1a1e',
    rulerLineMajor: '#252528',
    
    // Segments
    segmentEmpty: '#141418',
    segmentVideo: '#1a1a1e',
    segmentSelected: 'rgba(255, 0, 85, 0.12)',
    segmentBorder: 'rgba(255, 255, 255, 0.06)',
    segmentBorderSelected: 'rgba(255, 0, 85, 0.5)',
    
    // Waveform - muted warm tone that's easier on eyes
    waveform: '#FF6B8A',
    waveformAlt: '#E85A79',
    
    // Playhead and accent
    playhead: '#FF0055',
    accent: '#FF0055',
    
    // Text
    textPrimary: '#d0d0d0',
    textSecondary: '#666',
    textMuted: '#3a3a3a',
    
    // Status indicators
    statusSearching: '#FFD60A',
    statusReady: '#30D158',
    statusError: '#FF453A'
};

const TimelineCanvas: React.FC<TimelineCanvasProps> = memo(({
    segments,
    currentTime,
    duration,
    audioUrl,
    audioBuffer,
    selectedSegmentIndex,
    onSegmentClick,
    onSeek,
    onInteractionStart,
    onInteractionEnd,


    isPlaying,
    audioClips,
    onUpdateAudioClip,
    height = 180
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const rulerCanvasRef = useRef<HTMLCanvasElement>(null);
    const videoTrackCanvasRef = useRef<HTMLCanvasElement>(null);
    const audioTrackCanvasRef = useRef<HTMLCanvasElement>(null);
    const playheadRef = useRef<HTMLDivElement>(null);

    // State
    const [pixelsPerSecond, setPixelsPerSecond] = useState(DEFAULT_PIXELS_PER_SECOND);
    const [scrollOffset, setScrollOffset] = useState(0);
    const [canvasWidth, setCanvasWidth] = useState(1000);
    const [peaks, setPeaks] = useState<PeakData | null>(null);
    const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);
    const [draggingClipId, setDraggingClipId] = useState<string | null>(null);
    const [dragStartX, setDragStartX] = useState(0);
    const [dragStartTime, setDragStartTime] = useState(0);

    // Refs for tracking
    const rafRef = useRef<number | null>(null);
    const peaksLoadingRef = useRef(false);
    const pixelsPerSecondRef = useRef(pixelsPerSecond);
    const scrollOffsetRef = useRef(scrollOffset);
    const targetPixelsPerSecondRef = useRef(pixelsPerSecond);
    const targetScrollOffsetRef = useRef(scrollOffset);
    const scrollVelocityRef = useRef(0);
    const animationFrameRef = useRef<number | null>(null);
    const isAnimatingRef = useRef(false);

    const clampScroll = useCallback((value: number, pps = pixelsPerSecondRef.current) => {
        const maxOffset = Math.max(0, (duration * pps) - canvasWidth);
        return Math.max(0, Math.min(maxOffset, value));
    }, [canvasWidth, duration]);

    const startAnimation = useCallback(() => {
        if (isAnimatingRef.current) return;
        isAnimatingRef.current = true;

        const step = () => {
            const currentPps = pixelsPerSecondRef.current;
            const targetPps = targetPixelsPerSecondRef.current;
            const nextPps = currentPps + (targetPps - currentPps) * ZOOM_LERP;

            let targetScroll = clampScroll(targetScrollOffsetRef.current, nextPps);
            targetScrollOffsetRef.current = targetScroll;

            const currentScroll = scrollOffsetRef.current;
            const nextScroll = currentScroll + (targetScroll - currentScroll) * SCROLL_LERP;

            const velocity = scrollVelocityRef.current;
            if (Math.abs(velocity) > 0.1) {
                targetScrollOffsetRef.current = clampScroll(targetScroll + velocity, nextPps);
                scrollVelocityRef.current = velocity * SCROLL_FRICTION;
            }

            setPixelsPerSecond(nextPps);
            setScrollOffset(nextScroll);
            pixelsPerSecondRef.current = nextPps;
            scrollOffsetRef.current = nextScroll;

            const shouldContinue =
                Math.abs(targetPps - nextPps) > 0.05 ||
                Math.abs(targetScrollOffsetRef.current - nextScroll) > 0.25 ||
                Math.abs(scrollVelocityRef.current) > 0.1;

            if (shouldContinue) {
                animationFrameRef.current = requestAnimationFrame(step);
            } else {
                isAnimatingRef.current = false;
                animationFrameRef.current = null;
            }
        };

        animationFrameRef.current = requestAnimationFrame(step);
    }, [clampScroll]);

    // Coordinate conversion
    const timeToPixel = useCallback((time: number): number => {
        return (time * pixelsPerSecond) - scrollOffset;
    }, [pixelsPerSecond, scrollOffset]);

    const pixelToTime = useCallback((pixel: number): number => {
        return (pixel + scrollOffset) / pixelsPerSecond;
    }, [pixelsPerSecond, scrollOffset]);

    // Load peaks logic: Buffer first, then URL
    useEffect(() => {
        if (peaksLoadingRef.current) return;

        // 1. If buffer is provided, use it directly (fastest)
        // 1. If buffer is provided, use it directly (fastest)
        if (audioBuffer) {
            peaksLoadingRef.current = true;
            // Use Worker for main thread offloading
            import('../../utils/WaveformPeaks').then(({ computePeaksWorker }) => {
                computePeaksWorker(audioBuffer, 10000)
                    .then(setPeaks)
                    .catch(e => {
                        console.error('Worker failed, falling back to main thread', e);
                        // Fallback
                        computePeaks(audioBuffer, 10000).then(setPeaks);
                    })
                    .finally(() => { peaksLoadingRef.current = false; });
            });
        } else if (audioUrl) {
            peaksLoadingRef.current = true;
            computePeaksFromUrl(audioUrl, 10000)
                .then(setPeaks)
                .catch(console.error)
                .finally(() => { peaksLoadingRef.current = false; });
        }
    }, [audioUrl, audioBuffer]);
    // Update canvas size on mount and resize
    useEffect(() => {
        const updateSize = () => {
            if (containerRef.current) {
                const width = containerRef.current.clientWidth - TRACK_LABEL_WIDTH;
                setCanvasWidth(Math.max(width, 100));
            }
        };

        updateSize();
        window.addEventListener('resize', updateSize);
        return () => window.removeEventListener('resize', updateSize);
    }, []);

    useEffect(() => {
        return () => {
            if (animationFrameRef.current) {
                cancelAnimationFrame(animationFrameRef.current);
            }
        };
    }, []);

    useEffect(() => {
        pixelsPerSecondRef.current = pixelsPerSecond;
        scrollOffsetRef.current = scrollOffset;
    }, [pixelsPerSecond, scrollOffset]);

    useEffect(() => {
        const clamped = clampScroll(scrollOffsetRef.current, pixelsPerSecondRef.current);
        if (clamped !== scrollOffsetRef.current) {
            scrollOffsetRef.current = clamped;
            targetScrollOffsetRef.current = clamped;
            setScrollOffset(clamped);
        }
    }, [canvasWidth, duration, clampScroll]);

    // Draw ruler
    const drawRuler = useCallback(() => {
        const canvas = rulerCanvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvasWidth * dpr;
        canvas.height = RULER_HEIGHT * dpr;
        ctx.scale(dpr, dpr);

        // Background with subtle gradient
        const gradient = ctx.createLinearGradient(0, 0, 0, RULER_HEIGHT);
        gradient.addColorStop(0, '#0a0a0c');
        gradient.addColorStop(1, COLORS.rulerBackground);
        ctx.fillStyle = gradient;
        ctx.fillRect(0, 0, canvasWidth, RULER_HEIGHT);
        
        // Bottom border line
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, RULER_HEIGHT - 0.5);
        ctx.lineTo(canvasWidth, RULER_HEIGHT - 0.5);
        ctx.stroke();

        // Calculate tick interval based on zoom
        let tickInterval = 1; // seconds
        if (pixelsPerSecond < 20) tickInterval = 10;
        else if (pixelsPerSecond < 50) tickInterval = 5;
        else if (pixelsPerSecond > 200) tickInterval = 0.5;

        const majorTickInterval = tickInterval * 5;

        ctx.font = '10px SF Mono, Menlo, monospace';
        ctx.textAlign = 'left';

        // Calculate visible time range
        const startTime = Math.max(0, scrollOffset / pixelsPerSecond);
        const endTime = Math.min(duration, (scrollOffset + canvasWidth) / pixelsPerSecond);

        // Draw ticks
        for (let t = Math.floor(startTime / tickInterval) * tickInterval; t <= endTime; t += tickInterval) {
            const x = timeToPixel(t);
            if (x < 0 || x > canvasWidth) continue;

            const isMajor = t % majorTickInterval < 0.001;

            ctx.strokeStyle = isMajor ? COLORS.rulerLineMajor : COLORS.rulerLine;
            ctx.lineWidth = isMajor ? 1 : 0.5;
            ctx.beginPath();
            ctx.moveTo(x, isMajor ? 8 : RULER_HEIGHT - 5);
            ctx.lineTo(x, RULER_HEIGHT);
            ctx.stroke();

            if (isMajor) {
                ctx.fillStyle = COLORS.rulerText;
                const mins = Math.floor(t / 60);
                const secs = Math.floor(t % 60);
                ctx.fillText(`${mins}:${secs.toString().padStart(2, '0')}`, x + 4, 16);
            }
        }
    }, [canvasWidth, duration, pixelsPerSecond, scrollOffset, timeToPixel]);

    // Draw video track
    const drawVideoTrack = useCallback(() => {
        const canvas = videoTrackCanvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvasWidth * dpr;
        canvas.height = VIDEO_TRACK_HEIGHT * dpr;
        ctx.scale(dpr, dpr);

        // Background
        ctx.fillStyle = COLORS.trackBackground;
        ctx.fillRect(0, 0, canvasWidth, VIDEO_TRACK_HEIGHT);

        // Visible time range for virtualization
        const visibleStartTime = scrollOffset / pixelsPerSecond;
        const visibleEndTime = (scrollOffset + canvasWidth) / pixelsPerSecond;

        // Filter visible segments
        const visibleSegments = segments.filter(seg =>
            seg.end_time > visibleStartTime && seg.start_time < visibleEndTime
        );

        // Draw segments
        visibleSegments.forEach(seg => {
            const x = timeToPixel(seg.start_time);
            const width = (seg.end_time - seg.start_time) * pixelsPerSecond;
            const isSelected = seg.index === selectedSegmentIndex;
            const padding = 2;
            const radius = 4;

            // Segment background with rounded corners effect
            ctx.fillStyle = seg.video ? COLORS.segmentVideo : COLORS.segmentEmpty;
            ctx.fillRect(x + padding, padding, width - padding * 2, VIDEO_TRACK_HEIGHT - padding * 2);

            // Alternating subtle tint for visual separation
            if (seg.index % 2 === 0) {
                ctx.fillStyle = 'rgba(255, 255, 255, 0.02)';
                ctx.fillRect(x + padding, padding, width - padding * 2, VIDEO_TRACK_HEIGHT - padding * 2);
            }

            // Selection highlight
            if (isSelected) {
                ctx.fillStyle = COLORS.segmentSelected;
                ctx.fillRect(x + padding, padding, width - padding * 2, VIDEO_TRACK_HEIGHT - padding * 2);

                // Selection border (top accent line)
                ctx.fillStyle = COLORS.accent;
                ctx.fillRect(x + padding, padding, width - padding * 2, 2);
            }

            // Segment divider line
            ctx.strokeStyle = COLORS.segmentBorder;
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, VIDEO_TRACK_HEIGHT);
            ctx.stroke();

            // Segment number - simple text, no badge
            ctx.fillStyle = isSelected ? COLORS.accent : COLORS.textMuted;
            ctx.font = 'bold 9px Inter, system-ui, sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(`#${seg.index + 1}`, x + 6, 12);
            ctx.textBaseline = 'alphabetic';

            // Segment title
            const displayTitle = seg.headline || seg.title || `Segment ${seg.index + 1}`;
            ctx.fillStyle = seg.video ? COLORS.textPrimary : COLORS.textSecondary;
            ctx.font = '10px Inter, system-ui, sans-serif';

            // Truncate text to fit
            const textStartX = x + 28;
            const maxTextWidth = width - 46;
            let displayLabel = displayTitle;
            if (maxTextWidth > 30) {
                if (ctx.measureText(displayLabel).width > maxTextWidth) {
                    while (ctx.measureText(displayLabel + '...').width > maxTextWidth && displayLabel.length > 0) {
                        displayLabel = displayLabel.slice(0, -1);
                    }
                    displayLabel += '...';
                }
                ctx.textBaseline = 'middle';
                ctx.fillText(displayLabel, textStartX, 12);
                ctx.textBaseline = 'alphabetic';
            }

            // Duration label - bottom left
            if (width > 50) {
                const durationText = `${seg.duration?.toFixed(1) || '0.0'}s`;
                ctx.fillStyle = COLORS.textMuted;
                ctx.font = '9px monospace';
                ctx.fillText(durationText, x + 6, VIDEO_TRACK_HEIGHT - 6);
            }

            // Status indicator with glow effect
            if (seg.status === 'searching') {
                // Glow
                ctx.shadowColor = COLORS.statusSearching;
                ctx.shadowBlur = 6;
                ctx.fillStyle = COLORS.statusSearching;
                ctx.beginPath();
                ctx.arc(x + width - 12, VIDEO_TRACK_HEIGHT / 2, 4, 0, Math.PI * 2);
                ctx.fill();
                ctx.shadowBlur = 0;
            } else if (seg.video || seg.status === 'found' || seg.status === 'approved') {
                ctx.fillStyle = COLORS.statusReady;
                ctx.beginPath();
                ctx.arc(x + width - 12, VIDEO_TRACK_HEIGHT / 2, 3, 0, Math.PI * 2);
                ctx.fill();
            }
        });
    }, [canvasWidth, segments, pixelsPerSecond, scrollOffset, selectedSegmentIndex, timeToPixel]);

    const drawAudioTrack = useCallback(() => {
        const canvas = audioTrackCanvasRef.current;
        if (!canvas) return;

        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = window.devicePixelRatio || 1;
        canvas.width = canvasWidth * dpr;
        canvas.height = AUDIO_TRACK_HEIGHT * dpr;
        ctx.scale(dpr, dpr);

        // Background - darker for contrast
        ctx.fillStyle = COLORS.trackAltBackground;
        ctx.fillRect(0, 0, canvasWidth, AUDIO_TRACK_HEIGHT);

        // NLE MODE: Draw discrete clips
        if (audioClips && audioClips.length > 0 && peaks) {
            audioClips.forEach(clip => {
                const x = timeToPixel(clip.startTime);
                const width = clip.duration * pixelsPerSecond;
                const isSelected = draggingClipId === clip.id;
                const padding = 2;

                // Optimization: Skip if off-screen
                if (x + width < 0 || x > canvasWidth) return;

                // Clip Background
                ctx.fillStyle = isSelected ? COLORS.segmentSelected : 'rgba(255, 107, 138, 0.06)';
                ctx.fillRect(x + padding, padding, width - padding * 2, AUDIO_TRACK_HEIGHT - padding * 2);

                // Draw Waveform Slice
                drawWaveform(ctx, peaks, {
                    x: x,
                    y: 0,
                    width: width,
                    height: AUDIO_TRACK_HEIGHT,
                    color: COLORS.waveform,
                    pixelsPerSecond,
                    scrollOffset: clip.offset * pixelsPerSecond,
                    startTime: clip.offset,
                    endTime: clip.offset + clip.duration
                });

                // Clip Border
                ctx.strokeStyle = isSelected ? COLORS.accent : 'rgba(255, 107, 138, 0.2)';
                ctx.lineWidth = 1;
                ctx.strokeRect(x + padding, padding, width - padding * 2, AUDIO_TRACK_HEIGHT - padding * 2);
            });
            return;
        }

        // LEGACY / FALLBACK MODE: Draw full waveform
        if (peaks) {
            drawWaveform(ctx, peaks, {
                x: 0,
                y: 0,
                width: canvasWidth,
                height: AUDIO_TRACK_HEIGHT,
                color: COLORS.waveform,
                pixelsPerSecond,
                scrollOffset
            });
        }

        // Segment dividers
        const visibleStartTime = scrollOffset / pixelsPerSecond;
        const visibleEndTime = (scrollOffset + canvasWidth) / pixelsPerSecond;

        segments.forEach(seg => {
            if (seg.end_time < visibleStartTime || seg.start_time > visibleEndTime) return;

            const x = timeToPixel(seg.start_time);
            const width = (seg.end_time - seg.start_time) * pixelsPerSecond;
            const isSelected = seg.index === selectedSegmentIndex;
            const padding = 2;

            // Segment Background (Alternating with very subtle tint)
            ctx.fillStyle = seg.index % 2 === 0 ? 'rgba(255, 255, 255, 0.02)' : 'rgba(255, 255, 255, 0.01)';
            ctx.fillRect(x + padding, padding, width - padding * 2, AUDIO_TRACK_HEIGHT - padding * 2);

            // Selection highlight
            if (isSelected) {
                ctx.fillStyle = COLORS.segmentSelected;
                ctx.fillRect(x + padding, padding, width - padding * 2, AUDIO_TRACK_HEIGHT - padding * 2);
            }

            // Left divider
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(x + 0.5, 0);
            ctx.lineTo(x + 0.5, AUDIO_TRACK_HEIGHT);
            ctx.stroke();
        });
    }, [canvasWidth, peaks, segments, audioClips, pixelsPerSecond, scrollOffset, selectedSegmentIndex, timeToPixel, draggingClipId]);

    // Update playhead position
    const updatePlayhead = useCallback(() => {
        if (!playheadRef.current) return;

        const x = timeToPixel(currentTime);
        playheadRef.current.style.transform = `translate3d(${x.toFixed(2)}px, 0, 0)`;
        playheadRef.current.style.display = (x >= 0 && x <= canvasWidth) ? 'block' : 'none';
    }, [currentTime, timeToPixel, canvasWidth]);

    // Redraw on changes
    useEffect(() => {
        drawRuler();
        drawVideoTrack();
        drawAudioTrack();
        updatePlayhead();
    }, [drawRuler, drawVideoTrack, drawAudioTrack, updatePlayhead]);

    // Playhead animation loop when playing
    useEffect(() => {
        if (isPlaying) {
            const animate = () => {
                updatePlayhead();
                rafRef.current = requestAnimationFrame(animate);
            };
            rafRef.current = requestAnimationFrame(animate);
        } else {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
            }
            updatePlayhead();
        }

        return () => {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
            }
        };
    }, [isPlaying, updatePlayhead]);

    // Handle click to seek or select segment
    const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        if (isDraggingPlayhead) return;

        // Signal interaction start (pause) -> Seek -> STAY PAUSED (like video editors)
        onInteractionStart?.();

        const rect = e.currentTarget.getBoundingClientRect();
        const x = e.clientX - rect.left - TRACK_LABEL_WIDTH;
        const time = pixelToTime(x);

        // Find segment at this time
        const clickedSegment = segments.find(seg =>
            time >= seg.start_time && time < seg.end_time
        );

        if (clickedSegment) {
            onSegmentClick(clickedSegment);
            // CRITICAL: Do NOT jump to segment start.
            // onSegmentClick should ONLY select the segment in the UI.
        }

        const targetTime = Math.max(0, Math.min(time, duration));
        onSeek(targetTime);

        // DO NOT call onInteractionEnd - stay paused at clicked position
        // This is the standard behavior in video editors like Premiere

    }, [isDraggingPlayhead, pixelToTime, segments, onSegmentClick, onSeek, duration, onInteractionStart]);


    // Handle wheel for scrolling and zooming (native function for useEffect)
    const handleWheelNative = useCallback((e: WheelEvent) => {
        e.preventDefault(); // Now works with passive: false
        if (e.ctrlKey || e.metaKey) {
            // Zoom (anchor to playhead for stability)
            const zoomFactor = Math.exp(-e.deltaY * 0.0015);
            const newPixelsPerSecond = Math.max(
                MIN_PIXELS_PER_SECOND,
                Math.min(MAX_PIXELS_PER_SECOND, pixelsPerSecondRef.current * zoomFactor)
            );

            const playheadX = (currentTime * pixelsPerSecondRef.current) - scrollOffsetRef.current;
            const anchorX = (playheadX >= 0 && playheadX <= canvasWidth) ? playheadX : canvasWidth * 0.5;
            const newScrollOffset = clampScroll((currentTime * newPixelsPerSecond) - anchorX, newPixelsPerSecond);

            targetPixelsPerSecondRef.current = newPixelsPerSecond;
            targetScrollOffsetRef.current = newScrollOffset;
            startAnimation();
        } else {
            // Horizontal scroll with inertia
            const delta = e.deltaX !== 0 ? e.deltaX : e.deltaY;
            const nextTarget = clampScroll(targetScrollOffsetRef.current + delta, pixelsPerSecondRef.current);
            targetScrollOffsetRef.current = nextTarget;
            scrollVelocityRef.current += delta * 0.4;
            startAnimation();
        }
    }, [canvasWidth, clampScroll, currentTime, startAnimation]);

    // Attach wheel listener with passive: false to allow preventDefault
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        container.addEventListener('wheel', handleWheelNative, { passive: false });
        return () => {
            container.removeEventListener('wheel', handleWheelNative);
        };
    }, [handleWheelNative]);

    // Playhead dragging
    const handlePlayheadMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingPlayhead(true);
        onInteractionStart?.(); // PAUSE playback while dragging

        const handleMouseMove = (moveE: MouseEvent) => {
            if (!containerRef.current) return;
            const rect = containerRef.current.getBoundingClientRect();
            // Calculate using Refs to ensure freshness during drag
            const x = moveE.clientX - rect.left - TRACK_LABEL_WIDTH;
            const pps = pixelsPerSecondRef.current;
            const scroll = scrollOffsetRef.current;
            const time = (x + scroll) / pps;

            onSeek(Math.max(0, Math.min(time, duration)));
        };

        const handleMouseUp = () => {
            setIsDraggingPlayhead(false);
            onInteractionEnd?.(); // RESUME playback if was playing
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
        };

        window.addEventListener('mousemove', handleMouseMove);
        window.addEventListener('mouseup', handleMouseUp);
    }, [pixelToTime, onSeek, duration]);

    // Zoom controls
    const handleZoomIn = () => {
        const newPixelsPerSecond = Math.min(MAX_PIXELS_PER_SECOND, pixelsPerSecondRef.current * 1.15);
        const playheadX = (currentTime * pixelsPerSecondRef.current) - scrollOffsetRef.current;
        const anchorX = (playheadX >= 0 && playheadX <= canvasWidth) ? playheadX : canvasWidth * 0.5;
        targetPixelsPerSecondRef.current = newPixelsPerSecond;
        targetScrollOffsetRef.current = clampScroll((currentTime * newPixelsPerSecond) - anchorX, newPixelsPerSecond);
        startAnimation();
    };

    const handleZoomOut = () => {
        const newPixelsPerSecond = Math.max(MIN_PIXELS_PER_SECOND, pixelsPerSecondRef.current / 1.15);
        const playheadX = (currentTime * pixelsPerSecondRef.current) - scrollOffsetRef.current;
        const anchorX = (playheadX >= 0 && playheadX <= canvasWidth) ? playheadX : canvasWidth * 0.5;
        targetPixelsPerSecondRef.current = newPixelsPerSecond;
        targetScrollOffsetRef.current = clampScroll((currentTime * newPixelsPerSecond) - anchorX, newPixelsPerSecond);
        startAnimation();
    };

    return (
        <div
            ref={containerRef}
            className="timeline-canvas-container"
            style={{
                height,
                background: COLORS.background,
                position: 'relative',
                overflow: 'hidden',
                userSelect: 'none'
            }}
            onClick={handleClick}
            onMouseMove={(e) => {
                // Dynamic cursor for trimming
                if (audioClips && audioClips.length > 0 && containerRef.current && !draggingClipId && !isDraggingPlayhead) {
                    const rect = containerRef.current.getBoundingClientRect();
                    const y = e.clientY - rect.top;
                    const audioTrackY = RULER_HEIGHT + VIDEO_TRACK_HEIGHT;

                    if (y >= audioTrackY && y <= audioTrackY + AUDIO_TRACK_HEIGHT) {
                        const x = e.clientX - rect.left - TRACK_LABEL_WIDTH;
                        const time = (x + scrollOffset) / pixelsPerSecond;

                        // Find if near any clip edge
                        const EDGE_THRESHOLD_PX = 6;
                        const thresholdSec = EDGE_THRESHOLD_PX / pixelsPerSecond;

                        const hitClip = audioClips.find(c => time >= c.startTime - thresholdSec && time <= c.startTime + c.duration + thresholdSec);

                        if (hitClip) {
                            const startDist = Math.abs(time - hitClip.startTime);
                            const endDist = Math.abs(time - (hitClip.startTime + hitClip.duration));

                            if (startDist < thresholdSec || endDist < thresholdSec) {
                                e.currentTarget.style.cursor = 'col-resize';
                                return;
                            } else if (time >= hitClip.startTime && time <= hitClip.startTime + hitClip.duration) {
                                e.currentTarget.style.cursor = 'move';
                                return;
                            }
                        }
                    }
                }
                if (e.currentTarget.style.cursor !== 'default') {
                    e.currentTarget.style.cursor = 'default';
                }
            }}
            onMouseDown={(e: React.MouseEvent) => {
                if (isDraggingPlayhead) return;

                // CLIP DRAG / TRIM LOGIC
                if (audioClips && audioClips.length > 0 && onUpdateAudioClip && containerRef.current) {
                    const rect = containerRef.current.getBoundingClientRect();
                    const y = e.clientY - rect.top;

                    // Check if click is in Audio Track area
                    const audioTrackY = RULER_HEIGHT + VIDEO_TRACK_HEIGHT;
                    if (y >= audioTrackY && y <= audioTrackY + AUDIO_TRACK_HEIGHT) {
                        const x = e.clientX - rect.left - TRACK_LABEL_WIDTH;
                        const time = (x + scrollOffset) / pixelsPerSecond;

                        const EDGE_THRESHOLD_PX = 6;
                        const thresholdSec = EDGE_THRESHOLD_PX / pixelsPerSecond;

                        // Find clip (including edges)
                        const clickedClip = audioClips.find(c =>
                            time >= c.startTime - thresholdSec && time <= c.startTime + c.duration + thresholdSec
                        );

                        if (clickedClip) {
                            e.stopPropagation();
                            onInteractionStart?.();
                            setDraggingClipId(clickedClip.id);
                            setDragStartX(e.clientX);
                            setDragStartTime(clickedClip.startTime);

                            // Determine Mode
                            const startDist = Math.abs(time - clickedClip.startTime);
                            const endDist = Math.abs(time - (clickedClip.startTime + clickedClip.duration));

                            let mode: 'move' | 'trim-left' | 'trim-right' = 'move';
                            if (startDist < thresholdSec) mode = 'trim-left';
                            else if (endDist < thresholdSec) mode = 'trim-right';

                            const initialDuration = clickedClip.duration;
                            const initialOffset = clickedClip.offset;
                            const initialStartTime = clickedClip.startTime;

                            const handleClipMove = (me: MouseEvent) => {
                                const deltaX = me.clientX - e.clientX;
                                const deltaSeconds = deltaX / pixelsPerSecondRef.current;

                                if (mode === 'move') {
                                    const newTime = Math.max(0, initialStartTime + deltaSeconds);
                                    onUpdateAudioClip(clickedClip.id, { startTime: newTime });
                                } else if (mode === 'trim-right') {
                                    const newDuration = Math.max(0.1, initialDuration + deltaSeconds);
                                    onUpdateAudioClip(clickedClip.id, { duration: newDuration });
                                } else if (mode === 'trim-left') {
                                    // Left trim: moves startTime + offset, reduces duration

                                    // Calculate proposed changes
                                    let newStart = initialStartTime + deltaSeconds;
                                    let newDuration = initialDuration - deltaSeconds;
                                    let newOffset = initialOffset + deltaSeconds;

                                    // Constraints
                                    if (newDuration < 0.1) {
                                        // Cap at min duration (0.1s)
                                        // If we tried to trim too much, deltaSeconds was too large
                                        // effective delta should be initialDuration - 0.1
                                        const effectiveDelta = initialDuration - 0.1;
                                        newStart = initialStartTime + effectiveDelta;
                                        newDuration = 0.1;
                                        newOffset = initialOffset + effectiveDelta;
                                    }
                                    if (newOffset < 0) {
                                        // Cannot trim before start of file
                                        // effective delta is -initialOffset
                                        const effectiveDelta = -initialOffset;
                                        newStart = initialStartTime + effectiveDelta;
                                        newOffset = 0;
                                        newDuration = initialDuration - effectiveDelta;
                                    }

                                    onUpdateAudioClip(clickedClip.id, {
                                        startTime: newStart,
                                        duration: newDuration,
                                        offset: newOffset
                                    });
                                }
                            };

                            const handleClipUp = () => {
                                setDraggingClipId(null);
                                onInteractionEnd?.();
                                window.removeEventListener('mousemove', handleClipMove);
                                window.removeEventListener('mouseup', handleClipUp);
                            };

                            window.addEventListener('mousemove', handleClipMove);
                            window.addEventListener('mouseup', handleClipUp);
                            return;
                        }
                    }
                }
            }}
        >
            {/* Zoom controls - positioned in ruler area */}
            <div style={{
                position: 'absolute',
                top: 0,
                right: 0,
                height: RULER_HEIGHT,
                display: 'flex',
                alignItems: 'center',
                gap: 4,
                zIndex: 20,
                paddingRight: 8,
                paddingLeft: 8,
                background: 'linear-gradient(90deg, transparent 0%, rgba(8, 8, 10, 0.95) 20%)'
            }}>
                <button
                    onClick={(e) => { e.stopPropagation(); handleZoomOut(); }}
                    style={{
                        width: 18, 
                        height: 18, 
                        borderRadius: 3,
                        background: 'rgba(255, 255, 255, 0.06)', 
                        border: 'none',
                        color: '#666', 
                        cursor: 'pointer', 
                        fontSize: 14,
                        lineHeight: '18px',
                        fontWeight: 300,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#aaa'; e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = '#666'; e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                >-</button>
                <span style={{ 
                    fontSize: 10, 
                    color: '#555', 
                    minWidth: 32, 
                    textAlign: 'center',
                    fontFamily: 'monospace'
                }}>
                    {Math.round(pixelsPerSecond / DEFAULT_PIXELS_PER_SECOND * 100)}%
                </span>
                <button
                    onClick={(e) => { e.stopPropagation(); handleZoomIn(); }}
                    style={{
                        width: 18, 
                        height: 18, 
                        borderRadius: 3,
                        background: 'rgba(255, 255, 255, 0.06)', 
                        border: 'none',
                        color: '#666', 
                        cursor: 'pointer', 
                        fontSize: 14,
                        lineHeight: '18px',
                        fontWeight: 300,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center'
                    }}
                    onMouseEnter={(e) => { e.currentTarget.style.color = '#aaa'; e.currentTarget.style.background = 'rgba(255,255,255,0.1)'; }}
                    onMouseLeave={(e) => { e.currentTarget.style.color = '#666'; e.currentTarget.style.background = 'rgba(255,255,255,0.06)'; }}
                >+</button>
            </div>

            {/* Track labels */}
            <div style={{
                position: 'absolute',
                left: 0,
                top: RULER_HEIGHT,
                width: TRACK_LABEL_WIDTH,
                zIndex: 10,
                background: 'rgba(10, 10, 12, 0.9)'
            }}>
                <div style={{
                    height: VIDEO_TRACK_HEIGHT,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    paddingRight: 8,
                    fontSize: 9,
                    fontWeight: 600,
                    color: '#444',
                    textTransform: 'uppercase',
                    letterSpacing: '0.03em'
                }}>Video</div>
                <div style={{
                    height: AUDIO_TRACK_HEIGHT,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'flex-end',
                    paddingRight: 8,
                    fontSize: 9,
                    fontWeight: 600,
                    color: '#444',
                    textTransform: 'uppercase',
                    letterSpacing: '0.03em'
                }}>Audio</div>
            </div>

            {/* Canvas area */}
            <div style={{
                position: 'absolute',
                left: TRACK_LABEL_WIDTH,
                top: 0,
                right: 0,
                bottom: 0
            }}>
                {/* Ruler */}
                <canvas
                    ref={rulerCanvasRef}
                    style={{
                        width: canvasWidth,
                        height: RULER_HEIGHT,
                        display: 'block'
                    }}
                />

                {/* Video track */}
                <canvas
                    ref={videoTrackCanvasRef}
                    style={{
                        width: canvasWidth,
                        height: VIDEO_TRACK_HEIGHT,
                        display: 'block'
                    }}
                />

                {/* Audio track */}
                <canvas
                    ref={audioTrackCanvasRef}
                    style={{
                        width: canvasWidth,
                        height: AUDIO_TRACK_HEIGHT,
                        display: 'block'
                    }}
                />

                {/* Playhead */}
                <div
                    ref={playheadRef}
                    style={{
                        position: 'absolute',
                        top: 0,
                        bottom: 0,
                        width: 1,
                        background: COLORS.playhead,
                        boxShadow: `0 0 6px ${COLORS.playhead}90, 0 0 12px ${COLORS.playhead}40`,
                        zIndex: 50,
                        pointerEvents: 'none',
                        willChange: 'transform'
                    }}
                >
                    {/* Playhead handle */}
                    <div
                        onMouseDown={handlePlayheadMouseDown}
                        style={{
                            position: 'absolute',
                            top: -2,
                            left: '50%',
                            transform: 'translateX(-50%)',
                            width: 12,
                            height: 12,
                            background: COLORS.playhead,
                            borderRadius: 2,
                            clipPath: 'polygon(0 0, 100% 0, 100% 50%, 50% 100%, 0 50%)',
                            cursor: 'ew-resize',
                            pointerEvents: 'auto',
                            boxShadow: `0 2px 4px rgba(0, 0, 0, 0.3)`
                        }}
                    />
                </div>
            </div>
        </div>
    );
});

TimelineCanvas.displayName = 'TimelineCanvas';

export default TimelineCanvas;
