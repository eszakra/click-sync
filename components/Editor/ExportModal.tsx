import React, { useState, useEffect, useMemo, useRef } from 'react';
import { XMarkIcon, FolderIcon, FilmIcon, CheckBadgeIcon, ChevronDownIcon, StopIcon } from '@heroicons/react/24/solid';

export interface ExportOptions {
    fileName: string;
    filePath: string;
    resolution: '1080p' | '720p' | '480p';
    bitrate: number; // In kbps
    codec: 'h264';
    format: 'mp4';
    fps: 24 | 30 | 60;
}

// YouTube recommended bitrates (in kbps) for H.264
const YOUTUBE_BITRATES: Record<string, Record<number, number>> = {
    '1080p': { 24: 8000, 30: 8000, 60: 12000 },
    '720p': { 24: 5000, 30: 5000, 60: 7500 },
    '480p': { 24: 2500, 30: 2500, 60: 4000 },
};

const RESOLUTION_OPTIONS = [
    { value: '1080p', label: '1080p (Full HD)', width: 1920, height: 1080 },
    { value: '720p', label: '720p (HD)', width: 1280, height: 720 },
    { value: '480p', label: '480p (SD)', width: 854, height: 480 },
] as const;

const FPS_OPTIONS = [
    { value: 60, label: '60 fps', description: 'Smooth motion' },
    { value: 30, label: '30 fps', description: 'Standard' },
    { value: 24, label: '24 fps', description: 'Cinematic' },
] as const;

interface TimelineSegment {
    index: number;
    headline?: string;
    duration?: number;
    video?: {
        url?: string;
        previewUrl?: string;
        thumbnail?: string;
    } | null;
}

interface ExportModalProps {
    isOpen: boolean;
    onClose: () => void;
    onExport: (options: ExportOptions) => void;
    defaultFileName?: string;
    projectDuration?: number;
    previewImage?: string;
    segments?: TimelineSegment[]; // For frame-by-frame preview
    // New status props
    isExporting?: boolean;
    progress?: {
        stage: string;
        percent: number;
        fps?: number;
        time?: string;
        currentLowerThird?: number;
        totalLowerThirds?: number;
        lowerThirdText?: string;
        // Unified overlays progress
        totalOverlays?: number;
        currentOverlay?: number;
        overlayType?: 'preparing' | 'mandatory_credit' | 'lower_third' | 'complete';
        overlayText?: string;
        segmentIndex?: number;
        totalSegments?: number;
        renderProgress?: number; // Internal render progress (0-100)
    } | null;
    onReset?: () => void;
    onCancel?: () => void; // Cancel export
}

