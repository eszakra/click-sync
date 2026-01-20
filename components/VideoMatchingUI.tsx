import React, { useState, useEffect, useRef } from 'react';
import { API_BASE_URL } from '../services/config';
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
    finalQuery?: string;
    queriesAttempted?: string[];
    fallbackReasons?: string[];
    attemptNum?: number;
    maxAttempts?: number;
    videos: VideoResult[];
    status?: 'waiting' | 'generating_queries' | 'searching' | 'searching_specific' | 'searching_entity' | 'searching_variant' | 'searching_broad' | 'complete' | 'no_results' | 'error';
}

interface ProcessingStatus {
    blockIndex: number;
    status: 'waiting' | 'generating_queries' | 'searching' | 'searching_specific' | 'searching_entity' | 'searching_variant' | 'searching_broad' | 'complete' | 'no_results' | 'error';
    query?: string;
    videoCount?: number;
    attemptNum?: number;
    maxAttempts?: number;
    fallbackReason?: string;
    queriesAttempted?: string[];
}

interface VideoMatchingUIProps {
    className?: string;
}

// HELPER: Status labels map
const statusLabels: Record<string, string> = {
    waiting: 'Waiting...',
    analyzing: 'Analyzing block...',
    extracted: 'Entities found',
    generating_queries: 'Generating queries...',
    searching: 'Searching Viory...',
    searching_specific: 'Trying specific...',
    searching_entity: 'Searching entity...',
    searching_variant: 'Trying variant...',
    searching_broad: 'Broad search...',
    fallback: 'Trying fallback...',
    success: 'Found match!',
    complete: 'Complete',
    no_results: 'No videos found',
    error: 'Error'
};

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
    const statusColors: Record<string, string> = {
        waiting: 'bg-gray-500/20 text-gray-400',
        analyzing: 'bg-purple-500/20 text-purple-400',
        extracted: 'bg-cyan-500/20 text-cyan-400',
        generating_queries: 'bg-purple-500/20 text-purple-400',
        searching: 'bg-blue-500/20 text-blue-400',
        searching_specific: 'bg-blue-600/20 text-blue-300',
        searching_entity: 'bg-indigo-500/20 text-indigo-400',
        searching_variant: 'bg-yellow-500/20 text-yellow-500',
        searching_broad: 'bg-orange-500/20 text-orange-400',
        fallback: 'bg-orange-500/20 text-orange-400',
        success: 'bg-green-500/20 text-green-400',
        complete: 'bg-green-500/20 text-green-400',
        no_results: 'bg-red-500/20 text-red-400',
        error: 'bg-red-500/20 text-red-500'
    };

    const statusIcons: Record<string, string> = {
        waiting: '⏸️',
        analyzing: '🧠',
        extracted: '📋',
        generating_queries: '🧠',
        searching: '🔍',
        searching_specific: '🎯',
        searching_entity: '👤',
        searching_variant: '🔄',
        searching_broad: '🌍',
        fallback: '↩️',
        success: '✅',
        complete: '✅',
        no_results: '⚠️',
        error: '❌'
    };

    const status = block.status || 'waiting';

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
                    {/* Final Query/Retry Info - Shown when we have results or are retrying */}
                    {(block.videos?.length > 0 || (block.attemptNum && block.attemptNum > 1)) && (
                        <div className="mt-1 text-[10px] flex items-center gap-2">
                            {block.finalQuery && (
                                <span className="text-emerald-400 opacity-90 font-mono">
                                    Query: "{block.finalQuery}"
                                </span>
                            )}
                        </div>
                    )}
                    {/* Fallback hidden specific query display if needed */}
                    <div className="hidden">
                        <p className="text-[10px] text-gray-500 font-mono truncate">
                            🔍 "{block.searchQuery || '...'}"
                        </p>
                    </div>
                </div>

                {/* Status badge */}
                <div className={`px-2 py-1 rounded text-[10px] font-medium flex items-center gap-1 shrink-0 ${statusColors[status] || statusColors.waiting}`}>
                    <span>{statusIcons[status] || statusIcons.waiting}</span>
                    <span>{(statusLabels[status] || status || 'Ready').toUpperCase().replace(/_/g, ' ')}</span>
                    {/* Show retry count if actively searching */}
                    {(status.includes('searching') && block.maxAttempts && block.maxAttempts > 1) && (
                        <span className="ml-1 opacity-75">
                            ({block.attemptNum || 1}/{block.maxAttempts})
                        </span>
                    )}
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

