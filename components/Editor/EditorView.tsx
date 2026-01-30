import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ExportModal, ExportOptions } from './ExportModal';
import {
    FilmIcon,
    PlayIcon,
    PauseIcon,
    ChevronLeftIcon,
    ArrowDownTrayIcon,
    CommandLineIcon,
    CheckCircleIcon,
    XCircleIcon
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
    onSkipSearch: (segmentIndex: number) => void;
    onManualVideoUrl: (segmentIndex: number, videoUrl: string) => Promise<any>;
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
    onSkipSearch,
    onManualVideoUrl,
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

    // Manual Video URL State
    const [showManualUrlModal, setShowManualUrlModal] = useState(false);
    const [manualUrlInput, setManualUrlInput] = useState('');
    const [isSubmittingManual, setIsSubmittingManual] = useState(false);
    const [durationWarning, setDurationWarning] = useState<{ actual: number, required: number, segmentIndex: number, minimumRequired: number } | null>(null);

    // Overlay Status State
    const [overlayStatus, setOverlayStatus] = useState<{
        totalSegments: number;
        readyCount: number;
        isExportReady: boolean;
    }>({
        totalSegments: 0,
        readyCount: 0,
        isExportReady: false
    });

    // Refs for video control
    const videoRef = useRef<HTMLVideoElement>(null);
    const wasPlayingRef = useRef(false);

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

    // ============ PRE-RENDER OVERLAYS IN BACKGROUND ============
    // Trigger batch pre-render when editor loads with segments
    useEffect(() => {
        if (segments.length > 0 && window.electron?.invoke) {
            // Prepare segments data for pre-rendering
            const segmentsForPreRender = segments.map((seg, idx) => ({
                index: idx,
                headline: seg.headline || seg.title || '',
                title: seg.title || seg.headline || '',
                duration: seg.duration || 5,
                mandatoryCredit: (seg as any).mandatoryCredit || ''
            }));

            // Queue batch pre-render in background
            window.electron.invoke('prerender-overlays-batch', segmentsForPreRender)
                .then((result: any) => {
                    if (result?.queued > 0) {
                        console.log(`[EditorView] Pre-render queued: ${result.queued} overlays`);
                    }
                })
                .catch((err: any) => {
                    console.log('[EditorView] Pre-render batch failed:', err);
                });
        }
    }, [segments.length]); // Only run when segments array changes

    // Prioritize pre-render when user selects a segment
    useEffect(() => {
        if (selectedSegmentIndex !== null && window.electron?.invoke) {
            window.electron.invoke('prerender-prioritize-segment', selectedSegmentIndex)
                .catch(() => { }); // Ignore errors
        }
    }, [selectedSegmentIndex]);

    // ============ SEGMENT OVERLAY STATUS TRACKING ============
    useEffect(() => {
        const electron = (window as any).electron;
        if (!electron?.segmentOverlays) return;

        const checkStatus = async () => {
            try {
                const status = await electron.segmentOverlays.getStatus();
                if (status && !status.error) {
                    setOverlayStatus({
                        totalSegments: status.totalSegments,
                        readyCount: status.readyCount,
                        isExportReady: status.isExportReady
                    });
                }
            } catch (e) {
                // Ignore errors
            }
        };

        checkStatus();
        const interval = setInterval(checkStatus, 3000);

        const unsubscribe = electron.segmentOverlays.onRenderComplete(() => {
            checkStatus();
        });

        return () => {
            clearInterval(interval);
            unsubscribe();
        };
    }, []);

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
                    
                    {/* Overlay Status */}
                    {overlayStatus.totalSegments > 0 && (
                        <div className={`overlay-status ${overlayStatus.isExportReady ? 'ready' : ''}`}>
                            {overlayStatus.isExportReady ? (
                                <>
                                    <CheckCircleIcon className="overlay-icon" />
                                    <span>Segments ready</span>
                                </>
                            ) : (
                                <>
                                    <div className="overlay-spinner" />
                                    <span>{overlayStatus.readyCount}/{overlayStatus.totalSegments} segments</span>
                                </>
                            )}
                        </div>
                    )}
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
                                        {(seg.status === 'error' || seg.status === 'error_handled') && <span className="status-error">Error</span>}
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
                                                <button
                                                    className="btn-skip-search"
                                                    onClick={() => onSkipSearch(selectedSegment.index)}
                                                >
                                                    Skip & Move to Next
                                                </button>
                                            </div>
                                        ) : selectedSegment.status === 'skipped' ? (
                                            <div className="skipped-state">
                                                <div className="skipped-icon">
                                                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                                        <path d="M13 5L20 12L13 19M5 5L12 12L5 19" stroke="#444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                                    </svg>
                                                </div>
                                                <span className="skipped-text">Skipped</span>
                                                <span className="skipped-subtext">Use the buttons below to add a video</span>
                                            </div>
                                        ) : selectedSegment.status === 'pending' ? (
                                            <div className="pending-state">
                                                <div className="pending-icon">
                                                    <FilmIcon style={{ width: 32, height: 32, color: '#444' }} />
                                                </div>
                                                <span className="pending-text">Waiting in queue...</span>
                                            </div>
                                        ) : (selectedSegment.status === 'error' || selectedSegment.status === 'error_handled') ? (
                                            <div className="error-state">
                                                <div className="error-icon">
                                                    <XCircleIcon style={{ width: 48, height: 48, color: '#FF453A' }} />
                                                </div>
                                                <span className="error-text">ERROR</span>
                                                <span className="error-subtext">Match failed. Use the buttons below to retry or add manually.</span>
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
                                {selectedSegment.video && selectedSegment.status === 'found' && (
                                    <>
                                        <button onClick={() => handleApprove(selectedSegment.index)} className="btn-approve">
                                            <CheckCircleIcon />
                                            <span>Approve</span>
                                        </button>
                                        <button
                                            onClick={() => onReplaceClip(selectedSegment.index)}
                                            className="btn-replace"
                                        >
                                            <span>Find Different</span>
                                        </button>
                                        <button
                                            onClick={() => setShowManualUrlModal(true)}
                                            className="btn-manual"
                                        >
                                            <span>Manual URL</span>
                                        </button>
                                    </>
                                )}
                                {selectedSegment.status === 'approved' && (
                                    <div className="approved-badge">
                                        <CheckCircleIcon />
                                        <span>Approved</span>
                                        <button onClick={() => setShowManualUrlModal(true)} className="btn-manual-approved" title="Change manually">
                                            Edit
                                        </button>
                                    </div>
                                )}
                                {(selectedSegment.status === 'skipped' || selectedSegment.status === 'error' || selectedSegment.status === 'error_handled') && (
                                    <>
                                        <button
                                            onClick={() => onReplaceClip(selectedSegment.index)}
                                            className="btn-retry"
                                        >
                                            Auto Search
                                        </button>
                                        <button
                                            onClick={() => setShowManualUrlModal(true)}
                                            className="btn-manual"
                                        >
                                            Manual URL
                                        </button>
                                    </>
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
                                    <path d="M1.5 1.5L8.5 8.5M8.5 1.5L1.5 8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
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
            {/* MANUAL URL MODAL */}
            {showManualUrlModal && (
                <div className="modal-overlay" onClick={() => !isSubmittingManual && setShowManualUrlModal(false)}>
                    <div className="modal-content manual-url-modal" onClick={e => e.stopPropagation()}>
                        <button
                            className="modal-close-btn"
                            onClick={() => !isSubmittingManual && setShowManualUrlModal(false)}
                            disabled={isSubmittingManual}
                        >
                            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                                <path d="M1 1L13 13M1 13L13 1" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                            </svg>
                        </button>

                        <div className="manual-url-header">
                            <div className="manual-url-icon">
                                <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="#FF0055" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="#FF0055" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </div>
                            <h3>Add Video Manually</h3>
                            <p>Paste a Viory video URL to use for this segment</p>
                        </div>

                        <div className="manual-url-body">
                            <label className="manual-url-label">Video URL</label>
                            <div className="manual-url-input-wrapper">
                                <svg className="input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none">
                                    <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                                <input
                                    type="text"
                                    className={`manual-url-input ${manualUrlInput && !manualUrlInput.includes('viory.video') ? 'invalid' : ''} ${manualUrlInput && manualUrlInput.includes('viory.video') ? 'valid' : ''}`}
                                    placeholder="https://www.viory.video/en/videos/..."
                                    value={manualUrlInput}
                                    onChange={e => setManualUrlInput(e.target.value)}
                                    disabled={isSubmittingManual}
                                    autoFocus
                                />
                                {manualUrlInput && manualUrlInput.includes('viory.video') && (
                                    <svg className="input-check" width="16" height="16" viewBox="0 0 24 24" fill="none">
                                        <path d="M20 6L9 17L4 12" stroke="#34C759" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                    </svg>
                                )}
                            </div>
                            {manualUrlInput && !manualUrlInput.includes('viory.video') && (
                                <p className="manual-url-error">URL must be from viory.video</p>
                            )}

                            <div className="manual-url-hint">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
                                    <path d="M12 16v-4M12 8h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                </svg>
                                <span>Go to viory.video, find a video, and copy the URL from your browser</span>
                            </div>
                        </div>

                        <div className="manual-url-footer">
                            <button
                                className="btn-cancel"
                                onClick={() => setShowManualUrlModal(false)}
                                disabled={isSubmittingManual}
                            >
                                Cancel
                            </button>
                            <button
                                className="btn-primary btn-with-icon"
                                onClick={async () => {
                                    if (!manualUrlInput.includes('viory.video')) return;
                                    if (!selectedSegment) return;

                                    setIsSubmittingManual(true);
                                    try {
                                        const result = await onManualVideoUrl(selectedSegment.index, manualUrlInput);
                                        setIsSubmittingManual(false);

                                        if (result && result.success) {
                                            setShowManualUrlModal(false);
                                            setManualUrlInput('');
                                        } else if (result && result.isTooShort) {
                                            // Video downloaded but too short - show duration warning
                                            setShowManualUrlModal(false);
                                            setManualUrlInput('');
                                            setDurationWarning({
                                                segmentIndex: selectedSegment.index,
                                                required: result.requiredDuration,
                                                actual: result.videoDuration,
                                                minimumRequired: result.minimumRequired
                                            });
                                        } else {
                                            // Show error to user
                                            const errorMsg = result?.message || 'Failed to download video. Please try a different URL.';
                                            alert(errorMsg);
                                        }
                                    } catch (err: any) {
                                        setIsSubmittingManual(false);
                                        const errorMsg = err?.message || 'An unexpected error occurred';
                                        alert(`Error: ${errorMsg}`);
                                    }
                                }}
                                disabled={isSubmittingManual || !manualUrlInput.includes('viory.video')}
                            >
                                {isSubmittingManual ? (
                                    <>
                                        <span className="spinner"></span>
                                        Downloading...
                                    </>
                                ) : (
                                    <>
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                        Download & Apply
                                    </>
                                )}
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* DURATION WARNING MODAL */}
            {durationWarning && (
                <div className="modal-overlay">
                    <div className="modal-content duration-warning-modal">
                        <div className="modal-header warn">
                            <div className="warn-icon">⚠️</div>
                            <h3>Video is too short!</h3>
                        </div>
                        <div className="modal-body">
                            <p>The video you selected is only <strong>{durationWarning.actual?.toFixed(1) || '?'}s</strong>.</p>
                            <p>This segment requires at least <strong>{durationWarning.minimumRequired?.toFixed(1) || durationWarning.required?.toFixed(1) || '?'}s</strong> (segment duration: {durationWarning.required?.toFixed(1) || '?'}s).</p>
                            <p style={{ marginTop: '12px', color: '#888' }}>Please select a longer video.</p>
                        </div>
                        <div className="modal-footer vertical">
                            <button className="btn-primary" onClick={() => {
                                setDurationWarning(null);
                                setShowManualUrlModal(true); // Try another one
                            }}>
                                Try Different Manual URL
                            </button>
                            <button className="btn-secondary" onClick={() => {
                                setDurationWarning(null);
                                onReplaceClip(durationWarning.segmentIndex); // Auto search
                            }}>
                                Auto-Search for better footage
                            </button>
                            <button className="btn-ghost" onClick={() => setDurationWarning(null)}>
                                Keep it anyway (not recommended)
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default EditorView;
