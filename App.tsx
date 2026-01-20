
// import { processFullAudioPipeline } from './services/gemini';
import JSZip from 'jszip';
import { AlignedSegment } from './services/gemini';
import { API_BASE_URL } from './services/config';
import { alignScriptDeterministic } from './services/matcher';
import { transcribeWithAssembly } from './services/assemblyBackend';
import { sliceAudioBuffer, decodeAudio } from './services/audioProcessor';
import React, { useState, useRef, useEffect, useCallback, memo } from 'react';
import { LiquidCard, LiquidButton, LiquidTextArea, LiquidDropZone, LiquidProgressBar } from './components/LiquidUI';
import { motion, AnimatePresence } from 'framer-motion';
// import gsap from 'gsap'; // Removed unused
import { ArrowDownTrayIcon, PlayIcon, PauseIcon, ArrowPathIcon, SparklesIcon, ChevronDownIcon, ChevronUpIcon, FilmIcon, ArrowTopRightOnSquareIcon, BackwardIcon, ForwardIcon, InformationCircleIcon, Cog6ToothIcon, XCircleIcon, ClockIcon, ClipboardIcon } from '@heroicons/react/24/solid';
import TitleBar from './components/TitleBar';
import { ToastContainer, ToastMessage, ToastType } from './components/Toast';
import { StartScreen } from './components/StartScreen';
import { projectService, ProjectData } from './services/projectService';

// --- Types ---
interface VideoResult {
    title: string;
    url: string;
    thumbnail: string;
    duration: string;
}

interface FinalSegment extends AlignedSegment {
    blobUrl: string;
    duration: number; // in seconds
}

interface AttemptLog {
    query: string;
    reason: string;
    status?: 'success' | 'failed';
}

// Unified Data Model
interface StoryBlock extends FinalSegment {
    id: string; // Unique ID for React keys
    videoStatus: 'idle' | 'searching' | 'complete' | 'error';
    videoMatches: VideoResult[];
    searchQuery?: string;
    videoCount?: number;
    currentQueryMessage?: string; // Real-time search progress
    attemptsLog?: AttemptLog[];
}

interface ProcessingState {
    status: 'idle' | 'transcribing' | 'aligning' | 'slicing' | 'videomatching' | 'completed' | 'error';
    progress: number;
    message: string;
}

// --- Internal UI Components ---

/**
 * SonicScrubber: Optimized audio slider
 */
const SonicScrubber: React.FC<{
    value: number; // 0-100
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    disabled?: boolean;
}> = memo(({ value, onChange, disabled }) => {
    // Optimization: Calculate style inline but it's cheap enough if component is memoized
    // Only re-renders when value changes.
    const gradientStyle = {
        background: `linear-gradient(to right, #FF0055 0%, #FF0055 ${value}%, rgba(255, 255, 255, 0.15) ${value}%, rgba(255, 255, 255, 0.15) 100%)`
    };

    return (
        <input
            type="range"
            min="0"
            max="100"
            step="0.1"
            value={value}
            onChange={onChange}
            disabled={disabled}
            className="apple-slider apple-slider-filled w-full transition-opacity disabled:opacity-50"
            style={gradientStyle}
        />
    );
});

// --- Premium Components ---

const ProcessingHero: React.FC<{ state: ProcessingState }> = memo(({ state }) => {
    const steps = [
        { id: 'transcribing', label: 'Analyzing Audio' },
        { id: 'aligning', label: 'Aligning Script' },
        { id: 'slicing', label: 'Precision Cutting' },
        { id: 'videomatching', label: 'AI Video Matching' }
    ];

    const getCurrentStepIndex = () => {
        if (state.status === 'completed') return 4;
        return steps.findIndex(s => s.id === state.status);
    };

    const currentStep = getCurrentStepIndex();

    return (
        <motion.div
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
            className={`p-6 rounded-2xl bg-gradient-to-r from-[#050505]/95 to-[#111]/95 border border-white/10 shadow-2xl relative overflow-hidden backdrop-blur-md` // Sticky removed from here, handled by wrapper
            }
        >
            {/* Background Glow - Rendered once */}
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#FF0055] to-transparent opacity-50" />

            <div className="flex flex-col md:flex-row items-center justify-between gap-6 relative z-10">
                <div className="flex items-center gap-4">
                    <div className="relative">
                        <div className="w-12 h-12 rounded-full bg-[#FF0055]/10 flex items-center justify-center border border-[#FF0055]/20">
                            <SparklesIcon className="w-6 h-6 text-[#FF0055] animate-pulse" />
                        </div>
                        {/* Spinner Ring - CSS Animation */}
                        <svg className="absolute inset-0 w-12 h-12 animate-spin-slow" viewBox="0 0 100 100">
                            <circle cx="50" cy="50" r="48" fill="none" strokeWidth="2" stroke="#FF0055" strokeOpacity="0.3" strokeDasharray="40 100" />
                        </svg>
                    </div>

                    <div>
                        <h3 className="text-lg font-bold text-white tracking-tight">Processing Pipeline</h3>
                        <p className="text-xs text-[#FF0055] font-mono uppercase tracking-widest">{state.message}</p>
                    </div>
                </div>

                {/* Steps Visualizer */}
                <div className="flex items-center gap-2">
                    {steps.map((step, idx) => (
                        <div key={step.id} className="flex items-center">
                            <div className={`
                w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold transition-all duration-500
                ${idx < currentStep ? 'bg-[#FF0055] text-white' : idx === currentStep ? 'bg-white text-black scale-110 shadow-[0_0_15px_rgba(255,255,255,0.3)]' : 'bg-white/5 text-gray-600'}
              `}>
                                {idx + 1}
                            </div>
                            {idx < steps.length - 1 && (
                                <div className={`w-8 h-0.5 transition-colors duration-500 ${idx < currentStep ? 'bg-[#FF0055]' : 'bg-white/5'}`} />
                            )}
                        </div>
                    ))}
                </div>
            </div>

            {/* Optimized Progress Bar - Transform instead of Width */}
            <div className="mt-6 h-1 bg-white/5 rounded-full overflow-hidden">
                <div
                    className="h-full bg-gradient-to-r from-[#FF0055] to-[#FF5588] transition-transform duration-300 ease-out origin-left"
                    style={{ transform: `scaleX(${state.progress / 100})`, width: '100%' }}
                />
            </div>
        </motion.div>
    );
});

const CompactVideoThumb: React.FC<{ video: VideoResult }> = memo(({ video }) => (
    <a
        href={video.url}
        target="_blank"
        rel="noopener noreferrer"
        className="group/video relative aspect-video rounded-lg overflow-hidden bg-black/40 border border-white/5 hover:border-[#FF0055]/30 transition-all cursor-pointer block shadow-md hover:scale-[1.02]"
        title={`Open: ${video.title}`}
    >
        {video.thumbnail ? (
            <img
                src={video.thumbnail}
                alt={video.title}
                className="w-full h-full object-cover opacity-80 group-hover/video:opacity-100 transition-opacity"
                loading="lazy"
                decoding="async"
            />
        ) : (
            <div className="w-full h-full flex items-center justify-center bg-white/5">
                <FilmIcon className="w-6 h-6 text-gray-700" />
            </div>
        )}

        <div className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/90 backdrop-blur text-white text-[9px] font-mono rounded-sm border border-white/10">
            {video.duration || '0:00'}
        </div>

        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover/video:opacity-100 transition-opacity flex items-center justify-center">
            <ArrowTopRightOnSquareIcon className="w-4 h-4 text-white" />
        </div>

        <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black to-transparent opacity-0 group-hover/video:opacity-100 transition-opacity">
            <p className="text-[10px] text-white font-medium truncate">{video.title}</p>
        </div>
    </a>
));

