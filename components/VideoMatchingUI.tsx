import React, { useState, useEffect, useRef } from 'react';
import { LiquidCard, LiquidButton, LiquidTextArea } from './LiquidUI';
// @ts-ignore
import { ArrowPathIcon, FilmIcon, MagnifyingGlassIcon, ChevronDownIcon, PlayIcon, ArrowTopRightOnSquareIcon, ClockIcon } from '@heroicons/react/24/solid';

interface VideoResult {
    title: string;
    url: string;
    thumbnail: string;
    duration: string;
}

interface BlockWithVideos {
    index: number;
    headline: string;
    text: string;
    searchQuery: string;
    videos: VideoResult[];
    status?: 'waiting' | 'generating_query' | 'searching' | 'complete' | 'error';
}

interface ProcessingStatus {
    blockIndex: number;
    status: 'waiting' | 'generating_query' | 'searching' | 'complete' | 'error';
    query?: string;
    videoCount?: number;
}

interface VideoMatchingUIProps {
    className?: string;
}

// Compact video thumbnail for capsule grid
const CompactVideoThumb: React.FC<{ video: VideoResult }> = ({ video }) => (
    <a
        href={video.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group relative aspect-video rounded-lg overflow-hidden bg-black/50 hover:ring-2 hover:ring-[#FF0055] transition-all cursor-pointer"
        title={`Open: ${video.title}`}
    >
        {video.thumbnail ? (
            <img
                src={video.thumbnail}
                alt={video.title}
                className="w-full h-full object-cover transition-transform duration-300 group-hover:scale-110"
                loading="lazy"
            />
        ) : (
            <div className="w-full h-full flex items-center justify-center bg-white/5">
                <FilmIcon className="w-6 h-6 text-gray-600" />
            </div>
        )}

        {/* Duration badge */}
        {video.duration && video.duration !== 'N/A' && (
            <span className="absolute bottom-1 right-1 px-1 py-0.5 bg-black/80 text-white text-[9px] font-mono rounded">
                {video.duration}
            </span>
        )}

        {/* Hover overlay */}
        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <ArrowTopRightOnSquareIcon className="w-5 h-5 text-white" />
        </div>
    </a>
);

// Block Capsule component - collapsible card for each script block
const BlockCapsule: React.FC<{
    block: BlockWithVideos;
    isExpanded: boolean;
    onToggle: () => void;
    onReSearch: () => void;
    isLoading: boolean;
}> = ({ block, isExpanded, onToggle, onReSearch, isLoading }) => {
    const statusColors = {
        waiting: 'bg-gray-500/20 text-gray-400',
        generating_query: 'bg-yellow-500/20 text-yellow-400',
        searching: 'bg-blue-500/20 text-blue-400',
        complete: 'bg-green-500/20 text-green-400',
        error: 'bg-red-500/20 text-red-400'
    };

    const statusIcons = {
        waiting: '⏸️',
        generating_query: '🤖',
        searching: '🔍',
        complete: '✅',
        error: '❌'
    };

    const status = block.status || 'complete';

    return (
        <div className={`
            rounded-xl border transition-all duration-300
            ${isExpanded
                ? 'border-[#FF0055]/30 bg-white/[0.03]'
                : 'border-white/5 bg-white/[0.01] hover:border-white/10'
            }
        `}>
            {/* Capsule Header - always visible */}
            <button
                onClick={onToggle}
                className="w-full p-3 flex items-center gap-3 text-left"
            >
                {/* Block number */}
                <div className="w-8 h-8 rounded-full bg-[#FF0055]/10 flex items-center justify-center text-[#FF0055] text-sm font-bold shrink-0">
                    {block.index + 1}
                </div>

                {/* Title & Query */}
                <div className="flex-1 min-w-0">
                    <h4 className="text-sm font-medium text-white truncate">
                        {block.headline}
                    </h4>
                    <p className="text-[10px] text-gray-500 font-mono truncate">
                        🔍 "{block.searchQuery || '...'}"
                    </p>
                </div>

                {/* Status badge */}
                <div className={`px-2 py-1 rounded-full text-[10px] font-medium flex items-center gap-1 shrink-0 ${statusColors[status]}`}>
                    <span>{statusIcons[status]}</span>
                    <span>{statusLabels[status] || 'Ready'}</span>
                </div>

                {/* Expand arrow */}
                <ChevronDownIcon
                    className={`w-4 h-4 text-gray-400 transition-transform duration-300 shrink-0 ${isExpanded ? 'rotate-180' : ''}`}
                />
            </button>

            {/* Expanded content */}
            {isExpanded && (
                <div className="px-3 pb-3 border-t border-white/5 pt-3">
                    {/* Re-search button */}
                    <div className="flex justify-end mb-2">
                        <button
                            onClick={(e) => { e.stopPropagation(); onReSearch(); }}
                            disabled={isLoading}
                            className="flex items-center gap-1 px-2 py-1 rounded-full bg-white/5 hover:bg-white/10 text-gray-400 hover:text-white text-[10px] font-medium transition-all disabled:opacity-50"
                        >
                            <ArrowPathIcon className={`w-3 h-3 ${isLoading ? 'animate-spin' : ''}`} />
                            Re-search
                        </button>
                    </div>

                    {/* Video grid - compact 3-column in grid layout */}
                    {isLoading ? (
                        <div className="grid grid-cols-3 gap-2">
                            {[...Array(6)].map((_, i) => (
                                <div key={i} className="aspect-video bg-white/10 rounded-lg animate-pulse" />
                            ))}
                        </div>
                    ) : block.videos.length > 0 ? (
                        <div className="grid grid-cols-3 gap-2">
                            {block.videos.map((video, i) => (
                                <CompactVideoThumb key={i} video={video} />
                            ))}
                        </div>
                    ) : (
                        <div className="py-4 text-center text-gray-500 text-xs">
                            No videos found. Try "Re-search" button.
                        </div>
                    )}

                    {/* Hint */}
                    <p className="text-[9px] text-gray-600 text-center mt-2">
                        💡 Click any video to open in Viory
                    </p>
                </div>
            )}
        </div>
    );
};

// HELPER: Status labels map
const statusLabels: Record<string, string> = {
    waiting: 'Waiting',
    generating_query: 'AI thinking...',
    searching: 'Searching...',
    complete: 'Done',
    error: 'Error'
};

// Enhanced Progress tracker with time estimation
const EnhancedProgressTracker: React.FC<{
    statuses: ProcessingStatus[];
    totalBlocks: number;
    scriptContext?: string;
}> = ({ statuses, totalBlocks, scriptContext }) => {
    const completedCount = statuses.filter(s => s.status === 'complete').length;
    const progress = totalBlocks > 0 ? (completedCount / totalBlocks) * 100 : 0;

    // Estimate: ~4 seconds per block
    const remainingBlocks = totalBlocks - completedCount;
    const estimatedSeconds = remainingBlocks * 4;

    const currentBlockIndex = statuses.findIndex(s => s.status === 'generating_query' || s.status === 'searching');
    const statusText = currentBlockIndex >= 0
        ? `Processing Block ${currentBlockIndex + 1} of ${totalBlocks}...`
        : completedCount === totalBlocks
            ? 'All Done!'
            : 'Initializing...';

    return (
        <LiquidCard className="h-full flex flex-col justify-center min-h-[300px]">
            <div className="text-center space-y-6 px-4">

                {/* Circular or Large Progress Visual */}
                <div className="relative w-full max-w-xs mx-auto">
                    <div className="flex justify-between text-xs text-gray-400 mb-2">
                        <span>Progress</span>
                        <span>{Math.round(progress)}%</span>
                    </div>
                    <div className="h-3 bg-white/10 rounded-full overflow-hidden shadow-inner">
                        <div
                            className="h-full bg-gradient-to-r from-[#FF0055] via-[#FF6B35] to-[#FF0055] bg-[length:200%_100%] animate-gradient-x transition-all duration-500"
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                </div>

                {/* Status Text & Timer */}
                <div className="space-y-2">
                    <h3 className="text-xl font-medium text-white animate-pulse">
                        {statusText}
                    </h3>

                    {remainingBlocks > 0 && (
                        <div className="flex items-center justify-center gap-2 text-sm text-gray-500">
                            <ClockIcon className="w-4 h-4" />
                            <span>Estimated time left: ~{estimatedSeconds}s</span>
                        </div>
                    )}
                </div>

                {/* Current Activity Log (Mini) */}
                <div className="max-w-xs mx-auto mt-4 p-3 rounded-xl bg-black/20 border border-white/5 text-left h-32 overflow-y-auto custom-scrollbar">
                    <div className="text-[10px] text-gray-500 uppercase font-bold mb-2">Activity Log</div>
                    {statuses.map((s, i) => (
                        <div key={i} className={`text-xs mb-1.5 flex gap-2 ${s.status === 'searching' || s.status === 'generating_query' ? 'text-white' : 'text-gray-500'}`}>
                            <span className="opacity-50 font-mono">#{i + 1}</span>
                            <span className="truncate">
                                {s.status === 'waiting' && 'Waiting...'}
                                {s.status === 'generating_query' && 'Generating AI query...'}
                                {s.status === 'searching' && `Searching: "${s.query || '...'}"`}
                                {s.status === 'complete' && `Found ${s.videoCount} videos`}
                            </span>
                        </div>
                    ))}
                </div>

                {scriptContext && (
                    <div className="text-xs text-gray-400 max-w-sm mx-auto border-t border-white/5 pt-4 mt-2">
                        <span className="text-[#FF0055] font-bold">Context:</span> {scriptContext}
                    </div>
                )}
            </div>
        </LiquidCard>
    );
};

export const VideoMatchingUI: React.FC<VideoMatchingUIProps> = ({ className = '' }) => {
    const [scriptText, setScriptText] = useState('');
    const [isProcessing, setIsProcessing] = useState(false);
    const [blocks, setBlocks] = useState<BlockWithVideos[]>([]);
    const [expandedBlock, setExpandedBlock] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loadingBlocks, setLoadingBlocks] = useState<number[]>([]);
    const [processingStatuses, setProcessingStatuses] = useState<ProcessingStatus[]>([]);
    const [scriptContext, setScriptContext] = useState<string>('');

    const handleFindVideos = async () => {
        if (!scriptText.trim()) return;

        setIsProcessing(true);
        setError(null);
        setBlocks([]);
        setExpandedBlock(null);
        setScriptContext('');

        // Count expected blocks
        const markerCount = (scriptText.match(/\[ON\s*SCREEN/gi) || []).length;

        // Initialize processing statuses
        const initialStatuses: ProcessingStatus[] = [];
        for (let i = 0; i < markerCount; i++) {
            initialStatuses.push({ blockIndex: i, status: 'waiting' });
        }
        setProcessingStatuses(initialStatuses);

        // Simulate progress animation while waiting for server response
        let currentBlock = 0;
        const totalBlocks = markerCount;

        // Timer simulation for UX
        const progressInterval = setInterval(() => {
            setProcessingStatuses(prev => {
                const updated = [...prev];
                // Only animate if we are within bounds and current block logic is sound
                if (currentBlock < updated.length) {
                    if (updated[currentBlock].status === 'waiting') {
                        updated[currentBlock] = { ...updated[currentBlock], status: 'generating_query' };
                    } else if (updated[currentBlock].status === 'generating_query') {
                        updated[currentBlock] = { ...updated[currentBlock], status: 'searching' };
                        // Move to next block logic would be handled by actual server stream usually, 
                        // but here we are simulating "in progress" state until POST returns
                        // We won't increment currentBlock too fast to avoid finishing before server returns
                    }
                }
                return updated;
            });
            // Slowly advance blocks visually to simulate work
            if (Math.random() > 0.6 && currentBlock < totalBlocks - 1) {
                // Determine if we can move previous one to "searching" (simulated)
                // In this POST-based simulation, we just keep the current one active
                // Real data will overwrite this
            }
        }, 3000);

        try {
            const response = await fetch('https://click-sync-production.up.railway.app/api/video-matching', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ script: scriptText })
            });

            clearInterval(progressInterval);

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to match videos');
            }

            // Update all statuses to complete with actual data
            const finalStatuses = data.blocks.map((block: BlockWithVideos) => ({
                blockIndex: block.index,
                status: 'complete' as const,
                query: block.searchQuery,
                videoCount: block.videos.length
            }));
            setProcessingStatuses(finalStatuses);

            setBlocks(data.blocks);
            setScriptContext(data.context || '');

            // Small delay to show final status before hiding progress
            await new Promise(resolve => setTimeout(resolve, 800));

            if (data.blocks.length > 0) {
                setExpandedBlock(0);
            }

        } catch (err: any) {
            clearInterval(progressInterval);
            setError(err.message);
        } finally {
            setIsProcessing(false);
        }
    };

    const handleReSearch = async (block: BlockWithVideos) => {
        setLoadingBlocks(prev => [...prev, block.index]);

        try {
            const response = await fetch('https://click-sync-production.up.railway.app/api/video-matching/research', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ block })
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to re-search');
            }

            setBlocks(prev => prev.map(b =>
                b.index === block.index ? data.block : b
            ));

        } catch (err: any) {
            console.error('Re-search error:', err);
        } finally {
            setLoadingBlocks(prev => prev.filter(i => i !== block.index));
        }
    };

    return (
        <div className={`h-[calc(100vh-140px)] min-h-[600px] ${className}`}>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 h-full">

                {/* LEFT COLUMN: Input */}
                <div className="flex flex-col h-full gap-4">
                    <LiquidCard title="News Script" className="flex-1 flex flex-col">
                        <div className="mb-4 text-xs text-gray-500">
                            Paste your script below. Use <code className="text-[#FF0055]">[ON SCREEN]</code> to mark video segments.
                        </div>
                        <div className="flex-1 min-h-0 relative">
                            <textarea
                                className="w-full h-full bg-black/20 text-gray-100 p-4 rounded-xl border border-white/5 outline-none focus:border-[#FF0055]/50 focus:ring-1 focus:ring-[#FF0055]/50 resize-none font-mono text-sm leading-relaxed custom-scrollbar placeholder-gray-700"
                                placeholder={`[ON SCREEN: Putin Russia tensions]
The Kremlin announced new military exercises...

[ON SCREEN: Trump tariffs]
Former President threatened new tariffs...`}
                                value={scriptText}
                                onChange={(e) => setScriptText(e.target.value)}
                            />
                        </div>
                        <div className="mt-4">
                            <LiquidButton
                                disabled={!scriptText.trim() || isProcessing}
                                onClick={handleFindVideos}
                                className="w-full py-4 text-sm font-bold tracking-wide"
                                isLoading={isProcessing}
                            >
                                <MagnifyingGlassIcon className="w-4 h-4 mr-2" />
                                {isProcessing ? 'SCANNING SCRIPT...' : 'FIND VIDEOS'}
                            </LiquidButton>
                        </div>
                    </LiquidCard>
                </div>

                {/* RIGHT COLUMN: Results / Progress */}
                <div className="flex flex-col h-full overflow-hidden">
                    {error && (
                        <div className="p-4 mb-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
                            {error}
                        </div>
                    )}

                    {isProcessing ? (
                        <EnhancedProgressTracker
                            statuses={processingStatuses}
                            totalBlocks={processingStatuses.length}
                            scriptContext={scriptContext}
                        />
                    ) : blocks.length > 0 ? (
                        <LiquidCard
                            title="Results"
                            className="h-full flex flex-col"
                            rightElement={
                                <span className="bg-[#FF0055]/10 text-[#FF0055] px-2 py-1 rounded-full text-[10px] font-bold">
                                    {blocks.length} BLOCKS
                                </span>
                            }
                        >
                            {scriptContext && (
                                <div className="mb-4 px-4 py-3 rounded-lg bg-[#FF0055]/5 border border-[#FF0055]/10 shrink-0">
                                    <p className="text-[10px] text-gray-400 uppercase tracking-wider mb-1 font-bold">Context Analysis</p>
                                    <p className="text-xs text-gray-300 leading-relaxed">{scriptContext}</p>
                                </div>
                            )}

                            <div className="flex-1 overflow-y-auto custom-scrollbar p-1 space-y-2">
                                {blocks.map(block => (
                                    <BlockCapsule
                                        key={block.index}
                                        block={block}
                                        isExpanded={expandedBlock === block.index}
                                        onToggle={() => setExpandedBlock(
                                            expandedBlock === block.index ? null : block.index
                                        )}
                                        onReSearch={() => handleReSearch(block)}
                                        isLoading={loadingBlocks.includes(block.index)}
                                    />
                                ))}
                            </div>
                        </LiquidCard>
                    ) : (
                        <div className="h-full rounded-2xl border border-white/5 bg-white/[0.01] flex flex-col items-center justify-center text-center p-8 opacity-40">
                            <div className="w-20 h-20 mb-6 rounded-full bg-gradient-to-br from-white/10 to-transparent flex items-center justify-center">
                                <FilmIcon className="w-8 h-8 text-white/40" />
                            </div>
                            <h3 className="text-xl font-medium text-white mb-2">Ready to Search</h3>
                            <p className="text-sm text-gray-500 max-w-xs leading-relaxed">
                                Your video search results will appear here. Context-aware AI matching included.
                            </p>
                        </div>
                    )}
                </div>

            </div>
        </div>
    );
};

export default VideoMatchingUI;