// Brain Activity Log Component
const EnhancedProgressTracker: React.FC<{
    statuses: ProcessingStatus[];
    totalBlocks: number;
    scriptContext: string;
}> = ({ statuses, totalBlocks, scriptContext }) => {

    return (
        <LiquidCard className="bg-[#0A0A0A] border z-50 p-4 border-gray-800/50 shadow-2xl w-full h-full overflow-hidden flex flex-col" title="Brain Activity Log">
            <div className="mb-2 flex items-center justify-between">
                <span className="text-xs text-gray-400">
                    Processing {statuses.length} events...
                </span>
                {scriptContext && (
                    <span className="text-[10px] bg-purple-500/10 text-purple-400 px-2 py-0.5 rounded-full border border-purple-500/20 truncate max-w-[200px]" title={scriptContext}>
                        {scriptContext}
                    </span>
                )}
            </div>

            <div className={`overflow-y-auto flex-1 text-xs space-y-2 pr-1 custom-scrollbar scroll-smooth`}>
                {statuses.length === 0 ? (
                    <div className="text-gray-500 italic py-2">Ready to process script...</div>
                ) : (
                    statuses.slice().reverse().map((s, i) => (
                        <div key={i} className="flex items-start gap-2 border-b border-gray-800/30 pb-2 last:border-0 last:pb-0 animate-in slide-in-from-right-2 duration-300">
                            {/* Icon based on status */}
                            <div className="mt-0.5 shrink-0">
                                {s.status === 'complete' && <span className="text-green-500">✓</span>}
                                {s.status === 'error' && <span className="text-red-500">✕</span>}
                                {s.status.includes('searching') && <span className="text-blue-400 animate-pulse">•</span>}
                                {s.status === 'generating_queries' && <span className="text-purple-400 animate-pulse">✦</span>}
                                {s.status === 'waiting' && <span className="text-gray-600">◦</span>}
                            </div>

                            <div className="flex-1 min-w-0">
                                <div className="text-gray-300 font-medium truncate">
                                    <span className="text-gray-500 mr-2">#{s.blockIndex + 1}</span>
                                    {statusLabels[s.status] || s.status}
                                </div>
                                {s.query && (
                                    <div className="text-gray-500 truncate font-mono text-[10px] mt-0.5">
                                        Query: <span className="text-gray-400">"{s.query}"</span>
                                        {s.attemptNum && s.maxAttempts && s.maxAttempts > 1 && (
                                            <span className="ml-1 text-orange-400">
                                                (Attempt {s.attemptNum}/{s.maxAttempts})
                                            </span>
                                        )}
                                    </div>
                                )}
                                {s.fallbackReason && (
                                    <div className="text-red-400/70 text-[10px] mt-0.5 ml-2 border-l border-red-500/30 pl-2">
                                        ↳ {s.fallbackReason}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))
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
    const eventSourceRef = useRef<EventSource | null>(null);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (eventSourceRef.current) {
                eventSourceRef.current.close();
            }
        };
    }, []);

    const handleFindVideos = async () => {
        if (!scriptText.trim()) return;

        setIsProcessing(true);
        setError(null);
        setBlocks([]);
        setExpandedBlock(null);
        setScriptContext('');
        setProcessingStatuses([]);

        // Close existing connection if any
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
        }

        try {
            // Count expected blocks for initialization
            const markerCount = (scriptText.match(/\[ON\s*SCREEN/gi) || []).length;
            const initialStatuses: ProcessingStatus[] = Array(markerCount).fill(0).map((_, i) => ({
                blockIndex: i,
                status: 'waiting'
            }));
            setProcessingStatuses(initialStatuses);

            // Connect to SSE stream
            const url = `${API_BASE_URL}/api/video-matching/stream?script=${encodeURIComponent(scriptText)}`;
            const eventSource = new EventSource(url);
            eventSourceRef.current = eventSource;

            eventSource.onmessage = (event) => {
                const data = JSON.parse(event.data);

                if (data.type === 'context') {
                    setScriptContext(data.context);
                } else if (data.type === 'status') {
                    // Update processing statuses log
                    setProcessingStatuses(prev => {
                        const newStatuses = [...prev];
                        // Add new event entry for log functionality
                        // We push distinct events to show history of retries
                        if (data.status !== 'waiting') {
                            // Limit log size
                            if (newStatuses.length > 100) newStatuses.shift();
                            newStatuses.push({
                                blockIndex: data.blockIndex,
                                status: data.status,
                                query: data.query,
                                videoCount: data.videoCount,
                                attemptNum: data.attemptNum,
                                maxAttempts: data.maxAttempts,
                                fallbackReason: data.fallbackReason,
                                queriesAttempted: data.queriesAttempted
                            });
                        }

                        // Also update the initial "waiting" entry if it exists to reflect start
                        const waitingIdx = newStatuses.findIndex(s => s.blockIndex === data.blockIndex && s.status === 'waiting');
                        if (waitingIdx !== -1) {
                            newStatuses.splice(waitingIdx, 1);
                        }

                        return newStatuses;
                    });

                    // Update block data
                    setBlocks(prev => {
                        // Initialize block if not exists (first status update)
                        const blockIndex = data.blockIndex;
                        const currentBlocks = [...prev];

                        // Ensure array is large enough
                        if (currentBlocks.length <= blockIndex) {
                            // Fill gaps if any (shouldn't happen with correct indexing)
                            while (currentBlocks.length <= blockIndex) {
                                currentBlocks.push({
                                    index: currentBlocks.length,
                                    headline: 'Loading...',
                                    text: '...',
                                    searchQuery: '...',
                                    videos: [],
                                    status: 'waiting'
                                });
                            }
                        }

                        // Update specific block
                        const block = currentBlocks[blockIndex];
                        currentBlocks[blockIndex] = {
                            ...block,
                            status: data.status,
                            searchQuery: data.query || block.searchQuery,
                            finalQuery: data.status === 'complete' ? data.query : block.finalQuery,
                            attemptNum: data.attemptNum,
                            maxAttempts: data.maxAttempts,
                            fallbackReasons: data.fallbackReason ? [...(block.fallbackReasons || []), data.fallbackReason] : block.fallbackReasons
                        };

                        return currentBlocks;
                    });

                } else if (data.type === 'block_complete') {
                    // Update final block with full data including videos
                    setBlocks(prev => {
                        const updated = [...prev];
                        updated[data.block.index] = {
                            ...updated[data.block.index],
                            ...data.block, // Overwrite with server source of truth
                            status: 'complete',
                            finalQuery: data.block.searchQuery // Ensure final query is set
                        };
                        return updated;
                    });
                } else if (data.type === 'complete') {
                    // All done
                    setBlocks(data.blocks);
                    eventSource.close();
                    setIsProcessing(false);
                    if (data.blocks.length > 0) setExpandedBlock(0);
                } else if (data.type === 'error') {
                    setError(data.message);
                    eventSource.close();
                    setIsProcessing(false);
                }
            };

            eventSource.onerror = (err) => {
                console.error('SSE Error:', err);
                setError('Connection lost. Please try again.');
                eventSource.close();
                setIsProcessing(false);
            };

        } catch (err: any) {
            setError(err.message);
            setIsProcessing(false);
        }
    };

    const handleReSearch = async (block: BlockWithVideos) => {
        setLoadingBlocks(prev => [...prev, block.index]);

        try {
            const response = await fetch(`${API_BASE_URL}/api/video-matching/research`, {
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