const CompactVideoGrid: React.FC<{ videos: VideoResult[] }> = memo(({ videos }) => {
    const [expanded, setExpanded] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Show top 3 by default
    const displayedVideos = expanded ? videos : videos.slice(0, 3);

    const handleToggle = () => {
        if (expanded) {
            // We are collapsing. Scroll to container top to prevent lost context.
            // Small offset to account for sticky header
            if (containerRef.current) {
                const y = containerRef.current.getBoundingClientRect().top + window.scrollY - 180; // 180px offset for headers
                window.scrollTo({ top: y, behavior: 'smooth' });
            }
        }
        setExpanded(!expanded);
    };

    return (
        <div className="w-full" ref={containerRef}>
            <div className="grid grid-cols-3 gap-3 transition-all duration-300">
                {displayedVideos.map((video, idx) => (
                    <CompactVideoThumb key={`${video.url}-${idx}`} video={video} />
                ))}
            </div>

            {videos.length > 3 && (
                <div className="mt-3 flex justify-center">
                    <button
                        onClick={handleToggle}
                        className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-500 hover:text-white transition-colors bg-white/5 hover:bg-white/10 px-4 py-1.5 rounded-full border border-white/5"
                    >
                        {expanded ? (
                            <>Show Less <ChevronUpIcon className="w-3 h-3" /></>
                        ) : (
                            <>View {videos.length - 3} More Matches <ChevronDownIcon className="w-3 h-3" /></>
                        )}
                    </button>
                </div>
            )}
        </div>
    );
});

// --- ISOLATED COMPONENTS TO PREVENT APP RE-RENDERS ---

interface SourcePlayerProps {
    audioFile: File | null;
}