export const ExportModal: React.FC<ExportModalProps> = ({
    isOpen,
    onClose,
    onExport,
    defaultFileName = 'video_export',
    projectDuration = 0,
    previewImage,
    segments = [],
    isExporting = false,
    progress,
    onReset,
    onCancel
}) => {
    const [fileName, setFileName] = useState(defaultFileName);
    const [exportPath, setExportPath] = useState('');

    // Configurable settings with optimal defaults
    const [resolution, setResolution] = useState<'1080p' | '720p' | '480p'>('1080p');
    const [fps, setFps] = useState<24 | 30 | 60>(60);

    // Fixed settings
    const codec = 'h264';
    const format = 'mp4';

    // Calculate optimal bitrate based on resolution and fps (YouTube recommendations)
    const bitrate = useMemo(() => {
        return YOUTUBE_BITRATES[resolution]?.[fps] || 8000;
    }, [resolution, fps]);

    // Get resolution details
    const resolutionDetails = useMemo(() => {
        return RESOLUTION_OPTIONS.find(r => r.value === resolution) || RESOLUTION_OPTIONS[0];
    }, [resolution]);

    // Initial Path Load
    useEffect(() => {
        if (isOpen && window.electron) {
            window.electron.invoke('get-app-path').then((p: string) => {
                if (!exportPath) setExportPath(p);
            });
        }
    }, [isOpen]);

    const handleBrowseClick = async () => {
        if (window.electron) {
            const selectedPath = await window.electron.invoke('dialog:open-directory');
            if (selectedPath) {
                setExportPath(selectedPath);
            }
        }
    };

    const handleExportClick = () => {
        onExport({
            fileName,
            filePath: exportPath,
            resolution,
            bitrate,
            codec,
            format,
            fps
        });
    };

    // Calculate current segment based on progress for frame preview
    // IMPORTANT: useMemo must be called BEFORE any conditional returns (React hooks rules)
    const currentSegmentIndex = useMemo(() => {
        if (!segments || !segments.length || !progress) return 0;
        const percent = progress.percent || 0;
        // Map percentage to segment index
        const idx = Math.floor((percent / 100) * segments.length);
        return Math.min(idx, segments.length - 1);
    }, [segments, progress]);

    // Get current frame preview URL
    const currentFrameUrl = useMemo(() => {
        if (!segments || !segments.length) return previewImage || '';
        const seg = segments[currentSegmentIndex];
        return seg?.video?.previewUrl || seg?.video?.thumbnail || seg?.video?.url || previewImage || '';
    }, [segments, currentSegmentIndex, previewImage]);

    // Estimate Size based on bitrate and duration
    // Formula: (bitrate in kbps * duration in seconds) / 8 / 1024 = MB
    // Add ~10% for audio overhead (320kbps AAC)
    const estimatedSizeMB = useMemo(() => {
        const videoSizeMB = (bitrate * projectDuration) / 8 / 1024;
        const audioSizeMB = (320 * projectDuration) / 8 / 1024;
        return Math.max(1, Math.round(videoSizeMB + audioSizeMB));
    }, [bitrate, projectDuration]);

    if (!isOpen) return null;

    const formattedDuration = new Date(projectDuration * 1000).toISOString().substr(14, 5);

    // Render PROGRESS VIEW if exporting
    if (isExporting) {
        const isComplete = progress?.stage === 'complete';
        const isError = progress?.stage === 'error';
        const percent = Math.round(progress?.percent || 0);
        const totalSegments = segments?.length || 0;
        const currentClip = Math.min(currentSegmentIndex + 1, totalSegments);

        return (
            <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-xl animate-in fade-in duration-200 font-['Inter']">
                <div className="bg-[#0A0A0A] w-[500px] rounded-2xl shadow-2xl border border-[#1a1a1a] overflow-hidden">

                    {/* Animated Progress Visualization */}
                    <div className="relative h-56 bg-gradient-to-b from-[#0f0f0f] to-[#0a0a0a] overflow-hidden">
                        {/* Animated Background Grid */}
                        <div className="absolute inset-0 opacity-10">
                            <div className="absolute inset-0" style={{
                                backgroundImage: 'linear-gradient(rgba(255,0,85,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,0,85,0.1) 1px, transparent 1px)',
                                backgroundSize: '20px 20px'
                            }} />
                        </div>

                        {/* Center Content */}
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                            {isComplete ? (
                                /* Complete State */
                                <div className="flex flex-col items-center gap-3">
                                    <div className="w-16 h-16 rounded-full bg-[#30D158]/20 flex items-center justify-center">
                                        <CheckBadgeIcon className="w-10 h-10 text-[#30D158]" />
                                    </div>
                                    <span className="text-[#30D158] text-sm font-semibold">Export Complete</span>
                                </div>
                            ) : isError ? (
                                /* Error State */
                                <div className="flex flex-col items-center gap-3">
                                    <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
                                        <XMarkIcon className="w-10 h-10 text-red-500" />
                                    </div>
                                    <span className="text-red-400 text-sm font-semibold">Export Failed</span>
                                </div>
                            ) : progress?.stage === 'generating_overlays' || progress?.stage === 'generating_lower_thirds' ? (
                                /* Overlays Generation - Clean Unified Design */
                                (() => {
                                    // Calculate total progress: (completed overlays + current progress) / total
                                    const currentOverlay = progress?.currentOverlay || 1;
                                    const totalOverlays = progress?.totalOverlays || 1;
                                    const currentRenderProgress = progress?.renderProgress || 0;
                                    const completedOverlays = currentOverlay - 1;
                                    const totalProgress = Math.round(((completedOverlays * 100) + currentRenderProgress) / totalOverlays);
                                    
                                    return (
                                        <>
                                            {/* Total Progress Percentage */}
                                            <div className="text-6xl font-black text-white tracking-tighter">
                                                {totalProgress}<span className="text-2xl text-[#666]">%</span>
                                            </div>

                                            {/* Current Task Info */}
                                            <div className="mt-3 flex items-center gap-2">
                                                {/* Icon changes based on type */}
                                                {progress?.overlayType === 'mandatory_credit' ? (
                                                    <svg className="w-4 h-4 text-[#FF0055]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                        <path strokeLinecap="round" strokeLinejoin="round" d="M9.568 3H5.25A2.25 2.25 0 003 5.25v4.318c0 .597.237 1.17.659 1.591l9.581 9.581c.699.699 1.78.872 2.607.33a18.095 18.095 0 005.223-5.223c.542-.827.369-1.908-.33-2.607L11.16 3.66A2.25 2.25 0 009.568 3z" />
                                                    </svg>
                                                ) : (
                                                    <svg className="w-4 h-4 text-[#FF0055]" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                                        <rect x="2" y="14" width="20" height="7" rx="2" />
                                                        <line x1="5" y1="17" x2="19" y2="17" strokeLinecap="round" />
                                                    </svg>
                                                )}
                                                <span className="text-[#888] text-sm">
                                                    {progress?.overlayType === 'mandatory_credit' ? 'Credit' : 'Lower Third'}
                                                </span>
                                                <span className="text-[#555] text-sm font-mono">
                                                    {currentOverlay}/{totalOverlays}
                                                </span>
                                            </div>

                                            {/* Current Text Preview */}
                                            {(progress?.overlayText || progress?.lowerThirdText) && (
                                                <div className="mt-2 max-w-[85%]">
                                                    <p className="text-[#666] text-[11px] truncate text-center">
                                                        {progress?.overlayText || progress?.lowerThirdText}
                                                    </p>
                                                </div>
                                            )}

                                            {/* Rendering Indicator */}
                                            <div className="mt-4 flex items-center gap-2">
                                                <div className="w-2 h-2 rounded-full bg-[#FF0055] animate-pulse" />
                                                <span className="text-[#555] text-xs">Generating overlays</span>
                                            </div>
                                        </>
                                    );
                                })()
                            ) : (
                                /* Encoding State - Animated */
                                <>
                                    {/* Large Percentage */}
                                    <div className="text-6xl font-black text-white tracking-tighter">
                                        {percent}<span className="text-2xl text-[#666]">%</span>
                                    </div>

                                    {/* Clip Progress */}
                                    {totalSegments > 0 && (
                                        <div className="mt-2 text-[#666] text-xs font-mono">
                                            Clip {currentClip} of {totalSegments}
                                        </div>
                                    )}

                                    {/* Animated Render Indicator */}
                                    <div className="mt-4 flex items-center gap-2">
                                        <div className="w-2 h-2 rounded-full bg-[#FF0055] animate-pulse" />
                                        <span className="text-[#888] text-xs uppercase tracking-wider">
                                            {progress?.stage === 'preparing' ? 'Preparing' : 'Encoding'}
                                        </span>
                                        {progress?.fps && (
                                            <span className="text-[#30D158] text-xs font-mono ml-2">{progress.fps} fps</span>
                                        )}
                                    </div>
                                </>
                            )}
                        </div>

                        {/* Time Indicator - Top Right */}
                        {!isComplete && !isError && progress?.time && (
                            <div className="absolute top-4 right-4">
                                <span className="text-[#555] text-xs font-mono">{progress.time}</span>
                            </div>
                        )}
                    </div>

                    {/* Progress Bar Section */}
                    <div className="p-5 space-y-4 border-t border-[#1a1a1a]">
                        {/* Progress Bar - Unified style */}
                        <div className="space-y-2">
                            <div className="w-full h-2 bg-[#1a1a1a] rounded-full overflow-hidden">
                                {(() => {
                                    // Calculate progress based on stage
                                    let barProgress = percent;
                                    if (progress?.stage === 'generating_overlays' || progress?.stage === 'generating_lower_thirds') {
                                        const currentOverlay = progress?.currentOverlay || 1;
                                        const totalOverlays = progress?.totalOverlays || 1;
                                        const currentRenderProgress = progress?.renderProgress || 0;
                                        const completedOverlays = currentOverlay - 1;
                                        barProgress = Math.round(((completedOverlays * 100) + currentRenderProgress) / totalOverlays);
                                    }
                                    
                                    return (
                                        <div
                                            className="h-full rounded-full transition-all duration-150 ease-out"
                                            style={{
                                                width: `${barProgress}%`,
                                                background: isComplete
                                                    ? '#30D158'
                                                    : isError
                                                        ? '#ef4444'
                                                        : 'linear-gradient(90deg, #FF0055, #FF3377)'
                                            }}
                                        />
                                    );
                                })()}
                            </div>
                        </div>

                        {/* Action Button */}
                        {isComplete ? (
                            <button
                                onClick={onReset}
                                className="w-full py-3 rounded-lg bg-[#FF0055] text-white font-semibold hover:bg-[#D90049] transition-all active:scale-[0.98]"
                            >
                                Done
                            </button>
                        ) : isError ? (
                            <button
                                onClick={onReset}
                                className="w-full py-3 rounded-lg bg-[#222] text-white font-semibold hover:bg-[#333] transition-all"
                            >
                                Close
                            </button>
                        ) : (
                            <button
                                onClick={onCancel}
                                className="w-full py-3 rounded-lg bg-[#1a1a1a] border border-[#333] text-[#999] font-semibold hover:bg-[#222] hover:text-white hover:border-[#444] transition-all flex items-center justify-center gap-2 active:scale-[0.98]"
                            >
                                <StopIcon className="w-4 h-4" />
                                Cancel Export
                            </button>
                        )}
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-md animate-in fade-in duration-200 font-['Inter']">
            {/* Extremely compact modal */}
            <div className="bg-[#0A0A0A] w-[650px] h-auto rounded-xl shadow-2xl border border-[#222] flex overflow-hidden">

                {/* LEFT: Preview */}
                <div className="w-[40%] bg-[#050505] p-6 flex flex-col items-center justify-center border-r border-[#222] relative">
                    <div className="w-full aspect-video bg-black rounded-lg overflow-hidden relative shadow-[0_0_20px_rgba(0,0,0,0.5)] border border-[#222] group">
                        {previewImage ? (
                            <video 
                                src={previewImage} 
                                className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity" 
                                muted
                                preload="metadata"
                                onLoadedData={(e) => {
                                    // Seek to 1s for a better preview frame
                                    (e.target as HTMLVideoElement).currentTime = 1;
                                }}
                            />
                        ) : (
                            <div className="w-full h-full flex flex-col items-center justify-center text-[#444] gap-2">
                                <FilmIcon className="w-8 h-8 opacity-50" />
                                <span className="text-[10px] font-mono uppercase tracking-widest">No Preview</span>
                            </div>
                        )}
                    </div>
                    <div className="mt-4 text-center space-y-1">
                        <h3 className="text-[#888] font-medium text-xs uppercase tracking-wider">Output Summary</h3>
                        <p className="text-[10px] text-[#555] font-mono">
                            {resolutionDetails.width}x{resolutionDetails.height} • {fps} FPS • H.264
                        </p>
                        <p className="text-[9px] text-[#444] font-mono">
                            {(bitrate / 1000).toFixed(1)} Mbps • MP4
                        </p>
                    </div>
                </div>

                {/* RIGHT: Settings */}
                <div className="w-[60%] flex flex-col bg-[#0A0A0A]">
                    <div className="px-6 py-4 border-b border-[#222] flex justify-between items-center bg-[#0F0F0F]">
                        <h2 className="text-white font-bold text-sm tracking-tight flex items-center gap-2">
                            <span className="w-2 h-2 rounded-full bg-[#FF0055]"></span>
                            Export Video
                        </h2>
                        <button onClick={onClose} className="p-1.5 hover:bg-[#222] rounded-full transition-colors text-gray-500 hover:text-white">
                            <XMarkIcon className="w-4 h-4" />
                        </button>
                    </div>

                    <div className="flex-1 p-6 space-y-4 overflow-y-auto">

                        {/* YouTube Optimized Banner */}
                        <div className="bg-[#111] border border-[#222] rounded-lg p-3 flex items-start gap-3">
                            <CheckBadgeIcon className="w-5 h-5 text-[#FF0055] mt-0.5 flex-shrink-0" />
                            <div>
                                <h3 className="text-white text-xs font-bold mb-0.5">YouTube Optimized Bitrate</h3>
                                <p className="text-[#666] text-[10px] leading-relaxed">
                                    Bitrate is automatically set to <b>{(bitrate / 1000).toFixed(1)} Mbps</b> based on your resolution and frame rate settings.
                                </p>
                            </div>
                        </div>

                        {/* Resolution & FPS Row */}
                        <div className="grid grid-cols-2 gap-3">
                            {/* Resolution */}
                            <div className="space-y-1.5">
                                <label className="text-[#666] text-[10px] font-bold uppercase tracking-wider">Resolution</label>
                                <div className="relative">
                                    <select
                                        value={resolution}
                                        onChange={(e) => setResolution(e.target.value as '1080p' | '720p' | '480p')}
                                        className="w-full bg-[#111] border border-[#2A2A2A] rounded-md px-3 py-2 text-gray-200 text-sm focus:border-[#FF0055] focus:ring-1 focus:ring-[#FF0055]/20 outline-none transition-all appearance-none cursor-pointer hover:border-[#444]"
                                    >
                                        {RESOLUTION_OPTIONS.map(opt => (
                                            <option key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                    <ChevronDownIcon className="w-4 h-4 text-[#666] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            </div>

                            {/* Frame Rate */}
                            <div className="space-y-1.5">
                                <label className="text-[#666] text-[10px] font-bold uppercase tracking-wider">Frame Rate</label>
                                <div className="relative">
                                    <select
                                        value={fps}
                                        onChange={(e) => setFps(Number(e.target.value) as 24 | 30 | 60)}
                                        className="w-full bg-[#111] border border-[#2A2A2A] rounded-md px-3 py-2 text-gray-200 text-sm focus:border-[#FF0055] focus:ring-1 focus:ring-[#FF0055]/20 outline-none transition-all appearance-none cursor-pointer hover:border-[#444]"
                                    >
                                        {FPS_OPTIONS.map(opt => (
                                            <option key={opt.value} value={opt.value}>
                                                {opt.label}
                                            </option>
                                        ))}
                                    </select>
                                    <ChevronDownIcon className="w-4 h-4 text-[#666] absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                                </div>
                            </div>
                        </div>

                        {/* Codec & Format Info (Read-only) */}
                        <div className="grid grid-cols-2 gap-3">
                            <div className="space-y-1.5">
                                <label className="text-[#666] text-[10px] font-bold uppercase tracking-wider">Codec</label>
                                <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-md px-3 py-2 text-[#555] text-sm font-mono">
                                    H.264 (AVC)
                                </div>
                            </div>
                            <div className="space-y-1.5">
                                <label className="text-[#666] text-[10px] font-bold uppercase tracking-wider">Format</label>
                                <div className="bg-[#0A0A0A] border border-[#1A1A1A] rounded-md px-3 py-2 text-[#555] text-sm font-mono">
                                    MP4
                                </div>
                            </div>
                        </div>

                        {/* File Name */}
                        <div className="space-y-1.5">
                            <label className="text-[#666] text-[10px] font-bold uppercase tracking-wider">File Name</label>
                            <input
                                type="text"
                                value={fileName}
                                onChange={(e) => setFileName(e.target.value)}
                                className="bg-[#111] border border-[#2A2A2A] rounded-md px-3 py-2 text-gray-200 text-sm focus:border-[#FF0055] focus:ring-1 focus:ring-[#FF0055]/20 outline-none w-full transition-all placeholder-[#333]"
                                placeholder="My Project Name"
                            />
                        </div>

                        {/* Destination */}
                        <div className="space-y-1.5">
                            <label className="text-[#666] text-[10px] font-bold uppercase tracking-wider">Save Location</label>
                            <div className="flex gap-2">
                                <div
                                    className="bg-[#111] border border-[#2A2A2A] rounded-md px-3 py-2 text-[#aaa] text-xs flex-1 truncate font-mono select-none cursor-pointer hover:border-[#444] transition-colors"
                                    onClick={handleBrowseClick}
                                    title={exportPath}
                                >
                                    {exportPath || 'Select Folder...'}
                                </div>
                                <button
                                    onClick={handleBrowseClick}
                                    className="bg-[#161616] border border-[#2A2A2A] rounded-md px-3 text-[#fff] hover:bg-[#222] hover:border-[#555] transition-all"
                                >
                                    <FolderIcon className="w-4 h-4" />
                                </button>
                            </div>
                        </div>

                    </div>

                    {/* Footer */}
                    <div className="p-4 bg-[#0F0F0F] border-t border-[#222] flex justify-between items-center">
                        <div className="flex flex-col">
                            <span className="text-[9px] text-[#555] uppercase font-bold">Estimated Size</span>
                            <span className="text-[11px] text-[#888] font-mono">~{estimatedSizeMB} MB</span>
                        </div>
                        <div className="flex gap-2">
                            <button
                                onClick={onClose}
                                className="px-4 py-2 rounded-md text-[11px] font-semibold text-[#666] hover:text-white hover:bg-[#222] transition-colors"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleExportClick}
                                className="px-6 py-2 rounded-md text-[11px] font-bold text-white bg-[#FF0055] hover:bg-[#D90049] shadow-lg shadow-[#FF0055]/20 hover:shadow-[#FF0055]/40 active:scale-95 transition-all"
                            >
                                Export Video
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};
