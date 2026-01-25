import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ExportModal, ExportOptions } from './ExportModal';
import {
    FilmIcon,
    PlayIcon,
    PauseIcon,
    ChevronLeftIcon,
    ArrowDownTrayIcon,
    CommandLineIcon,
    CheckCircleIcon
} from '@heroicons/react/24/solid';
import TitleBar from '../TitleBar';
import TimelineCanvas, { TimelineSegment } from './TimelineCanvas';
import { useAudioSync } from '../../hooks/useAudioSync';
import { AudioClip } from '../../types';
import './editor.css';

// Types
interface StoryBlockForExport {
    title: string;
    blobUrl: string;
}

interface EditorProps {
    project: any;
    timeline: any;
    storyBlocks?: StoryBlockForExport[]; // Direct access to processed blocks for export
    onReplaceClip: (segmentIndex: number) => void;
    onApproveSegment: (segmentIndex: number) => void;
    onExportFinal: (options: ExportOptions, cb: (p: any) => void) => Promise<string>;
    onUpdateClipProperty: (index: number, prop: string, val: any) => void;
    onBack: () => void;
    audioUrl?: string | null;
    audioFilePath?: string; // New prop for export
    audioClips?: AudioClip[];
    onUpdateAudioClip?: (id: string, updates: Partial<AudioClip>) => void;
    isProcessing?: boolean;
}

