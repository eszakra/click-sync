import React, { useState, useRef, useEffect, useCallback } from 'react';
import { FilmIcon, PlayIcon, PauseIcon, ChevronLeftIcon, PlusIcon, MinusIcon, XMarkIcon, ArrowDownTrayIcon, ComputerDesktopIcon, StopIcon, ArrowsPointingOutIcon, ArrowsPointingInIcon } from '@heroicons/react/24/solid';
import TitleBar from '../TitleBar';
import { WaveformTrack } from './WaveformTrack';
import './editor.css';

// Types
interface EditorProps {
    project: any;
    timeline: any;
    onReplaceClip: (segmentIndex: number) => void;
    onApproveSegment: (segmentIndex: number) => void;
    onGeneratePreview: () => Promise<string>;
    onExportFinal: (cb: (p: any) => void) => Promise<string>;
    onUpdateClipProperty: (index: number, prop: string, val: any) => void;
    onBack: () => void;
    audioUrl?: string | null;
    isProcessing?: boolean;
}

// Window controls from Electron (uses global electronAPI from preload)

const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const EditorView: React.FC<EditorProps> = ({
    project,
    timeline,
    onReplaceClip,
    onApproveSegment,
    onGeneratePreview,
    onExportFinal,
    onUpdateClipProperty,
    onBack,
    audioUrl,
    isProcessing
}) => {
    const [selectedSegment, setSelectedSegment] = useState<any>(null);
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);
    const [exportProgress, setExportProgress] = useState<any>(null);
    const [viewMode, setViewMode] = useState<'timeline' | 'preview' | 'export'>('timeline');

    // Scraper & Zip Control
    const handleScraperAction = (action: string) => {
        if ((window as any).electron) (window as any).electron.invoke('scraper-window-control', action);
    };

    const handleExportAudio = async () => {
        // Export audio segments as individual .wav files in a ZIP
        if (!segments || segments.length === 0) return;

        try {
            // Dynamically import JSZip
            const JSZip = (await import('jszip')).default;
            const zip = new JSZip();

            for (let idx = 0; idx < segments.length; idx++) {
                const seg = segments[idx];
                if (!seg.blobUrl) continue;

                // Fetch the blob from the blobUrl
                const response = await fetch(seg.blobUrl);
                const blob = await response.blob();

                // Create filename: segment_01_TITLE.wav
                const title = (seg.headline || seg.title || 'segment').replace(/[^a-z0-9]/gi, '_').substring(0, 30);
                const filename = `segment_${String(idx + 1).padStart(2, '0')}_${title}.wav`;

                zip.file(filename, blob);
            }

            // Generate and download ZIP
            const zipBlob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${project?.name || 'audio_segments'}_${new Date().toISOString().slice(0, 10)}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error('Audio export failed:', e);
        }
    };

    // Playback state
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [isDraggingPlayhead, setIsDraggingPlayhead] = useState(false);

    // Timeline state
    const [timelineHeight, setTimelineHeight] = useState(180);
    const [isResizingTimeline, setIsResizingTimeline] = useState(false);
    const [zoomLevel, setZoomLevel] = useState(100);

    const videoRef = useRef<HTMLVideoElement>(null);
    const timelineRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);
    const playbackIntervalRef = useRef<number | null>(null);

    const segments = timeline?.segments || [];

    // Calculate totalDuration: prefer last segment's end_time, fallback to sum of durations
    const computeTotalDuration = (): number => {
        if (segments.length === 0) return 1; // Avoid div by 0
        const lastSeg = segments[segments.length - 1];
        const endFromLast = lastSeg?.end_time || lastSeg?.endTime;
        if (endFromLast && endFromLast > 0) return endFromLast;
        // Fallback: sum durations
        return segments.reduce((acc: number, s: any) => acc + (s.duration || 0), 0) || 1;
    };
    const totalDuration = computeTotalDuration();

    // Calculate timeline width based on zoom (100% to 500%)
    const timelineWidth = Math.max(100, zoomLevel);

    // Track pixel width for waveform (reactive to zoom)
    const [waveformPixelWidth, setWaveformPixelWidth] = useState(1000);

    // Initial selection + Update waveform width on mount/zoom
    useEffect(() => {
        if (!selectedSegment && segments.length > 0) {
            setSelectedSegment(segments[0]);
        }
        // Update waveform pixel width
        const wrapper = timelineRef.current?.querySelector('.timeline-tracks-wrapper');
        if (wrapper) {
            setWaveformPixelWidth(wrapper.scrollWidth);
        }
    }, [segments, selectedSegment, zoomLevel]);

    // Find segment at given time (using absolute timestamps)
    const findSegmentAtTime = useCallback((time: number) => {
        for (const seg of segments) {
            const start = seg.start_time ?? seg.startTime ?? 0;
            const end = seg.end_time ?? seg.endTime ?? (start + (seg.duration || 0));

            if (time >= start && time < end) {
                return { segment: seg, offset: time - start };
            }
        }
        return null;
    }, [segments]);

    // Get segment start time (Prefer absolute, fallback to cumulative)
    const getSegmentStartTime = useCallback((index: number) => {
        const seg = segments[index];
        // Try absolute time first
        const absTime = seg?.start_time ?? seg?.startTime;
        if (absTime !== undefined && absTime !== null) return absTime;

        // Fallback: cumulative sum of previous segments
        let cumulative = 0;
        for (let i = 0; i < index && i < segments.length; i++) {
            cumulative += segments[i].duration || 0;
        }
        return cumulative;
    }, [segments]);

    const audioRef = useRef<HTMLAudioElement>(null);

    // Sync Playback State (Master -> Audio Element)
    useEffect(() => {
        if (!audioRef.current) return;
        if (isPlaying) {
            audioRef.current.play().catch(e => console.warn("Audio play failed:", e));
        } else {
            audioRef.current.pause();
        }
    }, [isPlaying]);

    // Sync Audio Time (User Scrub -> Audio Element)
    useEffect(() => {
        if (!audioRef.current) return;
        // Only seek if difference is significant to avoid fighting updates
        if (Math.abs(audioRef.current.currentTime - currentTime) > 0.5) {
            audioRef.current.currentTime = currentTime;
        }
    }, [currentTime]);

    // Handle Audio Events (Audio Element -> State)
    const handleAudioTimeUpdate = () => {
        if (audioRef.current && !isDraggingPlayhead) {
            setCurrentTime(audioRef.current.currentTime);
        }
    };

    const handleAudioEnded = () => {
        setIsPlaying(false);
        setCurrentTime(0); // Reset to start
        if (audioRef.current) audioRef.current.currentTime = 0;
    };

    // Update selected segment when currentTime changes
    useEffect(() => {
        const result = findSegmentAtTime(currentTime);
        if (result && result.segment) {
            if (selectedSegment?.index !== result.segment.index) {
                setSelectedSegment(result.segment);
            }
            if (videoRef.current && result.segment.video) {
                const videoTime = result.offset;
                if (Math.abs(videoRef.current.currentTime - videoTime) > 0.1) { // Tightened sync threshold
                    videoRef.current.currentTime = videoTime;
                }
                if (isPlaying && videoRef.current.paused) {
                    videoRef.current.play();
                } else if (!isPlaying && !videoRef.current.paused) {
                    videoRef.current.pause();
                }
            }
        }
    }, [currentTime, findSegmentAtTime, isPlaying, selectedSegment?.index]);

    // Timeline resize handlers
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizingTimeline(true);
        const startY = e.clientY;
        const startHeight = timelineHeight;

        const handleMouseMove = (e: MouseEvent) => {
            const delta = startY - e.clientY;
            const newHeight = Math.min(300, Math.max(120, startHeight + delta));
            setTimelineHeight(newHeight);
        };

        const handleMouseUp = () => {
            setIsResizingTimeline(false);
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [timelineHeight]);

    const handleSegmentClick = (segment: any) => {
        setSelectedSegment(segment);
        const startTime = getSegmentStartTime(segment.index);
        setCurrentTime(startTime);
    };

    const handleApprove = (index: number) => {
        onApproveSegment(index);
        const next = segments.find((s: any) => s.index > index && s.status !== 'approved');
        if (next) setSelectedSegment(next);
    };

    const handleFullPreview = async () => {
        setViewMode('preview');
        try {
            const url = await onGeneratePreview();
            setPreviewUrl(url);
        } catch (err) {
            console.error('Preview generation failed:', err);
        }
    };

    const handlePlayPause = () => {
        setIsPlaying(!isPlaying);
    };

    const handleTimelineClick = (e: React.MouseEvent<HTMLDivElement>) => {
        if (!scrollContainerRef.current || isDraggingPlayhead) return;

        const rect = e.currentTarget.getBoundingClientRect();
        const scrollLeft = scrollContainerRef.current.scrollLeft;
        const x = e.clientX - rect.left + scrollLeft - 50; // Subtract track label width
        const containerWidth = e.currentTarget.scrollWidth - 50;
        const clickedTime = (x / containerWidth) * totalDuration;

        setCurrentTime(Math.max(0, Math.min(clickedTime, totalDuration)));
    };

    const handlePlayheadDrag = useCallback((e: MouseEvent) => {
        if (!scrollContainerRef.current || !timelineRef.current) return;

        const tracksWrapper = timelineRef.current.querySelector('.timeline-tracks-wrapper');
        if (!tracksWrapper) return;

        const rect = tracksWrapper.getBoundingClientRect();
        const x = e.clientX - rect.left - 50;
        const containerWidth = (tracksWrapper as HTMLElement).scrollWidth - 50;
        const newTime = (x / containerWidth) * totalDuration;

        setCurrentTime(Math.max(0, Math.min(newTime, totalDuration)));
    }, [totalDuration]);

    const handlePlayheadMouseUp = useCallback(() => {
        setIsDraggingPlayhead(false);
        document.removeEventListener('mousemove', handlePlayheadDrag);
        document.removeEventListener('mouseup', handlePlayheadMouseUp);
    }, [handlePlayheadDrag]);

    const handlePlayheadMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        setIsDraggingPlayhead(true);
        document.addEventListener('mousemove', handlePlayheadDrag);
        document.addEventListener('mouseup', handlePlayheadMouseUp);
    };

    // Keyboard Shortcuts (Space to Toggle Play)
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.code === 'Space' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA') {
                e.preventDefault();
                setIsPlaying(prev => !prev);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, []);

    // Window controls
    const handleMinimize = () => window.electronAPI?.minimize();
    const handleMaximize = () => window.electronAPI?.maximize();
    const handleClose = () => window.electronAPI?.close();

    // Zoom controls
    const handleZoomIn = () => setZoomLevel(prev => Math.min(500, prev + 25));
    const handleZoomOut = () => setZoomLevel(prev => Math.max(100, prev - 25));

    const handleWheelZoom = (e: React.WheelEvent) => {
        if ((e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -10 : 10;
            setZoomLevel(prev => Math.min(500, Math.max(100, prev + delta)));
        }
    };

    const playheadPosition = (currentTime / totalDuration) * 100;
    const currentSegmentInfo = findSegmentAtTime(currentTime);

    return (
        <div className="video-editor">
            {/* OVERLAY WARNING */}
            {isProcessing && (
                <div style={{
                    position: 'absolute', top: 0, left: 0, right: 0,
                    background: 'rgba(20, 0, 0, 0.9)', color: '#FF453A',
                    padding: '12px', textAlign: 'center', zIndex: 9999,
                    borderBottom: '1px solid #FF453A', fontWeight: 600,
                    userSelect: 'none'
                }}>
                    ⚠️ IMPORTANTE: NO toques, minimices ni cierres esta ventana del navegador. La aplicación la necesita abierta para scrapear y procesar correctamente.
                </div>
            )}

            {/* TitleBar for consistent window controls */}
            <TitleBar />

            {/* Master Audio Element */}
            {audioUrl && (
                <audio
                    ref={audioRef}
                    src={audioUrl}
                    onTimeUpdate={handleAudioTimeUpdate}
                    onEnded={handleAudioEnded}
                    onPause={() => setIsPlaying(false)}
                    onPlay={() => setIsPlaying(true)}
                />
            )}

            {/* HEADER */}
            <header className="editor-header" style={{ marginTop: '32px' }}>
                <div className="header-left">
                    <button onClick={onBack} className="back-btn">
                        <ChevronLeftIcon /> Back
                    </button>
                    <div className="project-info">
                        <h1>{project?.name || "Untitled"}</h1>
                        <span className="duration">{formatTime(totalDuration)}</span>
                    </div>
                </div>

                <div className="header-center">
                    <button
                        onClick={handleFullPreview}
                        className="btn-preview"
                        disabled={!segments.some((s: any) => s.video)}
                    >
                        Preview
                    </button>
                    <button
                        onClick={async () => {
                            setViewMode('export');
                            await onExportFinal((p) => setExportProgress(p));
                        }}
                        className="btn-export"
                        disabled={!segments.every((s: any) => s.status === 'approved')}
                    >
                        Export
                    </button>
                </div>

                {/* Header Right: Audio Export */}
                <div className="header-right" style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                    <button onClick={handleExportAudio} className="btn-secondary" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <ArrowDownTrayIcon width={16} /> Audio
                    </button>
                </div>
            </header>

            {/* MAIN */}
            <div className="editor-main">
                {/* LEFT: Segments */}
                <aside className="segments-panel">
                    <h2>Segments</h2>
                    <div className="segments-list">
                        {segments.map((seg: any) => (
                            <div key={seg.index}
                                className={`segment-item ${seg.status} ${selectedSegment?.index === seg.index ? 'selected' : ''}`}
                                onClick={() => handleSegmentClick(seg)}
                            >
                                <div className="segment-header">
                                    <span className="segment-number">#{seg.index + 1}</span>
                                    {seg.status === 'searching' && <span className="loader-spin"></span>}
                                    {seg.status === 'pending' && <span className="status-dot" style={{ background: '#555' }}></span>}
                                    {(seg.status === 'found' || seg.video) && <span className="status-dot found"></span>}
                                    {seg.status === 'approved' && <span className="status-dot" style={{ background: '#30D158' }}></span>}
                                    {seg.status === 'error' && <span className="status-dot error"></span>}
                                </div>
                                <h3 className="segment-headline">{seg.headline}</h3>
                                <div className="segment-meta">
                                    <span>{seg.duration?.toFixed(1)}s</span>
                                    {seg.status === 'pending' && <span style={{ color: '#666' }}>Waiting</span>}
                                    {seg.status === 'searching' && <span style={{ color: '#FFD60A' }}>Searching</span>}
                                    {(seg.status === 'found' || seg.video) && <span style={{ color: '#30D158' }}>Ready</span>}
                                    {seg.status === 'approved' && <span style={{ color: '#30D158' }}>Approved</span>}
                                    {seg.status === 'error' && <span style={{ color: '#FF453A' }}>Error</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                </aside>

                {/* CENTER: Preview */}
                <main className="preview-panel">
                    {viewMode === 'timeline' && selectedSegment && (
                        <div className="segment-preview">
                            <div className="preview-video-container">
                                {selectedSegment.video ? (
                                    <video
                                        ref={videoRef}
                                        src={selectedSegment.video.previewUrl}
                                        controls
                                        key={selectedSegment.video.previewUrl}
                                        muted // Mute video segments, master audio provides sound
                                    />
                                ) : (
                                    <div className="no-video">
                                        {selectedSegment.status === 'searching' ? (
                                            <>
                                                <div className="loader-spin" style={{ width: 32, height: 32, borderWidth: 3 }}></div>
                                                <p style={{ marginTop: 12, color: '#888' }}>Finding video for "{selectedSegment.headline}"</p>
                                            </>
                                        ) : (
                                            <>
                                                <FilmIcon style={{ width: 40, height: 40, color: '#444' }} />
                                                <p style={{ color: '#555' }}>No video yet</p>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>

                            <div className="preview-info">
                                <h2>{selectedSegment.headline}</h2>
                                <p>{selectedSegment.text?.slice(0, 200)}...</p>
                            </div>

                            <div className="preview-actions">
                                {selectedSegment.video && selectedSegment.status !== 'approved' && (
                                    <>
                                        <button onClick={() => handleApprove(selectedSegment.index)} className="btn-approve">
                                            Approve
                                        </button>
                                        <button onClick={() => onReplaceClip(selectedSegment.index)} className="btn-alternative">
                                            Replace
                                        </button>
                                    </>
                                )}
                                {selectedSegment.status === 'approved' && (
                                    <div className="approved-badge">✓ Approved</div>
                                )}
                            </div>
                        </div>
                    )}

                    {viewMode === 'preview' && (
                        <div className="segment-preview" style={{ width: '100%', height: '100%' }}>
                            <div className="preview-video-container" style={{ flex: 1 }}>
                                {previewUrl ? (
                                    <video src={previewUrl} controls autoPlay style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                                ) : (
                                    <div className="no-video">
                                        <div className="loader-spin" style={{ width: 40, height: 40, borderWidth: 3 }}></div>
                                        <p style={{ marginTop: 12, color: '#888' }}>Rendering preview...</p>
                                    </div>
                                )}
                            </div>
                            <div className="preview-actions" style={{ marginTop: 16 }}>
                                <button onClick={() => setViewMode('timeline')} className="btn-alternative">
                                    Close Preview
                                </button>
                            </div>
                        </div>
                    )}

                    {viewMode === 'export' && (
                        <div className="export-view">
                            <h2>Exporting...</h2>
                            {exportProgress ? (
                                <div style={{ width: '100%', maxWidth: 350 }}>
                                    <div className="progress-bar-container">
                                        <div className="progress-bar-fill" style={{ width: `${exportProgress.percent}%` }} />
                                    </div>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#888' }}>
                                        <span>{exportProgress.stage}</span>
                                        <span>{Math.round(exportProgress.percent)}%</span>
                                    </div>
                                    {exportProgress.stage === 'complete' && (
                                        <div style={{ marginTop: 24, textAlign: 'center' }}>
                                            <p style={{ color: '#30D158', fontWeight: 600, marginBottom: 12 }}>Export Complete!</p>
                                            <button onClick={onBack} className="btn-approve">Done</button>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="loader-spin" style={{ width: 40, height: 40, borderWidth: 3 }}></div>
                            )}
                        </div>
                    )}
                </main>
            </div>

            {/* LOGS PANEL */}
            <div className={`logs-panel ${viewMode !== 'timeline' ? 'hidden' : ''}`}>
                <div className="logs-header">
                    <h3>Logs</h3>
                    <span className="live-indicator">LIVE</span>
                </div>
                <div className="logs-content">
                    {(project?.logs || []).slice().reverse().slice(0, 20).map((log: string, i: number) => (
                        <div key={i} className="log-entry">
                            <span className="log-time">{new Date().toLocaleTimeString().slice(0, 5)}</span>
                            <span className="log-msg">{log}</span>
                        </div>
                    ))}
                    {(project?.logs || []).length === 0 && (
                        <div className="log-entry" style={{ opacity: 0.5 }}>Waiting for activity...</div>
                    )}
                </div>
            </div>

            {/* FOOTER: Interactive Timeline */}
            <footer className="timeline-footer" style={{ height: timelineHeight }} ref={timelineRef}>
                {/* Resize Handle */}
                <div
                    className={`timeline-resize-handle ${isResizingTimeline ? 'active' : ''}`}
                    onMouseDown={handleResizeStart}
                />

                {/* Timeline Controls */}
                <div className="timeline-controls">
                    <button
                        className="play-btn"
                        onClick={handlePlayPause}
                        disabled={!segments.some((s: any) => s.video)}
                    >
                        {isPlaying ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <span className="current-time">{formatTime(currentTime)}</span>
                    <span className="timeline-divider">/</span>
                    <span className="total-time">{formatTime(totalDuration)}</span>

                    {currentSegmentInfo && (
                        <span className="segment-info">
                            <strong>#{currentSegmentInfo.segment.index + 1}</strong> {currentSegmentInfo.segment.headline}
                        </span>
                    )}

                    <div className="zoom-controls">
                        <button className="zoom-btn" onClick={handleZoomOut} title="Zoom Out">
                            <MinusIcon style={{ width: 12, height: 12 }} />
                        </button>
                        <span className="zoom-level">{zoomLevel}%</span>
                        <button className="zoom-btn" onClick={handleZoomIn} title="Zoom In">
                            <PlusIcon style={{ width: 12, height: 12 }} />
                        </button>
                    </div>
                </div>

                {/* Timeline Scroll Container */}
                <div className="timeline-scroll-container" ref={scrollContainerRef}>
                    <div
                        className="timeline-tracks-wrapper"
                        style={{ width: `${timelineWidth}%` }}
                        onClick={handleTimelineClick}
                        onWheel={handleWheelZoom}
                    >
                        {/* Playhead */}
                        <div
                            className={`playhead ${isDraggingPlayhead ? 'dragging' : ''}`}
                            style={{ left: `${playheadPosition}%` }}
                            onMouseDown={handlePlayheadMouseDown}
                        />

                        {/* Time Ruler */}
                        <div className="timeline-ruler">
                            {Array.from({ length: Math.ceil(totalDuration / 10) + 1 }).map((_, i) => (
                                <span key={i} className="time-marker">{formatTime(i * 10)}</span>
                            ))}
                        </div>

                        {/* Video Track */}
                        <div className="track-row" style={{ height: 50, background: 'rgba(0,0,0,0.2)' }}>
                            <div className="track-label" style={{ color: '#888' }}>Video</div>
                            <div className="track-content">
                                {segments.map((seg: any) => {
                                    const startPct = (getSegmentStartTime(seg.index) / totalDuration) * 100;
                                    const widthPct = ((seg.duration || 0) / totalDuration) * 100;
                                    const isActive = selectedSegment?.index === seg.index;
                                    return (
                                        <div
                                            key={seg.index}
                                            className={`timeline-clip video-clip ${seg.video ? 'has-video' : 'empty'} ${isActive ? 'active' : ''}`}
                                            style={{
                                                position: 'absolute',
                                                left: `${startPct}%`,
                                                width: `${widthPct}%`,
                                                height: '100%',
                                                background: seg.video ? '#2a2a35' : '#1a1a1f',
                                                borderLeft: '1px solid rgba(255,255,255,0.2)',
                                                borderRight: '1px solid rgba(0,0,0,0.3)',
                                                overflow: 'hidden',
                                                cursor: 'pointer',
                                                boxShadow: isActive ? 'inset 0 0 0 2px #ff0055' : 'none'
                                            }}
                                            onClick={(e) => { e.stopPropagation(); handleSegmentClick(seg); }}
                                        >
                                            {/* Segment Label with Title */}
                                            <div style={{
                                                position: 'absolute',
                                                top: 0,
                                                left: 0,
                                                right: 0,
                                                bottom: 0,
                                                padding: '4px 6px',
                                                display: 'flex',
                                                flexDirection: 'column',
                                                justifyContent: 'center',
                                                background: seg.video ? 'rgba(0,0,0,0.5)' : 'transparent',
                                                zIndex: 2
                                            }}>
                                                <span style={{
                                                    fontSize: 9,
                                                    fontWeight: 700,
                                                    color: isActive ? '#ff0055' : '#888',
                                                    marginBottom: 2
                                                }}>
                                                    #{seg.index + 1}
                                                </span>
                                                <span style={{
                                                    fontSize: 10,
                                                    fontWeight: 500,
                                                    color: seg.video ? '#fff' : '#666',
                                                    whiteSpace: 'nowrap',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    textShadow: '0 1px 2px rgba(0,0,0,0.9)'
                                                }}>
                                                    {seg.headline || seg.title || ''}
                                                </span>
                                            </div>
                                            {seg.video && (
                                                <img src={seg.video.thumbnail} alt="" style={{
                                                    position: 'absolute',
                                                    top: 0,
                                                    left: 0,
                                                    width: '100%',
                                                    height: '100%',
                                                    objectFit: 'cover',
                                                    opacity: 0.4,
                                                    zIndex: 1
                                                }} />
                                            )}
                                        </div>
                                    );
                                })}
                            </div>
                        </div>

                        {/* Audio Track (Waveform) */}
                        <div className="track-row" style={{ height: 55, position: 'relative', background: 'rgba(0,0,0,0.1)' }}>
                            <div className="track-label" style={{ color: '#888' }}>Audio</div>
                            <div className="track-content" style={{ position: 'relative' }}>
                                {/* Canvas Waveform Layer */}
                                <div style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0 }}>
                                    {audioUrl && (
                                        <WaveformTrack
                                            audioUrl={audioUrl}
                                            width={waveformPixelWidth}
                                            height={55}
                                            duration={totalDuration}
                                        />
                                    )}
                                </div>

                                {/* Segment Dividers with Labels */}
                                {segments.map((seg: any) => {
                                    const startPct = (getSegmentStartTime(seg.index) / totalDuration) * 100;
                                    const widthPct = ((seg.duration || 0) / totalDuration) * 100;
                                    const isActive = selectedSegment?.index === seg.index;
                                    return (
                                        <div
                                            key={seg.index}
                                            style={{
                                                position: 'absolute',
                                                left: `${startPct}%`,
                                                width: `${widthPct}%`,
                                                height: '100%',
                                                background: isActive ? 'rgba(255, 0, 85, 0.25)' : 'transparent',
                                                borderLeft: '1px solid rgba(255,255,255,0.4)',
                                                zIndex: 1,
                                                cursor: 'pointer',
                                                boxSizing: 'border-box'
                                            }}
                                            onClick={(e) => { e.stopPropagation(); handleSegmentClick(seg); }}
                                        >
                                            {/* Segment Label with Title */}
                                            <div style={{
                                                position: 'absolute',
                                                top: 2,
                                                left: 4,
                                                right: 4,
                                                display: 'flex',
                                                gap: 4,
                                                alignItems: 'center'
                                            }}>
                                                <span style={{
                                                    fontSize: 9,
                                                    fontWeight: 700,
                                                    color: isActive ? '#ff0055' : 'rgba(255,255,255,0.7)',
                                                    textShadow: '0 1px 2px rgba(0,0,0,0.9)',
                                                    flexShrink: 0
                                                }}>
                                                    #{seg.index + 1}
                                                </span>
                                                <span style={{
                                                    fontSize: 9,
                                                    color: 'rgba(255,255,255,0.5)',
                                                    whiteSpace: 'nowrap',
                                                    overflow: 'hidden',
                                                    textOverflow: 'ellipsis',
                                                    textShadow: '0 1px 2px rgba(0,0,0,0.9)'
                                                }}>
                                                    {seg.headline || seg.title || ''}
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    </div>
                </div>
            </footer>
        </div>
    );
};