const SourceAudioPlayer: React.FC<SourcePlayerProps> = memo(({ audioFile }) => {
    const [sourceProgress, setSourceProgress] = useState(0);
    const [sourcePlaying, setSourcePlaying] = useState(false);
    const [sourceDuration, setSourceDuration] = useState(0);
    const sourceAudioRef = useRef<HTMLAudioElement | null>(null);

    // Reset when file changes
    useEffect(() => {
        setSourceProgress(0);
        setSourcePlaying(false);
        setSourceDuration(0);
        if (sourceAudioRef.current) {
            sourceAudioRef.current.pause();
            sourceAudioRef.current = null;
        }
    }, [audioFile]);

    const toggleSourcePlay = useCallback(() => {
        if (!audioFile) return;

        if (!sourceAudioRef.current) {
            const url = URL.createObjectURL(audioFile);
            const audio = new Audio(url);
            sourceAudioRef.current = audio;

            audio.onloadedmetadata = () => {
                setSourceDuration(audio.duration);
            };
            audio.ontimeupdate = () => {
                if (audio.duration) setSourceProgress((audio.currentTime / audio.duration) * 100);
            };
            audio.onended = () => setSourcePlaying(false);
        }

        if (sourcePlaying) {
            sourceAudioRef.current.pause();
            setSourcePlaying(false);
        } else {
            sourceAudioRef.current.play();
            setSourcePlaying(true);
        }
    }, [audioFile, sourcePlaying]);

    const seekSource = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        if (!sourceAudioRef.current) return;
        const percent = parseFloat(e.target.value);
        sourceAudioRef.current.currentTime = (percent / 100) * sourceAudioRef.current.duration;
        setSourceProgress(percent);
    }, []);

    const skipSource = useCallback((seconds: number) => {
        if (!sourceAudioRef.current) return;
        sourceAudioRef.current.currentTime = Math.min(Math.max(sourceAudioRef.current.currentTime + seconds, 0), sourceAudioRef.current.duration);
    }, []);

    const formatTime = (time: number) => {
        if (!time || isNaN(time)) return "00:00";
        const minutes = Math.floor(time / 60);
        const seconds = Math.floor(time % 60);
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    };

    if (!audioFile) return null;

    return (
        <div className="p-4 rounded-xl bg-black/40 border border-white/10 space-y-3">
            <div className="flex items-center gap-3">
                <button
                    onClick={toggleSourcePlay}
                    className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${sourcePlaying ? 'bg-[#FF0055] text-white shadow-[0_0_15px_#FF0055]' : 'bg-white/10 text-white hover:bg-white/20'}`}
                >
                    {sourcePlaying ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5 ml-1" />}
                </button>

                <div className="flex-1">
                    <SonicScrubber
                        value={sourceProgress}
                        onChange={seekSource}
                    />
                    <div className="flex justify-between text-[10px] font-mono text-gray-500 mt-1.5">
                        <span>{sourceAudioRef.current ? formatTime(sourceAudioRef.current.currentTime) : "00:00"}</span>
                        <span>{formatTime(sourceDuration)}</span>
                    </div>
                </div>
            </div>

            <div className="flex justify-center gap-6 border-t border-white/5 pt-2">
                <button onClick={() => skipSource(-5)} className="text-[10px] font-bold text-gray-500 hover:text-white flex items-center gap-1 transition-colors uppercase tracking-wider">
                    <BackwardIcon className="w-3 h-3" /> Back 5s
                </button>
                <button onClick={() => skipSource(5)} className="text-[10px] font-bold text-gray-500 hover:text-white flex items-center gap-1 transition-colors uppercase tracking-wider">
                    Fwd 5s <ForwardIcon className="w-3 h-3" />
                </button>
            </div>
        </div>
    );
});


const BlockAudioPlayer: React.FC<{
    blobUrl: string;
    isPlaying: boolean;
    onPlayToggle: () => void;
}> = memo(({ blobUrl, isPlaying, onPlayToggle }) => {
    const audioRef = useRef<HTMLAudioElement | null>(null);
    const [progress, setProgress] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);

    // Sync global playing state with local audio element
    useEffect(() => {
        if (!audioRef.current) return;

        if (isPlaying) {
            const playPromise = audioRef.current.play();
            if (playPromise !== undefined) {
                playPromise.catch(error => {
                    console.error("Playback failed:", error);
                });
            }
        } else {
            audioRef.current.pause();
        }
    }, [isPlaying]);

    const handleTimeUpdate = () => {
        if (!audioRef.current) return;
        const curr = audioRef.current.currentTime;
        const dur = audioRef.current.duration;
        if (dur > 0) {
            setCurrentTime(curr);
            setProgress((curr / dur) * 100);
        }
    };

    const handleLoadedMetadata = () => {
        if (audioRef.current) {
            setDuration(audioRef.current.duration);
        }
    };

    const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!audioRef.current) return;
        const val = parseFloat(e.target.value);
        const time = (val / 100) * duration;
        audioRef.current.currentTime = time;
        setProgress(val);
        setCurrentTime(time);
    };

    const handleEnded = () => {
        if (isPlaying) onPlayToggle(); // Turn off playing state
    };

    const formatTime = (t: number) => {
        if (isNaN(t)) return "0:00";
        const m = Math.floor(t / 60);
        const s = Math.floor(t % 60);
        return `${m}:${s.toString().padStart(2, '0')}`;
    };

    return (
        <div className="flex items-center gap-3 flex-1 min-w-0">
            <button
                onClick={(e) => { e.stopPropagation(); onPlayToggle(); }}
                className={`w-8 h-8 rounded-full flex-shrink-0 flex items-center justify-center transition-all ${isPlaying ? 'bg-[#FF0055] text-white shadow-[0_0_10px_rgba(255,0,85,0.4)]' : 'bg-white/10 text-white hover:bg-white/20'}`}
            >
                {isPlaying ? <PauseIcon className="w-4 h-4" /> : <PlayIcon className="w-4 h-4 ml-0.5" />}
            </button>

            <div className="flex-1 flex flex-col justify-center gap-1">
                <div className="relative w-full h-1.5 bg-white/10 rounded-full overflow-hidden group/seek cursor-pointer">
                    <input
                        type="range"
                        min="0"
                        max="100"
                        step="0.1"
                        value={progress}
                        onChange={handleSeek}
                        onClick={(e) => e.stopPropagation()}
                        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    />
                    <div
                        className="absolute left-0 top-0 bottom-0 bg-[#FF0055] rounded-full transition-all duration-100 ease-out"
                        style={{ width: `${progress}%` }}
                    />
                    {/* Hover hint logic could go here, but omitted for simplicity */}
                </div>
                <div className="flex justify-between items-center text-[9px] font-mono text-gray-400">
                    <span>{formatTime(currentTime)}</span>
                    <span>{formatTime(duration)}</span>
                </div>
            </div>

            <audio
                ref={audioRef}
                src={blobUrl}
                onTimeUpdate={handleTimeUpdate}
                onLoadedMetadata={handleLoadedMetadata}
                onEnded={handleEnded}
                className="hidden"
            />
        </div>
    );
});


const ResultBlockItem: React.FC<{
    block: StoryBlock;
    blockIndex: number;
    playingId: string | null;
    isExpanded: boolean;
    onToggleExpand: (id: string) => void;
    onPlay: (url: string) => void;
    onRetry: (idx: number, b: StoryBlock) => void;
}> = memo(({ block, blockIndex, playingId, isExpanded, onToggleExpand, onPlay, onRetry }) => {

    const isPlaying = playingId === block.blobUrl;

    return (
        <LiquidCard className={`!p-0 border-white/5 overflow-hidden ${isPlaying ? 'ring-1 ring-[#FF0055]/50' : ''}`}>
            <div className="p-4 border-b border-white/5 bg-white/5 flex items-center justify-between gap-4">
                <div className="flex items-center gap-3 shrink-0">
                    <div className="w-6 h-6 rounded-full bg-[#FF0055] text-white flex items-center justify-center text-[10px] font-bold">
                        {blockIndex + 1}
                    </div>
                    <div className="flex flex-col justify-center min-h-[3em] flex-1">
                        {(() => {
                            // Smart Title Splitter (Inline for strict 3-line requirement)
                            const text = block.title || "";
                            const clean = text.replace(/\s+/g, ' ').trim();

                            let lines = ["", "", ""];

                            // 1. Try splitting by major punctuation
                            const parts = clean.split(/—|:| - /).map(s => s.trim()).filter(Boolean);

                            if (parts.length >= 3) {
                                lines = parts.slice(0, 3);
                            } else if (parts.length === 2) {
                                // Split the longer part
                                const [p1, p2] = parts;
                                if (p1.length > p2.length * 1.5) {
                                    // Split p1
                                    const mid = Math.floor(p1.length / 2);
                                    const splitIdx = p1.lastIndexOf(' ', mid);
                                    lines = [
                                        p1.substring(0, splitIdx === -1 ? mid : splitIdx).trim(),
                                        p1.substring(splitIdx === -1 ? mid : splitIdx).trim(),
                                        p2
                                    ];
                                } else {
                                    // Split p2 or keep balanced
                                    const mid = Math.floor(p2.length / 2);
                                    const splitIdx = p2.lastIndexOf(' ', mid);
                                    lines = [
                                        p1,
                                        p2.substring(0, splitIdx === -1 ? mid : splitIdx).trim(),
                                        p2.substring(splitIdx === -1 ? mid : splitIdx).trim()
                                    ];
                                }
                            } else {
                                // No punctuation, split by length into 3
                                const words = clean.split(' ');
                                if (words.length <= 3) {
                                    lines = [words[0] || "", words[1] || "", words[2] || ""];
                                } else {
                                    const targetLen = clean.length / 3;
                                    let current = "";
                                    let lineIdx = 0;

                                    words.forEach(word => {
                                        if (lineIdx >= 2) {
                                            lines[2] += (lines[2] ? " " : "") + word;
                                        } else {
                                            if ((current.length + word.length) > targetLen && current.length > 0) {
                                                lines[lineIdx] = current;
                                                current = word;
                                                lineIdx++;
                                            } else {
                                                current += (current ? " " : "") + word;
                                            }
                                        }
                                    });
                                    if (lineIdx < 3) lines[lineIdx] = current;
                                }
                            }

                            return lines.map((line, i) => (
                                <span key={i} className={`block text-xs font-bold text-white tracking-wide uppercase leading-snug ${!line ? 'invisible' : ''} ${i === 0 ? 'text-white/95' : i === 1 ? 'text-white/85' : 'text-white/75'}`}>
                                    {line || "-"}
                                </span>
                            ));
                        })()}
                    </div>

                    {/* Copy Button (Right Side) */}
                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            navigator.clipboard.writeText(block.title);
                        }}
                        className="p-1.5 text-gray-500 hover:text-white rounded-md hover:bg-white/10 transition-colors group/copy relative shrink-0"
                        title="Copy Title"
                    >
                        <ClipboardIcon className="w-4 h-4" />
                        <span className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black text-white text-[9px] px-2 py-1 rounded opacity-0 group-active/copy:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                            Copied!
                        </span>
                    </button>
                </div>

                {/* NEW AUDIO PLAYER WITH TIMELINE */}
                {block.blobUrl && (
                    <BlockAudioPlayer
                        blobUrl={block.blobUrl}
                        isPlaying={isPlaying}
                        onPlayToggle={() => onPlay(block.blobUrl!)}
                    />
                )}
            </div>

            <div className="p-6 space-y-4">
                {/* Script Text */}
                <div>
                    <h4 className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 flex items-center gap-2">
                        <span className="w-1.5 h-1.5 rounded-full bg-[#FF0055]"></span>
                        Script Segment
                    </h4>
                    <p className="text-sm text-gray-300 leading-relaxed font-medium pl-3 border-l-2 border-[#FF0055]/30">
                        {block.text}
                    </p>
                </div>

                {/* Video Matches */}
                <div className="bg-black/20 rounded-xl p-4 border border-white/5">
                    <div className="flex items-center justify-between mb-3">
                        <h4 className="text-xs font-bold text-gray-500 uppercase tracking-widest flex items-center gap-2">
                            <FilmIcon className="w-3 h-3" />
                            MATCHED FOOTAGE
                        </h4>
                        {block.videoStatus === 'searching' && (
                            <span className="text-[10px] text-[#FF0055] animate-pulse">SEARCHING...</span>
                        )}
                    </div>

                    {/* ATTEMPT LOGGER */}
                    {block.attemptsLog && block.attemptsLog.length > 0 && (
                        <div className="mb-3 space-y-1 bg-black/30 p-2 rounded border border-white/5">
                            {block.attemptsLog.map((attempt, i) => (
                                <div key={i} className={`text-[10px] flex items-center gap-2 ${attempt.status === 'success' ? 'text-green-400 font-bold' : 'text-gray-400'}`}>
                                    {attempt.status === 'success' ? (
                                        <div className="w-3 h-3 rounded-full bg-green-500/20 flex items-center justify-center border border-green-500/50">
                                            <span className="text-[8px]">✓</span>
                                        </div>
                                    ) : (
                                        <XCircleIcon className="w-3 h-3 text-red-500 shrink-0" />
                                    )}
                                    <span>"{attempt.query}"</span>
                                    <span className="opacity-50 text-[9px]">- {attempt.reason}</span>
                                </div>
                            ))}
                        </div>
                    )}

                    {block.videoStatus === 'searching' && (
                        <div className="py-4 text-center space-y-2">
                            <div className="inline-block w-4 h-4 border-2 border-[#FF0055] border-t-transparent rounded-full animate-spin"></div>
                            <p className="text-[10px] text-gray-500 font-mono">
                                {block.currentQueryMessage || "Analyzing context..."}
                            </p>
                        </div>
                    )}

                    {block.videoStatus === 'error' && (
                        <div className="flex items-center justify-between py-2">
                            <span className="text-xs text-red-400">Match failed.</span>
                            <button
                                onClick={() => onRetry(blockIndex, block)}
                                className="text-[10px] bg-white/5 px-2 py-1 rounded hover:bg-white/10 transition-colors"
                            >
                                Retry
                            </button>
                        </div>
                    )}

                    {block.videoStatus === 'complete' && block.videoMatches && (
                        <CompactVideoGrid videos={block.videoMatches} />
                    )}

                    {block.videoStatus === 'complete' && (!block.videoMatches || block.videoMatches.length === 0) && (
                        <div className="text-center py-4">
                            <p className="text-xs text-gray-500">No exact matches found.</p>
                            <button
                                onClick={() => onRetry(blockIndex, block)}
                                className="mt-2 text-[10px] text-[#FF0055] hover:underline"
                            >
                                Try Broad Search
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </LiquidCard>
    );
});


// --- Main App ---
import { UpdateNotification } from './components/UpdateNotification';

function App() {
    // State - Core Data
    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [scriptText, setScriptText] = useState<string>("");
    const [scriptSummary, setScriptSummary] = useState<string | null>(null);
    const [storyBlocks, setStoryBlocks] = useState<StoryBlock[]>([]);
    const [procState, setProcState] = useState<ProcessingState>({ status: 'idle', progress: 0, message: '' });
    const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());
    const [playingId, setPlayingId] = useState<string | null>(null);

    // Update State
    const [updateStatus, setUpdateStatus] = useState<any>({ status: 'idle', progress: 0 });

    // UI State
    const [showSettings, setShowSettings] = useState(false);
    const [apiKeyInput, setApiKeyInput] = useState('');

    // --- PROJECT MANAGEMENT STATE ---
    const [currentView, setCurrentView] = useState<'start' | 'editor'>('start');
    const [currentProject, setCurrentProject] = useState<ProjectData | null>(null);
    const [resumeableProject, setResumeableProject] = useState<ProjectData | null>(null);
    const [recentProjects, setRecentProjects] = useState<ProjectData[]>([]); // RESTORED
    const isRestoringRef = useRef(false);

    // AUTO-UPDATE LISTENERS
    useEffect(() => {
        if ((window as any).electron) {
            const electron = (window as any).electron;

            // Listeners
            electron.receive('update-available', (info: any) => {
                console.log("Update available:", info);
                setUpdateStatus({ status: 'available', version: info.version });
            });

            electron.receive('update-progress', (progressObj: any) => {
                setUpdateStatus((prev: any) => ({ ...prev, status: 'downloading', progress: progressObj.percent }));
            });

            electron.receive('update-downloaded', (info: any) => {
                setUpdateStatus((prev: any) => ({ ...prev, status: 'ready', version: prev.version }));
            });

            electron.receive('update-error', (err: any) => {
                console.error("Update error:", err);
                // Switch status to error to remove "Checking..." loader
                setUpdateStatus((prev: any) => ({
                    status: 'error',
                    message: "Could not connect to update server."
                }));
                // Auto-hide error after 4 seconds
                setTimeout(() => {
                    setUpdateStatus((prev: any) => ({ ...prev, status: 'idle' }));
                }, 4000);
            });

            electron.receive('update-status', (statusObj: any) => {
                console.log("Update status:", statusObj);
                setUpdateStatus((prev: any) => ({ ...prev, ...statusObj }));

                // Auto-hide "latest" or "error" message after 3 seconds
                if (statusObj.status === 'latest' || statusObj.status === 'error') {
                    setTimeout(() => {
                        setUpdateStatus((prev: any) => ({ ...prev, status: 'idle' }));
                    }, 4000);
                }
            });

            // Initial check logic could go here if we wanted to auto-check on mount
            // electron.invoke('check-for-updates'); 
        }
    }, []);

    const handleDownloadUpdate = () => {
        if ((window as any).electron) {
            (window as any).electron.invoke('start-update-download');
        }
    };

    const handleInstallUpdate = () => {
        if ((window as any).electron) {
            (window as any).electron.invoke('quit-and-install');
        }
    };

    // Load Session on Mount - Updated to NOT auto-restore, but show Resume Prompt if needed
    // The user wants control: "se debe guardar por donde va... pero si se cierra completamente debe salir algo como 'Queres volver a dejar pordonde ibas'"
    useEffect(() => {
        const loadSession = async () => {
            const lastSession = await projectService.loadSession();
            if (lastSession && (lastSession.scriptText || (lastSession.storyBlocks && lastSession.storyBlocks.length > 0))) {
                console.log("Found previous session, awaiting user confirmation to resume.");
                // We don't restore automatically. We let the user choose from the Start Screen or via a Prompt.
                // However, for now, we simply ensure we start on 'start' view.
                setResumeableProject(lastSession);
                setCurrentView('start');

                // Optional: We could set a flag to show a "Resume" banner on the Start Screen
                // setHasResumeableSession(true); 
            } else {
                setCurrentView('start');
            }
        };
        loadSession();
    }, []);

    // Auto-Save Effect
    useEffect(() => {
        if (currentView === 'editor' && currentProject) {
            const timeout = setTimeout(async () => {
                // LOCK CHECK: Do not save if we are currently restoring state
                if (isRestoringRef.current) {
                    console.log('[AutoSave] Skipped due to active restoration');
                    return;
                }

                // Only save non-processing states to avoid frozen UI on restore
                const safeState = (procState.status === 'idle' ||
                    procState.status === 'completed' ||
                    procState.status === 'error')
                    ? procState
                    : { status: 'idle' as const, progress: 0, message: '' };

                await projectService.saveSession({
                    id: currentProject.id,
                    name: currentProject.name,
                    scriptText,
                    storyBlocks,
                    procState: safeState, // Only save safe states
                    audioName: audioFile?.name
                });
            }, 2000);
            return () => clearTimeout(timeout);
        }
    }, [scriptText, storyBlocks, procState, currentProject, currentView, audioFile]);


    // --- TRAY ICON SYNC ---
    // Automatically keeps the system tray icon in sync with the app's processing state
    useEffect(() => {
        if ((window as any).electron?.tray) {
            (window as any).electron.tray.updateProgress({
                status: procState.status,
                progress: procState.progress,
                message: procState.message,
                // If we are in the editor and have a project, we consider it 'active' context
                activeProjects: (currentView === 'editor' && currentProject) ? 1 : 0
            });
        }
    }, [procState, currentView, currentProject]);


    const restoreProject = (proj: ProjectData) => {
        console.log('[Restore] Restoring project:', proj.name);

        // ENABLE LOCK
        isRestoringRef.current = true;

        setCurrentProject(proj);
        // Force string primitive to avoid "random things" object injection bugs
        setScriptText(typeof proj.scriptText === 'string' ? proj.scriptText : "");

        // Deep clone storyBlocks to ensure re-render
        if (proj.storyBlocks && Array.isArray(proj.storyBlocks) && proj.storyBlocks.length > 0) {
            setStoryBlocks([...proj.storyBlocks]);
        } else {
            setStoryBlocks([]);
        }

        // Restore Processing State & Sync Tray
        if (proj.storyBlocks && proj.storyBlocks.length > 0) {

            // CHECK FOR INCOMPLETE STATE
            // If any block is NOT complete, or if the stored state was processing/videomatching
            const hasIncompleteBlocks = proj.storyBlocks.some(b => b.videoStatus !== 'complete');

            if (hasIncompleteBlocks) {
                console.log("[Restore] Detected incomplete blocks. Auto-Resuming...");
                const script = typeof proj.scriptText === 'string' ? proj.scriptText : "";
                setProcState({ status: 'videomatching', progress: 50, message: 'Resuming Search...' }); // Update UI immediately

                // Trigger Restart (with slight delay to allow state to settle)
                setTimeout(() => {
                    if (isCancelledRef.current) isCancelledRef.current = false; // Reset cancel flag
                    // User requested FULL RESTART ("reiniciar todo") to avoid duplicates. 
                    // We pass 'false' for skipReset to force a clean slate.
                    matchVideosForBlocks(proj.storyBlocks, script, false);
                }, 500);

            } else {
                // All complete
                const completedState = { status: 'completed' as const, progress: 100, message: 'Restored from Session' };
                setProcState(completedState);

                // FORCE TRAY SYNC
                if ((window as any).electron?.tray) {
                    (window as any).electron.tray.updateProgress({
                        status: 'completed',
                        progress: 100,
                        message: 'Project Restored',
                        activeProjects: 1
                    });
                }
            }
        } else {
            setProcState({ status: 'idle', progress: 0, message: '' });
            if ((window as any).electron?.tray) {
                (window as any).electron.tray.updateProgress({ status: 'idle', progress: 0, message: 'Ready' });
            }
        }

        // Reset interactive states
        setExpandedBlocks(new Set());
        setPlayingId(null);
        setAudioFile(null);

        // Logic for view navigation
        if (proj.scriptText || (proj.storyBlocks && proj.storyBlocks.length > 0)) {
            setCurrentView('editor');
        } else {
            setCurrentView('start');
        }

        // RELEASE LOCK after state settles (1.5s safety buffer)
        setTimeout(() => {
            isRestoringRef.current = false;
            console.log('[Restore] Lock released. Auto-save enabled.');
        }, 1500);
    };

    const handleNewProject = async (name?: string) => {
        // Use provided name or default to Project {Date} (Logic inside createNew or here)
        // projectService.createNew() creates "Project {Date}" by default.
        // We can override it.
        const newProj = projectService.createNew();
        if (name) newProj.name = name; // Override with user input

        await projectService.clearSession();
        setCurrentProject(newProj);
        setAudioFile(null);
        setScriptText("");
        setStoryBlocks([]);
        setProcState({ status: 'idle', progress: 0, message: '' });
        setCurrentView('editor');
    };

    const handleDeleteProject = async (id: string) => {
        await projectService.deleteProject(id);
        const list = await projectService.getRecentProjects();
        setRecentProjects(list);
    };

    const handleResumeSession = () => {
        if (resumeableProject) {
            console.log("User confirmed resume:", resumeableProject.name);
            restoreProject(resumeableProject);
        }
    };

    // Load recent projects
    useEffect(() => {
        const loadRecents = async () => {
            const list = await projectService.getRecentProjects();
            setRecentProjects(list);
        };
        loadRecents();
    }, [currentView]); // Reload when switching views to ensure freshness

    const handleOpenProject = async (proj: ProjectData) => {
        // Smart Resume: If opening the exact same project that is currently in memory, just switch view
        // This preserves the running process/background state without reloading
        if (currentProject && currentProject.id === proj.id) {
            console.log("Resuming active project:", proj.name);
            setCurrentView('editor');
            return;
        }

        // Otherwise, perform full load
        await projectService.openProject(proj);
        restoreProject(proj);
    };

    // Helper: Generate project title from script content
    const generateProjectTitle = (script: string, segments: AlignedSegment[]): string => {
        if (segments.length === 0) return `Project ${new Date().toLocaleDateString()}`;

        // Use first segment title or first few words of script
        const firstTitle = segments[0]?.title;
        if (firstTitle && firstTitle.length > 3) {
            // Clean and truncate
            return firstTitle.substring(0, 40).trim();
        }

        // Fallback: Use first 40 chars of script
        const cleanScript = script.replace(/\[ON SCREEN:.*?\]/g, '').trim();
        const preview = cleanScript.substring(0, 40).trim();
        return preview || `Project ${new Date().toLocaleDateString()}`;
    };

    const handleBackToStart = async () => {
        if (currentProject) {
            await projectService.saveSession({
                id: currentProject.id,
                name: currentProject.name,
                scriptText,
                storyBlocks
            });
        }
        setCurrentView('start');
    };

    // Toggle block expansion
    const toggleBlockExpansion = useCallback((blockId: string) => {
        setExpandedBlocks(prev => {
            const next = new Set(prev);
            if (next.has(blockId)) next.delete(blockId);
            else next.add(blockId);
            return next;
        });
    }, []);

    // --- API Key Management ---

    const updateApiKey = async () => {
        if (!apiKeyInput || apiKeyInput.length < 10) {
            addToast('Invalid Key', 'Please enter a valid Gemini API Key', 'error');
            return;
        }

        try {
            const res = await fetch(`${API_BASE_URL}/api/config/key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: apiKeyInput })
            });

            const data = await res.json();
            if (data.success) {
                addToast('Key Updated', 'API Key saved successfully. Restart NOT required.', 'success');
                setShowSettings(false);
                setApiKeyInput('');
            } else {
                throw new Error(data.error);
            }
        } catch (e: any) {
            addToast('Update Failed', e.message, 'error');
        }
    };

    // --- Refs ---
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // --- Effects ---

    // Completion Notification
    useEffect(() => {
        if (procState.status === 'completed') {

            // SKIP Notification if just restored
            if (procState.message.includes('Restored')) {
                return;
            }

            // 1. Audio Notification (Text-to-Speech)
            try {
                // Cancel any potentially playing speech first
                window.speechSynthesis.cancel();

                const utterance = new SpeechSynthesisUtterance("Task Completed");
                utterance.lang = 'en-US'; // Ensure English as requested
                utterance.volume = 1.0;
                utterance.rate = 1.0;
                utterance.pitch = 1.0;

                window.speechSynthesis.speak(utterance);
            } catch (e) {
                console.warn("Speech synthesis failed:", e);
                // Fallback beep if speech fails
                try {
                    const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
                    const osc = ctx.createOscillator();
                    osc.connect(ctx.destination);
                    osc.frequency.value = 880;
                    osc.start();
                    osc.stop(0.2);
                } catch (err) {
                    console.error("Fallback audio failed:", err);
                }
            }

            // 2. System Notification
            const showSystemNotification = () => {
                if ("Notification" in window) {
                    try {
                        new Notification("Task Completed!", {
                            body: "The video matching process has finished successfully.",
                            icon: "/favicon.ico",
                            silent: true // We handle sound manually
                        });
                    } catch (e) {
                        console.error("Notification creation failed:", e);
                    }
                }
            };

            if ("Notification" in window) {
                if (Notification.permission === "granted") {
                    showSystemNotification();
                } else if (Notification.permission !== "denied") {
                    Notification.requestPermission().then(permission => {
                        if (permission === "granted") {
                            showSystemNotification();
                        }
                    });
                }
            }

            // 3. In-App Toast (Extra visibility)
            addToast('Success', 'Task Completed! All segments are ready.', 'success');
        }
    }, [procState.status]);

    // Toast State
    const [toasts, setToasts] = useState<ToastMessage[]>([]);

    const addToast = (title: string, message: string, type: ToastType = 'info') => {
        const id = Math.random().toString(36).substr(2, 9);
        setToasts(prev => [...prev, { id, title, message, type }]);
    };

    const removeToast = (id: string) => {
        setToasts(prev => prev.filter(t => t.id !== id));
    };

    // Note: Source Audio Logic moved to SourceAudioPlayer component

    const eventSourceRef = useRef<EventSource | null>(null);
    const isCancelledRef = useRef<boolean>(false);

    // --- Handlers ---

    // Cancel Processing Handler
    const cancelProcessing = useCallback(() => {
        isCancelledRef.current = true;
        if (eventSourceRef.current) {
            eventSourceRef.current.close();
            eventSourceRef.current = null;
        }
        setProcState({ status: 'idle', progress: 0, message: 'Cancelled' });
        addToast('Process Cancelled', 'The generation was stopped by user.', 'info');
    }, []);

    const handleAudioSelect = useCallback((file: File) => {
        setAudioFile(file);
        // Reset blocks when new audio selected?
        setProcState({ status: 'idle', progress: 0, message: '' });
    }, []);


    // --- CORE PIPELINE ---

    const startProcessing = async () => {
        if (!audioFile || !scriptText.trim()) return;

        // Reset Cancellation Flag
        isCancelledRef.current = false;

        // Update tray: Processing started
        if ((window as any).electron?.tray) {
            (window as any).electron.tray.updateProgress({
                status: 'processing',
                progress: 0,
                message: 'Starting...',
                activeProjects: 1
            });
        }

        try {
            // 1. Transcribe (Voiceover Pipeline)
            setProcState({ status: 'transcribing', progress: 10, message: 'Analyzing Voice Frequency Spectrum...' });
            if ((window as any).electron?.tray) {
                (window as any).electron.tray.updateProgress({ status: 'processing', progress: 10, message: 'Transcribing audio...' });
            }
            const assemblyData = await transcribeWithAssembly(audioFile);

            if (isCancelledRef.current) return;

            // 2. Align (Voiceover Pipeline)
            setProcState({ status: 'aligning', progress: 30, message: 'Synchronizing Temporal Nodes...' });
            // await new Promise(r => setTimeout(r, 600)); // Dramatic pause REMOVED for speed
            const aligned = await alignScriptDeterministic(scriptText, assemblyData.words);

            if (isCancelledRef.current) return;

            if (!aligned || aligned.length === 0) {
                throw new Error("Alignment Failed: Please ensure your script contains '[ON SCREEN: ...]' markers.");
            }

            // 3. Slice (Voiceover Pipeline)
            setProcState({ status: 'slicing', progress: 50, message: 'Rendering Precision Audio Cuts...' });
            const decodedBuffer = await decodeAudio(audioFile);
            const processedBlocks: StoryBlock[] = [];

            if (isCancelledRef.current) return;

            for (const [idx, segment] of aligned.entries()) {
                if (segment.start_time < 0) segment.start_time = 0;
                if (segment.end_time > decodedBuffer.duration) segment.end_time = decodedBuffer.duration;

                if (segment.end_time > segment.start_time) {
                    const sliceBlob = await sliceAudioBuffer(decodedBuffer, segment.start_time, segment.end_time);
                    const url = URL.createObjectURL(sliceBlob);

                    processedBlocks.push({
                        ...segment,
                        blobUrl: url,
                        duration: segment.end_time - segment.start_time,
                        id: `block-${idx}-${Date.now()}`,
                        videoStatus: 'idle',
                        videoMatches: [],
                        videoCount: 0
                    });
                }
            }

            setStoryBlocks(processedBlocks);

            // Title will be generated AFTER the summary is created during video matching

            if (isCancelledRef.current) return;

            // 4. Video Matching (New Pipeline Integration)
            setProcState({ status: 'videomatching', progress: 60, message: 'AI Finding Relevant Footage...' });
            await matchVideosForBlocks(processedBlocks);

            if (isCancelledRef.current) return;

            setProcState({ status: 'completed', progress: 100, message: 'All Processing Complete!' });

            // Update tray: Completed
            if ((window as any).electron?.tray) {
                (window as any).electron.tray.updateProgress({
                    status: 'completed',
                    progress: 100,
                    message: 'Processing complete!'
                });
            }

        } catch (error: any) {
            if (!isCancelledRef.current) {
                console.error(error);
                setProcState({ status: 'error', progress: 0, message: error.message || 'Processing Failed' });
                addToast('Processing Failed', error.message || 'An unexpected error occurred during the pipeline.', 'error');

                // Update tray: Error
                if ((window as any).electron?.tray) {
                    (window as any).electron.tray.updateProgress({ status: 'idle', progress: 0, message: 'Error occurred' });
                }
            }
        }
    };

    // Video Matching Helper
    const matchVideosForBlocks = async (blocks: StoryBlock[], scriptOverride?: string, skipReset?: boolean) => {
        // Helper to update specific block state
        // We use functional update to access latest state reliably
        const updateBlock = (blockIndex: number, updatesOrFn: ((prev: StoryBlock) => Partial<StoryBlock>) | Partial<StoryBlock>) => {
            setStoryBlocks(prev => prev.map((b, idx) => {
                if (idx !== blockIndex) return b;
                const updates = typeof updatesOrFn === 'function' ? updatesOrFn(b) : updatesOrFn;
                return { ...b, ...updates };
            }));
        };

        // Mark all as idle initially (unless skipping reset for smooth resume)
        // User requested FULL RESTART to avoid duplicate logs vs old state
        if (!skipReset) {
            setStoryBlocks(prev => prev.map(b => ({
                ...b,
                videoStatus: 'idle',
                currentQueryMessage: 'Waiting...',
                videoMatches: [], // Clear old matches
                videoCount: 0,
                attemptsLog: []   // Clear old logs to prevent Duplication
            })));
        }
        setScriptSummary(null);

        try {
            if (isCancelledRef.current) {
                return;
            }

            const scriptToUse = scriptOverride || scriptText;

            // Use Streaming POST (fetch) instead of EventSource to support large scripts without 431 errors
            const response = await fetch(`${API_BASE_URL}/api/video-matching/stream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ script: scriptToUse })
            });

            if (!response.ok || !response.body) {
                throw new Error(`Stream Error: ${response.status} ${response.statusText}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let completedBlocksCount = 0;
            let buffer = '';

            while (true) {
                if (isCancelledRef.current) {
                    reader.cancel();
                    break;
                }

                const { done, value } = await reader.read();
                if (done) break;

                // Decode chunk
                const chunk = decoder.decode(value, { stream: true });
                buffer += chunk;

                // Process complete lines (NDJSON)
                const lines = buffer.split('\n');
                // Keep the last partial part in buffer
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (!line.trim()) continue;

                    try {
                        const data = JSON.parse(line);

                        if (data.type === 'context') {
                            setScriptSummary(data.context);
                        }
                        else if (data.type === 'status') {
                            const { blockIndex, status, query, message, fallbackReason, attemptNum } = data;

                            // Map logic
                            let uiStatus: StoryBlock['videoStatus'] = 'searching';

                            updateBlock(blockIndex, (prev) => {
                                let statusMsg = message || prev.currentQueryMessage;
                                if (status === 'analyzing') statusMsg = "Video Matcher: Reading context...";
                                if (status === 'extracted') statusMsg = "Entities Found. Queuing...";
                                if (status === 'searching') statusMsg = `Searching: "${query}"`;
                                if (status === 'fallback') statusMsg = `Attempt ${attemptNum}/5 failed... Retrying`;

                                return {
                                    videoStatus: uiStatus,
                                    currentQueryMessage: statusMsg,
                                    // Append log for every significant attempt/reason
                                    attemptsLog: (status === 'fallback' || status === 'success') && query ?
                                        [...(prev.attemptsLog || []), {
                                            query,
                                            reason: fallbackReason || (status === 'success' ? 'Match Found' : 'Failed'),
                                            status: status === 'success' ? 'success' : 'failed'
                                        }] : prev.attemptsLog
                                };
                            });
                        }
                        else if (data.type === 'block_complete') {
                            const { block } = data;
                            updateBlock(block.index, {
                                videoStatus: block.status || 'complete',
                                videoMatches: block.videos,
                                currentQueryMessage: 'Done',
                                searchQuery: block.finalQuery || block.searchQuery
                            });

                            completedBlocksCount++;
                            // Global Progress Update
                            const total = blocks.length;
                            const progress = 60 + ((completedBlocksCount / total) * 35);
                            setProcState(prev => ({
                                ...prev,
                                progress,
                                message: `Matching Footage (${completedBlocksCount}/${total})...`
                            }));
                        }
                        else if (data.type === 'complete') {
                            // Done
                        }
                        else if (data.type === 'error') {
                            console.error("Stream Error Type:", data.message);
                            addToast("Stream Error", data.message, "error");
                        }

                    } catch (e) {
                        console.error("Error parsing stream line:", e, line);
                    }
                }
            }

        } catch (e: any) {
            console.error("Stream Fetch Failed:", e);
            setProcState(prev => ({ status: 'error', progress: 0, message: `Matching Failed: ${e.message}` }));
        }
    };

    const retryVideoMatch = useCallback(async (blockIndex: number, block: StoryBlock) => {
        setStoryBlocks(prev => prev.map((b, idx) => idx === blockIndex ? { ...b, videoStatus: 'searching', videoMatches: [], currentQueryMessage: 'Retrying...', attemptsLog: [] } : b));

        try {
            const response = await fetch(`${API_BASE_URL}/api/video-matching/research`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    block: {
                        index: blockIndex,
                        headline: block.title,
                        text: block.text
                    }
                })
            });

            const data = await response.json();
            const resultBlock = data.block;

            setStoryBlocks(prev => prev.map((b, idx) => idx === blockIndex ? {
                ...b,
                videoStatus: 'complete',
                videoMatches: resultBlock.videos,
                searchQuery: resultBlock.searchQuery,
                videoCount: resultBlock.videos.length,
                currentQueryMessage: undefined,
                // If the re-search endpoint returned logs, we could set them here, but simple retry implies "fresh" result usually.
                // Or we could display the final path taken.
            } : b));

        } catch (err) {
            setStoryBlocks(prev => prev.map((b, idx) => idx === blockIndex ? { ...b, videoStatus: 'error', currentQueryMessage: 'Retry failed' } : b));
        }
    }, []);

    const playPreview = useCallback((url: string) => {
        // STOP duplicate audio creation. 
        // The BlockAudioPlayer component listens to `playingId` and handles the actual <audio> element.
        // We just need to manage the state here.

        if (playingId === url) {
            setPlayingId(null);
            return;
        }

        setPlayingId(url);
    }, [playingId]);

    const downloadAllSegments = async () => {
        if (storyBlocks.length === 0) return;
        const zip = new JSZip();
        storyBlocks.forEach((seg, idx) => {
            const filename = `segment_${String(idx + 1).padStart(2, '0')}_${seg.title.replace(/[^a-z0-9]/gi, '_')}.wav`;
            zip.file(filename, fetch(seg.blobUrl).then(r => r.blob()));
        });
        try {
            const content = await zip.generateAsync({ type: "blob" });
            const url = URL.createObjectURL(content);
            const a = document.createElement("a");
            a.href = url;
            a.download = `clicksync_project_${new Date().toISOString().slice(0, 10)}.zip`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (e) {
            console.error("Failed to zip", e);
        }
    };

    if (currentView === 'start') {
        return (
            <>
                <TitleBar />
                <UpdateNotification
                    status={updateStatus.status}
                    progress={updateStatus.progress}
                    version={updateStatus.version}
                    onDownload={handleDownloadUpdate}
                    onInstall={handleInstallUpdate}
                    onDismiss={() => setUpdateStatus({ ...updateStatus, status: 'idle' })}
                />
                <StartScreen
                    recents={recentProjects}
                    onNewProject={handleNewProject}
                    onOpenProject={handleOpenProject}
                    onDeleteProject={handleDeleteProject}
                    onResumeSession={handleResumeSession}
                    resumeProject={resumeableProject}
                    onRename={async (id, newName) => {
                        await projectService.renameProject(id, newName);
                        // Refresh list
                        const list = await projectService.getRecentProjects();
                        setRecentProjects(list);
                    }}
                />
            </>
        );
    }

    // --- RENDER EDITOR ---
    return (
        <>
            <TitleBar />
            <UpdateNotification
                status={updateStatus.status}
                progress={updateStatus.progress}
                version={updateStatus.version}
                onDownload={handleDownloadUpdate}
                onInstall={handleInstallUpdate}
                onDismiss={() => setUpdateStatus({ ...updateStatus, status: 'idle' })}
            />
            <ToastContainer toasts={toasts} removeToast={removeToast} />
            <div className="min-h-screen bg-[#050505] flex flex-col"> {/* Full Screen Flex */}
                {/* Main Content Scrollable Area */}
                {/*  PT-0 because Header is sticky top-0 now, but TitleBar is fixed? 
                      TitleBar is usually fixed/absolute. 
                      Let's assume TitleBar needs space. 
                  */}
                <div className="flex-1 max-w-[1920px] w-full mx-auto p-6 md:p-12 pb-40"> {/* Removed pt-16, handling flow differently */}

                    {/* HEADER (Full Width) */}
                    <div className="sticky top-0 z-50 w-full bg-[#050505]/95 backdrop-blur-xl border-b border-white/5 transition-all duration-300">
                        <div className="max-w-[1920px] mx-auto px-6 md:px-12 h-20 flex items-center justify-between">
                            <div className="flex items-center gap-6">
                                {/* Back to Projects Button */}
                                <button
                                    onClick={handleBackToStart}
                                    className="flex items-center gap-2 text-gray-400 hover:text-white transition-colors group"
                                    title="Back to Projects"
                                >
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
                                    </svg>
                                </button>

                                <div className="flex items-baseline gap-2">
                                    <h1 className="text-2xl font-extrabold tracking-tighter text-white">
                                        ClickSync<span className="text-[#FF0055]">.</span>
                                    </h1>
                                    <span className="px-2 py-0.5 rounded bg-white/5 text-[10px] uppercase font-bold text-gray-400 tracking-widest border border-white/5">
                                        Unified Studio
                                    </span>
                                    {currentProject && (
                                        <span className="ml-4 text-xs text-gray-500 font-mono hidden md:inline-block">
                                            / {currentProject.name}
                                        </span>
                                    )}
                                </div>
                            </div>

                            {/* Right Toolbar */}
                            <div className="flex items-center gap-6">
                                {/* Status Pill */}
                                <div className="flex items-center gap-3 bg-white/5 px-4 py-1.5 rounded-full border border-white/5">
                                    <div className={`w-2 h-2 rounded-full ${procState.status === 'error' ? 'bg-red-500' : procState.status !== 'idle' && procState.status !== 'completed' ? 'bg-[#FF0055] animate-pulse' : 'bg-[#00FF88]'} shadow-[0_0_10px_currentColor]`} />
                                    <span className="text-[10px] font-bold font-mono uppercase tracking-widest text-gray-400">
                                        {procState.status === 'idle' ? 'SYSTEM READY' : procState.status}
                                    </span>
                                </div>

                                <div className="h-6 w-[1px] bg-white/10" />

                                <button
                                    onClick={() => setShowSettings(true)}
                                    className="p-2 rounded-full hover:bg-white/5 text-gray-400 hover:text-white transition-colors"
                                    title="API Settings"
                                >
                                    <Cog6ToothIcon className="w-5 h-5" />
                                </button>
                            </div>
                        </div>
                    </div>

                    {/* PROCESSING OVERLAY (Hero) - Now includes stats when completed */}
                    {/* Fixed Sticky Wrapper - Must be outside AnimatePresence for position: sticky to work reliably in some contexts, or ensure parent is tall. 
                    Actually, we'll make the WRAPPER sticky. 
                */}
                    <div className={`transition-all duration-300 z-30 ${procState.status !== 'idle' && procState.status !== 'error' && procState.status !== 'completed' ? 'sticky top-20' : ''}`}>
                        <AnimatePresence>
                            {(procState.status !== 'idle' && procState.status !== 'error') && (
                                <motion.div
                                    initial={{ opacity: 0, y: -20 }}
                                    animate={{ opacity: 1, y: 0 }}
                                    exit={{ opacity: 0 }}
                                    className="mb-0" // Removed margin from motion div, handling in wrapper or parent spacing
                                >
                                    <ProcessingHero state={procState} />
                                </motion.div>
                            )}
                        </AnimatePresence>
                    </div>
                    {/* Spacer if sticky is active to prevent jump? No, sticky takes space. */}
                    {(procState.status !== 'idle' && procState.status !== 'error') && <div className="h-8" />}

                    <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">

                        {/* --- LEFT COLUMN: INPUTS (4 cols) --- */}
                        <div className="xl:col-span-4 flex flex-col gap-6">

                            {/* INPUT CARD 1: AUDIO */}
                            <LiquidCard title="1. Link Audio">
                                <LiquidDropZone
                                    label="Drop Voiceover File"
                                    fileName={audioFile?.name}
                                    accept="audio/*"
                                    onFileSelect={handleAudioSelect}
                                />

                                {/* Isolated Player to prevent full re-renders */}
                                <SourceAudioPlayer audioFile={audioFile} />
                            </LiquidCard>

                            {/* INPUT CARD 2: SCRIPT */}
                            <LiquidCard title="2. Input Script">
                                <LiquidTextArea
                                    placeholder="Paste script with [ON SCREEN: Scene Name] markers..."
                                    value={scriptText}
                                    onChange={(e) => setScriptText(e.target.value)}
                                    disabled={procState.status !== 'idle' && procState.status !== 'completed' && procState.status !== 'error'}
                                    className={`min-h-[300px] text-xs font-mono ${procState.status !== 'idle' && procState.status !== 'completed' && procState.status !== 'error' ? 'opacity-50 cursor-not-allowed' : ''}`}
                                />
                                <div className="pt-4 h-[52px]"> {/* Fixed height container */}
                                    {procState.status === 'idle' || procState.status === 'completed' || procState.status === 'error' ? (
                                        <LiquidButton
                                            disabled={!audioFile || !scriptText?.trim()}
                                            onClick={startProcessing}
                                            className="w-full py-4 text-sm font-bold shadow-lg shadow-[#FF0055]/10 hover:shadow-[#FF0055]/30 disabled:opacity-50 disabled:cursor-not-allowed"
                                        >
                                            <span className="flex items-center justify-center gap-2">
                                                <SparklesIcon className="w-4 h-4" />
                                                GENERATE TIMELINE
                                            </span>
                                        </LiquidButton>
                                    ) : (
                                        <div className="w-full h-12 relative overflow-hidden rounded-xl bg-black/40 border border-[#FF0055]/20 flex items-stretch">
                                            {/* Left Side: Status Text */}
                                            <div className="flex-1 flex items-center gap-3 px-6 relative">
                                                {/* Living Background Effect (Subtle Breathing) */}
                                                <div className="absolute inset-0 bg-[#FF0055]/5 animate-pulse" style={{ animationDuration: '3s' }} />
                                                <div className="absolute -left-10 top-0 bottom-0 w-32 bg-gradient-to-r from-transparent via-[#FF0055]/10 to-transparent blur-xl opacity-50 animate-pulse" />

                                                <div className="relative flex items-center gap-3">
                                                    <div className="relative flex h-2 w-2">
                                                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#FF0055] opacity-75"></span>
                                                        <span className="relative inline-flex rounded-full h-2 w-2 bg-[#FF0055]"></span>
                                                    </div>
                                                    <span className="text-[10px] font-bold text-[#FF0055] tracking-[0.2em] uppercase animate-pulse">
                                                        GENERATING TIMELINE...
                                                    </span>
                                                </div>
                                            </div>

                                            {/* Right Side: Solid Cancel Block */}
                                            <button
                                                onClick={cancelProcessing}
                                                className="px-6 h-full flex items-center justify-center bg-white/5 hover:bg-red-500/20 text-gray-500 hover:text-red-400 transition-colors border-l border-white/10 z-10"
                                                title="Stop Generation"
                                            >
                                                <span className="text-[10px] font-bold uppercase tracking-widest">Stop</span>
                                            </button>
                                        </div>
                                    )}
                                </div>
                            </LiquidCard>

                        </div>

                        {/* --- RIGHT COLUMN: RESULTS (8 cols) --- */}
                        <div className="xl:col-span-8 space-y-6">

                            {/* Top Bar: Summary & Download */}
                            {(storyBlocks.length > 0) && (
                                <div className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 p-4 rounded-xl bg-white/5 border border-white/10 backdrop-blur-md">
                                    <div className="flex-1">
                                        <h2 className="text-lg font-bold text-white mb-1">Generated Context Summary</h2>
                                        {scriptSummary ? (
                                            <p className="text-sm text-gray-400 leading-relaxed">{scriptSummary}</p>
                                        ) : (
                                            <div className="h-4 w-48 bg-white/5 rounded animate-pulse" />
                                        )}
                                    </div>
                                    <div className="flex items-center gap-3 shrink-0">
                                        {/* Segment Count */}
                                        <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-lg border border-white/10">
                                            <FilmIcon className="w-4 h-4 text-[#FF0055]" />
                                            <span className="text-xs font-medium text-white">{storyBlocks.length} Segments</span>
                                        </div>

                                        {/* Total Duration */}
                                        {(() => {
                                            const totalSeconds = storyBlocks.reduce((acc, block) => acc + (block.duration || 0), 0);
                                            const minutes = Math.floor(totalSeconds / 60);
                                            const seconds = Math.floor(totalSeconds % 60);
                                            return (
                                                <div className="flex items-center gap-2 px-3 py-1.5 bg-white/5 rounded-lg border border-white/10">
                                                    <ClockIcon className="w-4 h-4 text-[#FF0055]" />
                                                    <span className="text-xs font-medium text-white">{minutes}:{seconds.toString().padStart(2, '0')}</span>
                                                </div>
                                            );
                                        })()}

                                        <LiquidButton variant="secondary" onClick={downloadAllSegments} className="flex items-center gap-2">
                                            <ArrowDownTrayIcon className="w-4 h-4" />
                                            <span>Download .ZIP</span>
                                        </LiquidButton>
                                    </div>
                                </div>
                            )}

                            {storyBlocks.length === 0 && procState.status === 'idle' && (
                                <div className="h-[600px] flex flex-col items-center justify-center text-center opacity-30">
                                    <FilmIcon className="w-24 h-24 text-white mb-4" />
                                    <h3 className="text-xl font-bold text-white">Ready for Production</h3>
                                    <p className="text-sm text-gray-400 max-w-md mt-2">
                                        Import your voiceover and script to begin the automated alignment and matching process.
                                    </p>
                                </div>
                            )}

                            {/* RESULT BLOCKS */}
                            <div className="space-y-4">
                                {storyBlocks.map((block, idx) => (
                                    <div key={block.id} className="contain-content">
                                        <ResultBlockItem
                                            block={block}
                                            blockIndex={idx}
                                            playingId={playingId}
                                            isExpanded={expandedBlocks.has(block.id)}
                                            onToggleExpand={toggleBlockExpansion}
                                            onPlay={playPreview}
                                            onRetry={retryVideoMatch}
                                        />
                                    </div>
                                ))}
                            </div>

                        </div>
                    </div>
                </div>

                {/* SETTINGS MODAL */}
                <AnimatePresence>
                    {showSettings && (
                        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="absolute inset-0 bg-black/80 backdrop-blur-md"
                                onClick={() => setShowSettings(false)}
                            />
                            <motion.div
                                initial={{ scale: 0.95, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.95, opacity: 0 }}
                                className="relative bg-[#0A0A0A] border border-white/10 p-8 rounded-2xl w-full max-w-md shadow-2xl"
                            >
                                <h2 className="text-xl font-bold text-white mb-6">Application Settings</h2>

                                <div className="space-y-4">
                                    <div>
                                        <label className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 block">
                                            Gemini API Key
                                        </label>
                                        <input
                                            type="password"
                                            value={apiKeyInput}
                                            onChange={(e) => setApiKeyInput(e.target.value)}
                                            placeholder="AIzaSy..."
                                            className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white focus:border-[#FF0055] outline-none transition-colors font-mono"
                                        />
                                        <p className="text-[10px] text-gray-500 mt-2">
                                            Key is saved locally in your user folder.
                                        </p>
                                    </div>

                                    <div className="flex justify-end gap-3 pt-4">
                                        <button
                                            onClick={() => setShowSettings(false)}
                                            className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            onClick={updateApiKey}
                                            className="px-6 py-2 bg-[#FF0055] hover:bg-[#FF1F69] text-white text-sm font-bold rounded-lg shadow-lg shadow-[#FF0055]/20 transition-all"
                                        >
                                            Save Changes
                                        </button>
                                    </div>
                                </div>
                            </motion.div>
                        </div>
                    )}
                </AnimatePresence>
            </div>
        </>
    );
}

export default App;