const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const EditorView: React.FC<EditorProps> = ({
    project,
    timeline,
    storyBlocks,
    onReplaceClip,
    onApproveSegment,
    onExportFinal,
    onUpdateClipProperty,
    onBack,
    audioUrl,
    audioFilePath,
    audioClips,
    onUpdateAudioClip,
    isProcessing
}) => {
    const [selectedSegmentIndex, setSelectedSegmentIndex] = useState<number | null>(null);
    const [exportProgress, setExportProgress] = useState<any>(null);
    const [viewMode, setViewMode] = useState<'timeline' | 'export'>('timeline');
    const [timelineHeight, setTimelineHeight] = useState(180);
    const [isResizingTimeline, setIsResizingTimeline] = useState(false);
    const [showExportModal, setShowExportModal] = useState(false);
    const [showConsole, setShowConsole] = useState(false);



    const videoRef = useRef<HTMLVideoElement>(null);
    const wasPlayingRef = useRef(false); // Track play state during interactions

    // Use the new Web Audio API-based hook for precise sync
    const {
        currentTime,
        duration,
        isPlaying,
        isLoading,
        isReady,
        play,
        pause,
        playPause,
        seek,
        audioBuffer // Unified buffer
    } = useAudioSync(audioUrl || null, audioClips);

    // Convert timeline segments to TimelineSegment format
    const segments: TimelineSegment[] = (timeline?.segments || []).map((seg: any, idx: number) => ({
        index: seg.index ?? idx,
        title: seg.title,
        headline: seg.headline,
        text: seg.text,
        start_time: seg.start_time ?? seg.startTime ?? 0,
        end_time: seg.end_time ?? seg.endTime ?? 0,
        duration: seg.duration || ((seg.end_time ?? seg.endTime ?? 0) - (seg.start_time ?? seg.startTime ?? 0)),
        blobUrl: seg.blobUrl,
        video: seg.video,
        status: seg.status
    }));

    // Calculate totalDuration from segments or audio
    const computedDuration = duration > 0 ? duration : (segments.length > 0
        ? segments[segments.length - 1].end_time
        : 1);

    const selectedSegment = selectedSegmentIndex !== null
        ? segments.find(seg => seg.index === selectedSegmentIndex) || null
        : null;

    // Initial selection
    useEffect(() => {
        if (selectedSegmentIndex === null && segments.length > 0) {
            setSelectedSegmentIndex(segments[0].index);
        }
    }, [segments, selectedSegmentIndex]);

    // Find segment at current time and sync video
    useEffect(() => {
        const seg = segments.find(s =>
            currentTime >= s.start_time && currentTime < s.end_time
        );

        if (seg && seg.index !== selectedSegmentIndex) {
            setSelectedSegmentIndex(seg.index);
        }

        // Sync video preview
        if (selectedSegment?.video && videoRef.current) {
            const videoTime = currentTime - selectedSegment.start_time;
            // Tighten sync threshold to ~1 frame (30fps)
            if (Math.abs(videoRef.current.currentTime - videoTime) > 0.04) {
                videoRef.current.currentTime = Math.max(0, videoTime);
            }
            if (isPlaying && videoRef.current.paused) {
                videoRef.current.play().catch(() => { });
            } else if (!isPlaying && !videoRef.current.paused) {
                videoRef.current.pause();
            }
        }
    }, [currentTime, isPlaying, segments, selectedSegment]);

    // Scraper window control
    const handleScraperAction = (action: string) => {
        if ((window as any).electron) {
            (window as any).electron.invoke('scraper-window-control', action);
        }
    };

    // Sync Audio Path with Backend
    // Use audioFilePath if available (for export), otherwise fall back to url if path is embedded
    useEffect(() => {
        const pathToSend = audioFilePath;
        if (pathToSend && window.electron) {
            console.log("[EditorView] Syncing audio path to backend:", pathToSend);
            window.electron.invoke('smart-set-audio', pathToSend)
                .then(() => console.log("[EditorView] Audio path synced successfully"))
                .catch((err: any) => console.error("[EditorView] Failed to sync audio path:", err));
        } else if (!pathToSend) {
            console.warn("[EditorView] No audioFilePath available for sync!");
        }
    }, [audioFilePath]);

    // Export audio as ZIP - Uses storyBlocks prop for reliable blobUrls
    const handleExportAudio = async () => {
        // Use storyBlocks (direct from App.tsx) if available, otherwise fall back to segments
        const blocksToExport = storyBlocks && storyBlocks.length > 0 ? storyBlocks : segments;

        console.log('[EditorView] handleExportAudio called.');
        console.log('[EditorView] storyBlocks available:', storyBlocks?.length ?? 0);
        console.log('[EditorView] segments available:', segments.length);
        console.log('[EditorView] Using source:', storyBlocks && storyBlocks.length > 0 ? 'storyBlocks' : 'segments');

        if (!blocksToExport || blocksToExport.length === 0) {
            console.error('[EditorView] No blocks to export!');
            alert('No audio segments available to export.');
            return;
        }

        try {
            const JSZip = (await import('jszip')).default;
            const zip = new JSZip();
            let addedFiles = 0;

            for (let idx = 0; idx < blocksToExport.length; idx++) {
                const block = blocksToExport[idx];
                const blobUrl = (block as any).blobUrl;

                console.log(`[EditorView] Block ${idx}: blobUrl =`, blobUrl);

                if (!blobUrl) {
                    console.warn(`[EditorView] Block ${idx} has no blobUrl, skipping`);
                    continue;
                }

                const response = await fetch(blobUrl);
                const blob = await response.blob();
                console.log(`[EditorView] Block ${idx} blob size:`, blob.size);

                // Create filename
                const title = ((block as any).title || (block as any).headline || 'segment')
                    .replace(/[^a-z0-9]/gi, '_')
                    .substring(0, 30);
                const filename = `segment_${String(idx + 1).padStart(2, '0')}_${title}.wav`;

                zip.file(filename, blob);
                addedFiles++;
            }

            console.log(`[EditorView] Added ${addedFiles} files to zip`);

            if (addedFiles === 0) {
                console.error('[EditorView] No files were added to zip!');
                alert('Error: No audio segments with valid URLs found. Please ensure processing is complete.');
                return;
            }

            const zipBlob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(zipBlob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `${project?.name || 'audio_segments'}_${new Date().toISOString().slice(0, 10)}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('[EditorView] Zip downloaded successfully with', addedFiles, 'files');
        } catch (e) {
            console.error('Audio export failed:', e);
            alert('Export failed: ' + (e as Error).message);
        }
    };



    // Timeline resize
    const handleResizeStart = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizingTimeline(true);
        const startY = e.clientY;
        const startHeight = timelineHeight;

        const handleMouseMove = (e: MouseEvent) => {
            const delta = startY - e.clientY;
            const newHeight = Math.min(350, Math.max(120, startHeight + delta));
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

    // Segment click handler - pauses and jumps to segment start
    const handleSegmentClick = (segment: TimelineSegment) => {
        setSelectedSegmentIndex(segment.index);
        // Pause if playing (same logic as clicking timeline)
        pause();
        // Jump playhead to the start of this segment
        seek(segment.start_time);
    };



    // Approve segment
    const handleApprove = (index: number) => {
        onApproveSegment(index);
        // Find next non-approved segment
        const next = segments.find(s => s.index > index && s.status !== 'approved');

        if (next) {
            setSelectedSegmentIndex(next.index);
            // Auto-advance playhead to next segment for immediate preview
            seek(next.start_time);

            // Scroll to next segment in sidebar
            setTimeout(() => {
                const el = document.getElementById(`segment-item-${next.index}`);
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
            }, 100);
        }
    };

    // Keyboard shortcuts
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (document.activeElement?.tagName === 'INPUT' ||
                document.activeElement?.tagName === 'TEXTAREA') {
                return;
            }
            
            if (e.code === 'Space') {
                e.preventDefault();
                playPause();
            }
            
            // Enter to approve current segment
            if (e.code === 'Enter' && selectedSegment?.video && selectedSegment.status !== 'approved') {
                e.preventDefault();
                handleApprove(selectedSegment.index);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [playPause, selectedSegment]);

    // Find current segment info
    const currentSegmentInfo = segments.find(s =>
        currentTime >= s.start_time && currentTime < s.end_time
    );

    // Calculate approval progress
    const approvedCount = segments.filter(s => s.status === 'approved').length;
    const totalSegments = segments.length;
    const allApproved = totalSegments > 0 && approvedCount === totalSegments;

    // Interaction Handlers for smooth scrubbing
    const handleInteractionStart = useCallback(() => {
        wasPlayingRef.current = isPlaying;
        if (isPlaying) {
            pause();
        }
    }, [isPlaying, pause]);

    const handleInteractionEnd = useCallback(() => {
        if (wasPlayingRef.current) {
            play();
        }
    }, [play]);

    return (
        <div className="video-editor">
            {/* Processing warning removed - now handled by ProcessingHero in App.tsx */}


            {/* TitleBar */}
            <TitleBar />

            {/* HEADER */}
            <header className="editor-header" style={{ marginTop: '32px' }}>
                <div className="header-left">
                    <button onClick={onBack} className="back-btn" title="Back to projects">
                        <ChevronLeftIcon />
                    </button>
                    <div className="header-divider" />
                    <div className="project-info">
                        <h1>{project?.name || "Untitled"}</h1>
                        <span className="duration">{formatTime(computedDuration)}</span>
                    </div>
                </div>

                {/* Center: Project Status */}
                <div className="header-center">
                    <div className={`project-status ${allApproved ? 'complete' : ''}`}>
                        {allApproved ? (
                            <>
                                <CheckCircleIcon className="status-icon complete" />
                                <span>Ready to export</span>
                            </>
                        ) : (
                            <>
                                <div className="status-progress">
                                    <div 
                                        className="status-progress-fill" 
                                        style={{ width: `${totalSegments > 0 ? (approvedCount / totalSegments) * 100 : 0}%` }} 
                                    />
                                </div>
                                <span className="status-text">{approvedCount} / {totalSegments} approved</span>
                            </>
                        )}
                    </div>
                </div>

                <div className="header-right">
                    <button onClick={handleExportAudio} className="btn-audio" title="Download audio segments">
                        <ArrowDownTrayIcon />
                        <span>Audio</span>
                    </button>
                    <div className="export-btn-wrapper">
                        <button
                            onClick={() => setShowExportModal(true)}
                            className={`btn-export ${!allApproved ? 'disabled' : ''}`}
                            disabled={!allApproved}
                        >
                            Export
                        </button>
                        {!allApproved && (
                            <div className="export-tooltip">
                                Approve all segments to export
                            </div>
                        )}
                    </div>
                </div>

            </header>

            {/* MAIN */}
            <div className="editor-main">
                {/* LEFT: Segments */}
                <aside className="segments-panel">
                    <div className="segments-panel-header">
                        <h2>Segments</h2>
                        <span className="segments-count">{approvedCount}/{totalSegments}</span>
                    </div>
                    {/* Overall progress bar */}
                    <div className="segments-progress-bar">
                        <div 
                            className="segments-progress-fill" 
                            style={{ width: `${totalSegments > 0 ? (approvedCount / totalSegments) * 100 : 0}%` }}
                        />
                    </div>
                    <div className="segments-list">
                        {segments.map((seg) => (
                            <div key={seg.index} id={`segment-item-${seg.index}`}
                                className={`segment-item ${seg.status} ${selectedSegmentIndex === seg.index ? 'selected' : ''}`}
                                onClick={() => handleSegmentClick(seg)}
                            >
                                {/* Mini thumbnail */}
                                <div className="segment-thumbnail">
                                    {seg.video?.previewUrl ? (
                                        <video 
                                            src={seg.video.previewUrl} 
                                            muted 
                                            preload="metadata"
                                            onLoadedData={(e) => {
                                                // Seek to 0.5s for a better thumbnail frame
                                                (e.target as HTMLVideoElement).currentTime = 0.5;
                                            }}
                                        />
                                    ) : (
                                        <div className="thumbnail-placeholder">
                                            {seg.status === 'searching' ? (
                                                <div className="mini-spinner" />
                                            ) : (
                                                <FilmIcon />
                                            )}
                                        </div>
                                    )}
                                    {seg.status === 'approved' && (
                                        <div className="thumbnail-approved">
                                            <CheckCircleIcon />
                                        </div>
                                    )}
                                </div>
                                <div className="segment-content">
                                    <div className="segment-header">
                                        <span className="segment-number">{seg.index + 1}</span>
                                        <span className="segment-time">{seg.duration?.toFixed(1)}s</span>
                                    </div>
                                    <h3 className="segment-headline">
                                        {seg.headline || seg.title || `Segment ${seg.index + 1}`}
                                    </h3>
                                    <div className="segment-status-label">
                                        {seg.status === 'pending' && <span className="status-pending">Waiting</span>}
                                        {seg.status === 'searching' && <span className="status-searching">Searching...</span>}
                                        {seg.status === 'found' && <span className="status-found">Ready for review</span>}
                                        {seg.status === 'approved' && <span className="status-approved">Approved</span>}
                                        {seg.status === 'error' && <span className="status-error">Error</span>}
                                    </div>
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
                                        className="segment-preview-video"
                                        src={selectedSegment.video.previewUrl}
                                        key={selectedSegment.video.previewUrl}
                                        muted
                                        playsInline
                                        preload="metadata"
                                    />
                                ) : (
                                    <div className="no-video">
                                        {selectedSegment.status === 'searching' ? (
                                            <div className="searching-state">
                                                <div className="search-spinner">
                                                    <div className="spinner-ring"></div>
                                                    <FilmIcon className="spinner-icon" />
                                                </div>
                                                <div className="search-text">
                                                    <span className="search-label">Searching for footage</span>
                                                    <span className="search-title">{selectedSegment.headline || selectedSegment.title}</span>
                                                </div>
                                            </div>
                                        ) : selectedSegment.status === 'pending' ? (
                                            <div className="pending-state">
                                                <div className="pending-icon">
                                                    <FilmIcon style={{ width: 32, height: 32, color: '#444' }} />
                                                </div>
                                                <span className="pending-text">Waiting in queue...</span>
                                            </div>
                                        ) : (
                                            <>
                                                <FilmIcon style={{ width: 40, height: 40, color: '#444' }} />
                                                <p style={{ color: '#555' }}>No video yet</p>
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>

                            <div className="preview-info-card">
                                <div className="preview-info-header">
                                    <span className="segment-badge">Segment {selectedSegment.index + 1}</span>
                                    <span className="segment-duration">{selectedSegment.duration?.toFixed(1)}s</span>
                                </div>
                                <h2 className="preview-title">{selectedSegment.headline || selectedSegment.title}</h2>
                                {selectedSegment.text && (
                                    <p className="preview-text">{selectedSegment.text.slice(0, 180)}{selectedSegment.text.length > 180 ? '...' : ''}</p>
                                )}
                            </div>

                            <div className="preview-actions">
                                {selectedSegment.video && selectedSegment.status !== 'approved' && (
                                    <>
                                        <button onClick={() => handleApprove(selectedSegment.index)} className="btn-approve">
                                            <CheckCircleIcon />
                                            <span>Approve</span>
                                        </button>
                                        <button onClick={() => onReplaceClip(selectedSegment.index)} className="btn-replace">
                                            <span>Find Different</span>
                                        </button>
                                    </>
                                )}
                                {selectedSegment.status === 'approved' && (
                                    <div className="approved-badge">
                                        <CheckCircleIcon />
                                        <span>Approved</span>
                                    </div>
                                )}
                                {!selectedSegment.video && selectedSegment.status !== 'searching' && selectedSegment.status !== 'pending' && (
                                    <button onClick={() => onReplaceClip(selectedSegment.index)} className="btn-retry">
                                        Retry Search
                                    </button>
                                )}
                            </div>
                        </div>
                    )}

                    {/* Export View Removed - Now Handled in ExportModal */}
                </main>
            </div>

            {/* LOGS PANEL */}



            <ExportModal
                isOpen={showExportModal}
                onClose={() => {
                    if (!exportProgress) setShowExportModal(false); // Only close if not exporting
                }}
                onExport={async (options) => {
                    try {
                        // CRITICAL FIX: Include audioFilePath in export options
                        const exportOptions = {
                            ...options,
                            audioFilePath: audioFilePath // Pass the audio path for the backend to use
                        };
                        console.log("[EditorView] Starting export with audioFilePath:", audioFilePath);
                        await onExportFinal(exportOptions, (p) => setExportProgress(p));
                    } catch (e) {
                        console.error("Export failed", e);
                        setExportProgress({ stage: 'error', percent: 0, error: String(e) });
                    }
                }}
                projectDuration={computedDuration}
                previewImage={segments[0]?.video?.previewUrl || ''}
                segments={segments} // Pass segments for frame-by-frame preview
                isExporting={!!exportProgress}
                progress={exportProgress}
                onReset={() => {
                    setExportProgress(null);
                    setShowExportModal(false);
                }}
                onCancel={async () => {
                    // Cancel the export
                    console.log("[EditorView] Cancelling export...");
                    if ((window as any).electron) {
                        try {
                            await (window as any).electron.invoke('smart-cancel-export');
                        } catch (e) {
                            console.error("Failed to cancel export:", e);
                        }
                    }
                    setExportProgress(null);
                    setShowExportModal(false);
                }}
            />

            {/* FOOTER: Canvas-based Timeline */}
            <footer className="timeline-footer" style={{ height: timelineHeight }}>
                {/* Resize Handle */}
                <div
                    className={`timeline-resize-handle ${isResizingTimeline ? 'active' : ''}`}
                    onMouseDown={handleResizeStart}
                />

                {/* Timeline Controls */}
                <div className="timeline-controls">
                    <button
                        className="play-btn"
                        onClick={playPause}
                        disabled={!isReady && !isLoading}
                    >
                        {isPlaying ? <PauseIcon /> : <PlayIcon />}
                    </button>
                    <span className="current-time">{formatTime(currentTime)}</span>
                    <span className="timeline-divider">/</span>
                    <span className="total-time">{formatTime(computedDuration)}</span>

                    {currentSegmentInfo && (
                        <span className="segment-info">
                            <strong>#{currentSegmentInfo.index + 1}</strong> {currentSegmentInfo.headline || currentSegmentInfo.title}
                        </span>
                    )}

                    {/* Console Toggle Button */}
                    <button
                        className={`console-toggle-btn ${showConsole ? 'active' : ''}`}
                        onClick={() => setShowConsole(!showConsole)}
                        title="Toggle Console"
                    >
                        <CommandLineIcon />
                    </button>
                </div>

                {/* Canvas Timeline */}
                <div style={{ flex: 1, overflow: 'hidden' }}>
                    <TimelineCanvas
                        segments={segments}
                        currentTime={currentTime}
                        duration={computedDuration}
                        audioUrl={audioUrl || null}
                        audioClips={audioClips}
                        onUpdateAudioClip={onUpdateAudioClip}
                        audioBuffer={audioBuffer} // Pass buffer to avoid re-decode
                        selectedSegmentIndex={selectedSegmentIndex}
                        onSegmentClick={handleSegmentClick}
                        onSeek={seek}
                        onInteractionStart={handleInteractionStart}
                        onInteractionEnd={handleInteractionEnd}
                        isPlaying={isPlaying}
                        height={timelineHeight - 48}
                    />
                </div>
            </footer>

            {/* Console Window - Floating */}
            {showConsole && (
                <div className="console-window-overlay" onClick={() => setShowConsole(false)}>
                    <div className="console-window" onClick={(e) => e.stopPropagation()}>
                        <div className="console-window-header">
                            <div className="console-window-title">
                                <CommandLineIcon style={{ width: 14, height: 14 }} />
                                <span>Console</span>
                            </div>
                            <button className="console-window-close" onClick={() => setShowConsole(false)}>
                                <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
                                    <path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                                </svg>
                            </button>
                        </div>
                        <div className="console-window-content">
                            {(project?.logs || []).slice().reverse().map((log: string, i: number) => {
                                // Extract timestamp from log if present (format: [HH:MM] message)
                                const timeMatch = log.match(/^\[(\d{2}:\d{2})\]\s*/);
                                const timestamp = timeMatch ? timeMatch[1] : '--:--';
                                const message = timeMatch ? log.replace(timeMatch[0], '') : log;
                                
                                return (
                                    <div key={i} className="console-entry">
                                        <span className="console-time">{timestamp}</span>
                                        <span className={`console-msg ${message.includes('✅') ? 'success' : message.includes('❌') ? 'error' : message.includes('⚠') ? 'warn' : ''}`}>
                                            {message}
                                        </span>
                                    </div>
                                );
                            })}
                            {(project?.logs || []).length === 0 && (
                                <div className="console-entry empty">No activity yet...</div>
                            )}
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default EditorView;
