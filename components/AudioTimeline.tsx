import React, { useEffect, useRef, useState } from 'react';
// @ts-ignore
import WaveSurfer from 'wavesurfer.js';
// @ts-ignore
import RegionsPlugin from 'wavesurfer.js/plugins/regions';
import { AlignedSegment } from '../services/gemini';
import { PlayIcon, PauseIcon, ArrowDownTrayIcon, XMarkIcon, AdjustmentsHorizontalIcon, MagnifyingGlassMinusIcon, MagnifyingGlassPlusIcon, ArrowUturnLeftIcon } from '@heroicons/react/24/solid';

interface AudioTimelineProps {
    audioFile: File;
    segments: AlignedSegment[];
    onSegmentsUpdate: (newSegments: AlignedSegment[]) => void;
    onClose: () => void;
    onDownloadAll: () => void;
}

export const AudioTimeline: React.FC<AudioTimelineProps> = ({
    audioFile,
    segments,
    onSegmentsUpdate,
    onClose,
    onDownloadAll
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const wavesurferRef = useRef<any>(null);
    const regionsRef = useRef<any>(null);

    // Direct DOM refs for performance
    const timeDisplayRef = useRef<HTMLSpanElement>(null);
    const playheadHandleRef = useRef<HTMLDivElement>(null);

    // State
    const [isReady, setIsReady] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [zoom, setZoom] = useState(20);
    const [duration, setDuration] = useState(0);
    const [history, setHistory] = useState<AlignedSegment[][]>([segments]);

    // Refs for logic
    const historyRef = useRef<AlignedSegment[][]>([segments]);
    const segmentsRef = useRef<AlignedSegment[]>(segments);
    const isDraggingRef = useRef(false);

    useEffect(() => { historyRef.current = history; }, [history]);
    useEffect(() => { segmentsRef.current = segments; }, [segments]);

    useEffect(() => {
        if (!containerRef.current || !audioFile) return;

        let wavesurfer: any = null;

        try {
            wavesurfer = WaveSurfer.create({
                container: containerRef.current,
                waveColor: 'rgba(255, 255, 255, 0.7)', // Balanced visibility (~70%)
                progressColor: 'rgba(255, 255, 255, 0.7)', // Match exactly
                cursorColor: '#FF0055', // Logic uses this
                cursorWidth: 0, // HIDE native cursor to avoid double-vision ghosting (we use overlay)
                height: 300,
                barWidth: 2,
                barGap: 1,
                barRadius: 2,
                normalize: true,
                minPxPerSec: zoom,
                interact: true,
                dragToSeek: true,
                autoScroll: true,
                hideScrollbar: true,
            });

            const regions = wavesurfer.registerPlugin(RegionsPlugin.create());
            wavesurferRef.current = wavesurfer;
            regionsRef.current = regions;

            const url = URL.createObjectURL(audioFile);
            wavesurfer.load(url);

            wavesurfer.on('ready', () => {
                setIsReady(true);
                setDuration(wavesurfer.getDuration());
                renderRegions(segments);
            });

            wavesurfer.on('play', () => setIsPlaying(true));
            wavesurfer.on('pause', () => setIsPlaying(false));

            // --- SYNC PLAYHEAD POSITION ---
            const updatePlayhead = () => {
                if (!playheadHandleRef.current || !wavesurfer) return;

                // Get current time and scroll position
                const t = wavesurfer.getCurrentTime();
                const scrollX = wavesurfer.getScroll();
                const pxPerSec = wavesurfer.options.minPxPerSec;

                // Calculate position relative to the VIEWPORT (container)
                // Pos = (Time * Zoom) - Scroll
                const pos = (t * pxPerSec) - scrollX;

                playheadHandleRef.current.style.transform = `translateX(${pos}px)`;
                playheadHandleRef.current.style.display = 'block';

                if (timeDisplayRef.current) {
                    timeDisplayRef.current.innerText = formatTime(t);
                }
            };

            // SMOOTH PLAYBACK
            wavesurfer.on('audioprocess', updatePlayhead); // Fires continually on play

            // High-freq updates
            wavesurfer.on('timeupdate', () => {
                if (!isDraggingRef.current) updatePlayhead();

                // Stop at Segment Logic
                if (wavesurfer.isPlaying()) {
                    const t = wavesurfer.getCurrentTime();
                    const activeSeg = segmentsRef.current.find(s => t >= s.start_time && t < s.end_time);
                    if (activeSeg && t >= activeSeg.end_time - 0.05) {
                        wavesurfer.pause();
                        wavesurfer.setTime(activeSeg.end_time);
                    }
                }
            });

            wavesurfer.on('scroll', updatePlayhead);
            wavesurfer.on('zoom', (z: number) => {
                setZoom(z);
                requestAnimationFrame(updatePlayhead);
            });


            // Logic Listeners
            let syncTimeout: any;
            regions.on('region-updated', (region: any) => {
                handleRegionUpdate(region);
                clearTimeout(syncTimeout);
                syncTimeout = setTimeout(syncStateAndHistory, 400);
            });

            regions.on('region-clicked', (region: any, e: MouseEvent) => {
                e.stopPropagation();
                region.play();
            });

            const handleKeyDown = (e: KeyboardEvent) => {
                if (e.code === 'Space') {
                    e.preventDefault();
                    if (wavesurfer) wavesurfer.playPause();
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
                    e.preventDefault();
                    undo();
                }
            };
            window.addEventListener('keydown', handleKeyDown);

            return () => {
                window.removeEventListener('keydown', handleKeyDown);
                if (wavesurfer) wavesurfer.destroy();
                URL.revokeObjectURL(url);
            };

        } catch (error) {
            console.error("WaveSurfer crash:", error);
            return () => { };
        }
    }, [audioFile]);

    // Zoom Handling
    useEffect(() => {
        if (wavesurferRef.current && isReady) {
            try {
                wavesurferRef.current.zoom(zoom);
            } catch (e) { }
        }
    }, [zoom, isReady]);

    // --- DRAGGING LOGIC ---
    const startDrag = (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation(); // Prevent propagation
        isDraggingRef.current = true;
        document.body.style.cursor = 'grabbing';

        // Initial calculation
        if (wavesurferRef.current && containerRef.current && playheadHandleRef.current) {
            // Pause first for smoother seek
            wavesurferRef.current.pause();
        }

        const onMouseMove = (ev: MouseEvent) => {
            if (!wavesurferRef.current || !containerRef.current || !playheadHandleRef.current) return;

            const rect = containerRef.current.getBoundingClientRect();
            let relX = ev.clientX - rect.left; // Pixels from left of viewport

            // Constrain
            const width = rect.width;
            // Unconstrained for infinite scroll (both directions)
            // relX = Math.max(0, relX); <-- Removed
            playheadHandleRef.current.style.transform = `translateX(${relX}px)`; // Relative to viewport! 
            // WAIT - transform in updatePlayhead logic uses `(Time * Zoom) - Scroll`.
            // Here we are dragging relative to the CONTAINER VIEWPORT.
            // So we need to map Viewport X -> Time -> Seek.

            const scroll = wavesurferRef.current.getScroll();
            const zoom = wavesurferRef.current.options.minPxPerSec;

            // Time = (Pixels + Scroll) / Zoom
            let newTime = (relX + scroll) / zoom;
            newTime = Math.max(0, Math.min(newTime, duration));

            // Debounce seek? No, user wants instant.
            wavesurferRef.current.seekTo(newTime / duration);

            // Also update time display manually
            if (timeDisplayRef.current) {
                timeDisplayRef.current.innerText = formatTime(newTime);
            }
        };

        const onMouseUp = () => {
            isDraggingRef.current = false;
            document.body.style.cursor = '';
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        };

        window.addEventListener('mousemove', onMouseMove);
        window.addEventListener('mouseup', onMouseUp);
    };


    // --- IMPLEMENTATION ---

    const syncStateAndHistory = () => {
        if (!regionsRef.current) return;
        const allRegions = regionsRef.current.getRegions().sort((a: any, b: any) => a.start - b.start);
        const finalSegments = allRegions.map((r: any, i: number) => ({
            ...segmentsRef.current[i],
            start_time: r.start,
            end_time: r.end
        }));
        onSegmentsUpdate(finalSegments);
        setHistory(prev => {
            const last = prev[prev.length - 1];
            if (JSON.stringify(last) === JSON.stringify(finalSegments)) return prev;
            return [...prev, finalSegments].slice(-50);
        });
    };

    const undo = () => {
        const currentCheck = historyRef.current;
        if (currentCheck.length > 1) {
            const newHistory = [...currentCheck];
            newHistory.pop();
            const prevState = newHistory[newHistory.length - 1];
            setHistory(newHistory);
            onSegmentsUpdate(prevState);
            renderRegions(prevState);
            segmentsRef.current = prevState; // Vital sync
        }
    };

    const handleRegionUpdate = (updatedRegion: any) => {
        const allRegions = regionsRef.current.getRegions().sort((a: any, b: any) => a.start - b.start);
        const idx = allRegions.findIndex((r: any) => r.id === updatedRegion.id);
        if (idx === -1) return;

        // Constraint: Min duration to prevent glitching
        if (updatedRegion.end - updatedRegion.start < 0.1) {
            updatedRegion.setOptions({ end: updatedRegion.start + 0.1 });
        }

        // Logic: Linked List Style - neighbor follows the cut
        // 1. If we moved the START, pull previous region END
        if (idx > 0) {
            const prev = allRegions[idx - 1];
            // If overlap or gap, snap previous end to current start
            if (Math.abs(prev.end - updatedRegion.start) > 0.01) {
                prev.setOptions({ end: updatedRegion.start });
            }
        }

        // 2. If we moved the END, pull next region START
        if (idx < allRegions.length - 1) {
            const next = allRegions[idx + 1];
            // If overlap or gap, snap next start to current end
            if (Math.abs(next.start - updatedRegion.end) > 0.01) {
                next.setOptions({ start: updatedRegion.end });
            }
        }
    };

    const renderRegions = (segs: AlignedSegment[]) => {
        if (!regionsRef.current) return;
        regionsRef.current.clearRegions();
        segs.forEach((seg, idx) => {
            // Create custom element for the label
            const el = document.createElement('div');
            el.className = 'flex flex-col h-full justify-between pointer-events-none overflow-hidden relative group';
            // Inner HTML with Handles
            el.innerHTML = `
                <div class="h-full w-full flex flex-col justify-start pt-1 pl-1">
                     <span style="background: rgba(0,0,0,0.6); padding: 2px 4px; border-radius: 4px; color: rgba(255,255,255,0.9); font-size: 10px; font-weight: bold; text-transform: uppercase;">
                        ${seg.title || `SEG ${idx + 1}`}
                    </span>
                </div>
                
                <!-- Left Handle Indicators (Visual Only) -->
                ${idx > 0 ? '<div class="absolute left-0 top-0 bottom-0 w-[1px] bg-white/20 group-hover:bg-white/50 transition-colors"></div>' : ''}
                
                <!-- Right Handle Indicators (Visual Only) -->
                <div class="absolute right-0 top-0 bottom-0 w-[1px] bg-white/20 group-hover:bg-white/50 transition-colors"></div>
            `;

            regionsRef.current.addRegion({
                id: `seg-${idx}`,
                start: seg.start_time,
                end: seg.end_time,
                content: el,
                drag: true,
                resize: true,
                color: idx % 2 === 0 ? 'rgba(255, 0, 85, 0.15)' : 'rgba(59, 130, 246, 0.15)',
                minLength: 0.1, // Prevent zero-length
            });
        });
    };

    const formatTime = (seconds: number) => {
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        const ms = Math.floor((seconds % 1) * 100);
        return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
    };

    return (
        <div className="fixed inset-0 z-[100] bg-[#09090b] flex flex-col text-white font-sans overflow-hidden animate-in fade-in duration-200 select-none">

            {/* 1. COMPACT TOOLBAR */}
            <div className="h-12 border-b border-white/10 bg-[#09090b] flex items-center justify-between px-4">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2 text-[#FF0055]">
                        <AdjustmentsHorizontalIcon className="w-5 h-5" />
                        <span className="font-bold text-sm tracking-wide">EDITOR PRO</span>
                    </div>
                    <div className="h-4 w-[1px] bg-white/10" />

                    {/* Zoom Control */}
                    <div className="flex items-center gap-2 group">
                        <MagnifyingGlassMinusIcon className="w-4 h-4 text-gray-500 group-hover:text-white transition-colors" />
                        <input
                            type="range" min="10" max="200" step="10"
                            value={zoom} onChange={(e) => setZoom(parseInt(e.target.value))}
                            className="w-24 h-1 bg-white/20 rounded-full appearance-none accent-[#FF0055] cursor-pointer"
                        />
                        <MagnifyingGlassPlusIcon className="w-4 h-4 text-gray-500 group-hover:text-white transition-colors" />
                    </div>

                    <div className="h-4 w-[1px] bg-white/10" />

                    {/* Undo */}
                    <button onClick={undo} className="p-1.5 rounded hover:bg-white/10 text-gray-400 hover:text-white transition-all flex items-center gap-1.5" title="Undo (Ctrl+Z)">
                        <ArrowUturnLeftIcon className="w-3.5 h-3.5" />
                        <span className="text-[10px] font-medium uppercase">Undo</span>
                    </button>
                </div>

                <div className="flex items-center gap-3">
                    <div className="text-[10px] font-mono text-gray-500 uppercase tracking-widest hidden md:block">
                        {segments.length} CLIPS / {formatTime(duration)}
                    </div>
                    <button
                        onClick={onDownloadAll}
                        className="flex items-center gap-2 px-3 py-1.5 rounded bg-white/5 hover:bg-white/10 border border-white/10 text-[11px] font-bold uppercase transition-all active:scale-95"
                    >
                        <ArrowDownTrayIcon className="w-3.5 h-3.5" />
                        Export
                    </button>
                    <button onClick={onClose} className="p-2 hover:bg-red-500/10 hover:text-red-500 rounded transition-colors">
                        <XMarkIcon className="w-5 h-5" />
                    </button>
                </div>
            </div>

            {/* 2. MAIN EDITOR AREA */}
            <div className="flex-1 relative bg-[#050505] flex flex-col group overflow-hidden justify-center select-none">
                {/* Loader */}
                {!isReady && (
                    <div className="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 backdrop-blur-sm">
                        <div className="w-8 h-8 border-2 border-t-[#FF0055] border-white/10 rounded-full animate-spin mb-2" />
                        <span className="text-[10px] font-mono uppercase text-gray-500">Initializing...</span>
                    </div>
                )}

                {/* WAVEFORM CONTAINER - Padded for handle */}
                <div className="w-full relative px-0" style={{ height: '300px' }}>
                    <div ref={containerRef} className="w-full h-full" />
                </div>

                {/* THE CUSTOM PLAYHEAD HANDLE (React Controlled Overlay) */}
                <div
                    ref={playheadHandleRef}
                    className="absolute top-0 bottom-0 z-[60] w-0 h-full pointer-events-none hidden will-change-transform"
                    style={{ left: 0 }} // Position handled by transform translateX
                >
                    {/* The Interactive HEAD - Centered */}
                    <div
                        onMouseDown={startDrag}
                        className="absolute -top-3 left-1/2 -translate-x-1/2 w-5 h-5 bg-[#FF0055] rotate-45 border-2 border-[#09090b] shadow-[0_0_10px_#FF0055] pointer-events-auto cursor-grab active:cursor-grabbing hover:scale-125 transition-transform"
                        title="Drag Playhead"
                    />
                    {/* The Line - Centered */}
                    <div className="absolute top-0 bottom-0 left-1/2 -translate-x-1/2 w-[2px] bg-[#FF0055] shadow-[0_0_8px_rgba(255,0,85,0.6)]" />
                </div>
            </div>

            {/* 3. COMPACT FOOTER */}
            <div className="h-14 bg-[#09090b] border-t border-white/10 flex items-center justify-between px-6 select-none relative z-50">
                {/* Left: Info */}
                <div className="flex items-center gap-4 text-xs font-mono text-gray-500">
                    <div className="flex flex-col">
                        <span className="text-[9px] uppercase tracking-wider text-gray-600">Position</span>
                        <span ref={timeDisplayRef} className="text-white font-bold w-16">0:00.00</span>
                    </div>
                    <div className="w-[1px] h-6 bg-white/10" />
                    <div className="flex flex-col">
                        <span className="text-[9px] uppercase tracking-wider text-gray-600">Total</span>
                        <span>{formatTime(duration)}</span>
                    </div>
                </div>

                {/* Center: Playback */}
                <div className="absolute left-1/2 -translate-x-1/2 flex items-center gap-6">
                    <button
                        onClick={() => {
                            if (wavesurferRef.current) {
                                wavesurferRef.current.playPause();
                            }
                        }}
                        className="w-10 h-10 bg-white text-black hover:bg-[#FF0055] hover:text-white rounded-full flex items-center justify-center transition-all shadow-lg active:scale-95"
                    >
                        {isPlaying ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5 ml-0.5" />}
                    </button>
                    <div className="text-[10px] items-center gap-2 hidden md:flex text-gray-600">
                        <span className="border border-white/10 px-1.5 py-0.5 rounded text-gray-400">SPACE</span>
                        <span>to Play</span>
                    </div>
                </div>

                {/* Right: Status */}
                <div className="flex items-center gap-3">
                    <div className="text-[9px] font-bold uppercase tracking-widest text-[#FF0055] bg-[#FF0055]/5 px-2 py-1 rounded border border-[#FF0055]/10">
                        Stop-at-Cut
                    </div>
                </div>
            </div>
        </div>
    );
};
