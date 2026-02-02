
// import { processFullAudioPipeline } from './services/gemini';
import JSZip from 'jszip';
import { getAudioEngine } from './services/AudioSyncEngine';
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
import { UpdateNotification } from './components/UpdateNotification';
import { StartScreen } from './components/StartScreen';
import { SettingsModal } from './components/SettingsModal';
import { projectService, ProjectData } from './services/projectService';
import { EditorView } from './components/Editor/EditorView';
// Backend services moved to Electron Main Process (IPC)
// import timelineManager from './services/timeline/timelineManager.js';
// import videoEditor from './services/videoEditor.js';
// import smartVideoFetcher from './services/smartVideoFetcher.js';
// @ts-ignore
import config from './config.js';

import { AudioClip } from './types';

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
    headline?: string;
    videoCount?: number;
    currentQueryMessage?: string; // Real-time search progress
    attemptsLog?: AttemptLog[];
}

interface ProcessingState {
    status: 'idle' | 'transcribing' | 'aligning' | 'slicing' | 'videomatching' | 'completed' | 'error';
    progress: number;
    message: string;
}

// Window interface is defined in vite-env.d.ts

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
        { id: 'transcribing', label: 'Audio' },
        { id: 'aligning', label: 'Align' },
        { id: 'slicing', label: 'Cut' },
        { id: 'videomatching', label: 'Match' }
    ];

    const getCurrentStepIndex = () => {
        if (state.status === 'completed') return 4;
        return steps.findIndex(s => s.id === state.status);
    };

    const currentStep = getCurrentStepIndex();

    return (
        <motion.div
            initial={{ opacity: 0, y: -10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.2 }}
            className="rounded-xl bg-[#0C0C0E]/98 border border-white/[0.08] shadow-2xl backdrop-blur-xl overflow-hidden"
        >
            {/* Warning Banner */}
            <div className="px-4 py-2 bg-gradient-to-r from-amber-500/10 via-amber-500/5 to-transparent border-b border-amber-500/10 flex items-center gap-2">
                <svg className="w-3.5 h-3.5 text-amber-400" fill="currentColor" viewBox="0 0 20 20">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                </svg>
                <span className="text-[11px] text-amber-300/90 font-medium">Do not close or minimize the browser window</span>
            </div>

            {/* Main Content */}
            <div className="p-4">
                <div className="flex items-center justify-between gap-6">
                    {/* Left: Status */}
                    <div className="flex items-center gap-3">
                        <div className="relative w-10 h-10">
                            <div className="absolute inset-0 rounded-full bg-[#FF0055]/10 flex items-center justify-center">
                                <SparklesIcon className="w-5 h-5 text-[#FF0055]" />
                            </div>
                            <svg className="absolute inset-0 w-10 h-10 -rotate-90" viewBox="0 0 36 36">
                                <circle cx="18" cy="18" r="16" fill="none" strokeWidth="2" stroke="rgba(255,255,255,0.05)" />
                                <circle
                                    cx="18" cy="18" r="16" fill="none" strokeWidth="2" stroke="#FF0055"
                                    strokeDasharray={`${state.progress} 100`}
                                    strokeLinecap="round"
                                    className="transition-all duration-300"
                                />
                            </svg>
                        </div>

                        <div>
                            <div className="flex items-center gap-2">
                                <h3 className="text-sm font-semibold text-white">Processing</h3>
                                <span className="text-[10px] text-gray-500 font-mono">{state.progress.toFixed(0)}%</span>
                            </div>
                            <p className="text-xs text-[#FF6B7A]">{state.message}</p>
                        </div>
                    </div>

                    {/* Right: Steps */}
                    <div className="flex items-center gap-1">
                        {steps.map((step, idx) => (
                            <div key={step.id} className="flex items-center">
                                <div
                                    className={`
                                        flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-semibold transition-all duration-300
                                        ${idx < currentStep
                                            ? 'bg-[#FF0055]/20 text-[#FF0055]'
                                            : idx === currentStep
                                                ? 'bg-white text-black shadow-lg shadow-white/20'
                                                : 'bg-white/[0.03] text-gray-600'
                                        }
                                    `}
                                    title={step.label}
                                >
                                    {idx < currentStep ? (
                                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                                            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                                        </svg>
                                    ) : (
                                        <span>{idx + 1}</span>
                                    )}
                                    <span className="hidden sm:inline">{step.label}</span>
                                </div>
                                {idx < steps.length - 1 && (
                                    <div className={`w-4 h-0.5 mx-0.5 transition-colors duration-300 ${idx < currentStep ? 'bg-[#FF0055]/50' : 'bg-white/[0.05]'}`} />
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* Progress Bar */}
                <div className="mt-3 h-1 bg-white/[0.03] rounded-full overflow-hidden">
                    <div
                        className="h-full bg-gradient-to-r from-[#FF0055] to-[#FF5588] rounded-full transition-transform duration-300 ease-out origin-left"
                        style={{ transform: `scaleX(${state.progress / 100})`, width: '100%' }}
                    />
                </div>
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
                            // Helper to format title into 3 lines
                            const formatTitleToLines = (title: string): string[] => {
                                const text = title || "";
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
                                return lines;
                            };

                            const lines = formatTitleToLines(block.title);

                            return (
                                <>
                                    {lines.map((line, i) => (
                                        <span key={i} className={`block text-xs font-bold text-white tracking-wide uppercase leading-snug ${!line ? 'invisible' : ''} ${i === 0 ? 'text-white/95' : i === 1 ? 'text-white/85' : 'text-white/75'}`}>
                                            {line || "-"}
                                        </span>
                                    ))}
                                </>
                            );
                        })()}
                    </div>

                    {/* Copy Button (Right Side) - Now uses the same formatting logic */}
                    {(() => {
                        // We need to re-calculate lines for the button click, or ideally hoist the calculator. 
                        // To keep it simple and safe within this structure:
                        const formatTitleToLines = (title: string): string[] => {
                            const text = title || "";
                            const clean = text.replace(/\s+/g, ' ').trim();
                            let lines = ["", "", ""];
                            const parts = clean.split(/—|:| - /).map(s => s.trim()).filter(Boolean);
                            if (parts.length >= 3) {
                                lines = parts.slice(0, 3);
                            } else if (parts.length === 2) {
                                const [p1, p2] = parts;
                                if (p1.length > p2.length * 1.5) {
                                    const mid = Math.floor(p1.length / 2);
                                    const splitIdx = p1.lastIndexOf(' ', mid);
                                    lines = [
                                        p1.substring(0, splitIdx === -1 ? mid : splitIdx).trim(),
                                        p1.substring(splitIdx === -1 ? mid : splitIdx).trim(),
                                        p2
                                    ];
                                } else {
                                    const mid = Math.floor(p2.length / 2);
                                    const splitIdx = p2.lastIndexOf(' ', mid);
                                    lines = [
                                        p1,
                                        p2.substring(0, splitIdx === -1 ? mid : splitIdx).trim(),
                                        p2.substring(splitIdx === -1 ? mid : splitIdx).trim()
                                    ];
                                }
                            } else {
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
                            return lines;
                        };

                        return (
                            <button
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const lines = formatTitleToLines(block.title);
                                    const formattedText = lines.filter(l => l).join('\n');
                                    navigator.clipboard.writeText(formattedText);
                                }}
                                className="p-1.5 text-gray-500 hover:text-white rounded-md hover:bg-white/10 transition-colors group/copy relative shrink-0"
                                title="Copy Formatted Title"
                            >
                                <ClipboardIcon className="w-4 h-4" />
                                <span className="absolute -top-8 left-1/2 -translate-x-1/2 bg-black text-white text-[9px] px-2 py-1 rounded opacity-0 group-active/copy:opacity-100 transition-opacity whitespace-nowrap pointer-events-none">
                                    Copied!
                                </span>
                            </button>
                        );
                    })()}
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
        </LiquidCard >
    );
});


// --- Main App ---

function App() {
    // State - Core Data
    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [scriptText, setScriptText] = useState<string>("");
    const [scriptSummary, setScriptSummary] = useState<string | null>(null);
    const [storyBlocks, setStoryBlocks] = useState<StoryBlock[]>([]);
    const [procState, setProcState] = useState<ProcessingState>({ status: 'idle', progress: 0, message: '' });
    const [expandedBlocks, setExpandedBlocks] = useState<Set<string>>(new Set());
    const [playingId, setPlayingId] = useState<string | null>(null);
    // Toast IPC Listener
    useEffect(() => {
        if ((window as any).electron) {
            (window as any).electron.receive('show-toast', (data: any) => {
                addToast(data.message, data.type || 'info');
            });
        }
    }, []);

    const [masterAudioUrl, setMasterAudioUrl] = useState<string | null>(null);
    const [audioClips, setAudioClips] = useState<AudioClip[]>([]);

    // Track previous blob URLs for cleanup to prevent memory leaks
    const previousBlobUrlsRef = useRef<string[]>([]);

    // Cleanup blob URLs when masterAudioUrl changes or component unmounts
    useEffect(() => {
        return () => {
            // Cleanup previous master URL
            if (masterAudioUrl) {
                URL.revokeObjectURL(masterAudioUrl);
            }
        };
    }, [masterAudioUrl]);

    // Cleanup storyBlock blob URLs when they change
    useEffect(() => {
        // Revoke previous blob URLs
        previousBlobUrlsRef.current.forEach(url => {
            if (url && url.startsWith('blob:')) {
                URL.revokeObjectURL(url);
            }
        });

        // Store current blob URLs for next cleanup
        previousBlobUrlsRef.current = storyBlocks
            .map(b => b.blobUrl)
            .filter((url): url is string => !!url && url.startsWith('blob:'));
    }, [storyBlocks]);

    // Update State
    const [updateStatus, setUpdateStatus] = useState<any>({ status: 'idle', progress: 0 });

    // UI State
    const [showSettings, setShowSettings] = useState(false);
    const [apiKeyInput, setApiKeyInput] = useState('');
    const [isUsingCustomKey, setIsUsingCustomKey] = useState(false);

    // Viory Login State
    const [vioryLoginRequired, setVioryLoginRequired] = useState(false);
    const [vioryLoginMessage, setVioryLoginMessage] = useState('');

    // Load Gemini API key from Electron config when settings modal opens
    useEffect(() => {
        if (showSettings && (window as any).electron?.config) {
            (window as any).electron.config.getGeminiKey().then((result: any) => {
                if (result.success && result.key) {
                    setApiKeyInput(result.key);
                    setIsUsingCustomKey(result.isCustom);
                } else {
                    // Fallback to localStorage if Electron config fails
                    const localKey = localStorage.getItem('gemini_api_key') || '';
                    setApiKeyInput(localKey);
                    setIsUsingCustomKey(false);
                }
            }).catch(() => {
                // Fallback to localStorage
                const localKey = localStorage.getItem('gemini_api_key') || '';
                setApiKeyInput(localKey);
                setIsUsingCustomKey(false);
            });
        }
    }, [showSettings]);

    // --- PROJECT MANAGEMENT STATE ---
    const [currentView, setCurrentView] = useState<'start' | 'editor' | 'smart_editor'>('start');
    const [currentProject, setCurrentProject] = useState<ProjectData | null>(null);
    const [resumeableProject, setResumeableProject] = useState<ProjectData | null>(null);
    const [recentProjects, setRecentProjects] = useState<ProjectData[]>([]);

    // Smart Editor State (Synced via IPC)
    const [smartTimeline, setSmartTimeline] = useState<any[]>([]);

    // Session Persistence Cache
    // Map<projectId, { timeline: any[], audioUrl: string, audioFilePath: string, scriptText: string }>
    const projectCache = useRef(new Map<string, any>());

    // AUDIO FILE PATH STATE (Critical for Export)
    const [audioFilePath, setAudioFilePath] = useState<string>('');

    // --- RECOVERY LOGIC ---
    useEffect(() => {
        if ((window as any).electron) {
            // Check for crashed session
            (window as any).electron.invoke('smart-check-recovery').then((res: any) => {
                if (res && res.found && res.data) {
                    console.log('Found crashed session:', res.data.name);
                    setResumeableProject(res.data);
                }
            });
        }
    }, []);

    // Debounced Auto-Save for Crash Recovery
    useEffect(() => {
        // Only save if we have meaningful data to save
        if (!currentProject) return;
        if (!scriptText && smartTimeline.length === 0 && storyBlocks.length === 0) return;

        const timer = setTimeout(() => {
            if ((window as any).electron) {
                const recoveryData = {
                    ...currentProject,
                    scriptText,
                    storyBlocks, // CRITICAL: Include storyBlocks for full restoration
                    smartTimeline, // Use consistent naming
                    timeline: smartTimeline, // Keep for backward compatibility
                    audioPath: audioFilePath || currentProject.audioPath, // Ensure audioPath is saved
                    audioFilePath, // Also save with this key for compatibility
                    audioUrl: masterAudioUrl,
                    audioClips // Save clips too
                };
                console.log('[Recovery] Saving recovery data with', smartTimeline.length, 'segments');
                (window as any).electron.invoke('smart-save-recovery', recoveryData);
            }
        }, 2000); // Save every 2s of inactivity

        return () => clearTimeout(timer);
    }, [currentProject, scriptText, smartTimeline, storyBlocks, audioFilePath, masterAudioUrl, audioClips]);

    useEffect(() => {
        if ((window as any).electron) {
            (window as any).electron.receive('smart-timeline-update', (timelineData: any) => {
                const backendSegments = timelineData.segments || [];

                // CRITICAL: Merge backend updates while PRESERVING local approval states
                setSmartTimeline(prev => {
                    if (prev.length === 0) {
                        // Initial load - use backend data as-is
                        console.log("[Timeline] Initial timeline with", backendSegments.length, "segments");
                        return backendSegments;
                    }

                    // Merge: Use backend video/status updates but preserve 'approved' status
                    return backendSegments.map((backendSeg: any, idx: number) => {
                        const localSeg = prev[idx];

                        // If locally approved, KEEP that status regardless of backend
                        if (localSeg && localSeg.status === 'approved') {
                            return {
                                ...backendSeg,
                                status: 'approved' // Preserve local approval
                            };
                        }

                        // Otherwise use backend data
                        return backendSeg;
                    });
                });
            });


            (window as any).electron.receive('smart-progress', (data: any) => {
                // Forward to toast or console for now
                if (data.type === 'error') addToast('Smart Fetch Error', data.message, 'error');
            });
        }
    }, []);

    // Track if "all videos ready" notification has been shown for current session
    const allVideosReadyNotifiedRef = useRef(false);

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
                    smartTimeline, // CRITICAL: Save the timeline with video data
                    procState: safeState, // Only save safe states
                    audioName: audioFile?.name,
                    audioPath: audioFilePath || currentProject.audioPath || '' // Use the saved audio path
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


    const restoreProject = async (proj: ProjectData) => {
        console.log('[Restore] Restoring project:', proj.name);
        console.log('[Restore] proj.storyBlocks count:', proj.storyBlocks?.length || 0);
        console.log('[Restore] proj.audioPath:', proj.audioPath || 'N/A');
        console.log('[Restore] First block sample:', proj.storyBlocks?.[0] ? {
            title: proj.storyBlocks[0].title,
            text: proj.storyBlocks[0].text?.substring(0, 50)
        } : 'N/A');

        // ENABLE LOCK
        isRestoringRef.current = true;

        setCurrentProject(proj);
        setScriptText(typeof proj.scriptText === 'string' ? proj.scriptText : "");

        // CRITICAL FIX: Set audioFilePath for export - this was missing!
        if (proj.audioPath) {
            console.log('[Restore] Setting audioFilePath:', proj.audioPath);
            setAudioFilePath(proj.audioPath);
        }

        // 1. REGENERATE AUDIO BLOBS (Fix for expired blob:file:// URLs)
        let restoredBlocks = [...(proj.storyBlocks || [])];
        if (proj.audioPath && (window as any).electron) {
            try {
                console.log('[Restore] Regenerating audio blobs from:', proj.audioPath);
                // Read file buffer from main process
                const buffer = await (window as any).electron.invoke('read-file-buffer', proj.audioPath);

                // Set Master Audio URL for Unified Player
                if (buffer) {
                    const masterBlob = new Blob([buffer], { type: 'audio/mpeg' }); // Fallback mime
                    const masterUrl = URL.createObjectURL(masterBlob);
                    setMasterAudioUrl(masterUrl);

                    // Decode using the Unified Engine
                    console.log('[Restore] Loading audio into AudioSyncEngine...');
                    const engine = getAudioEngine();
                    await engine.loadFromUrl(masterUrl);
                    const decodedBuffer = engine.getAudioBuffer();

                    if (!decodedBuffer) throw new Error("AudioSyncEngine failed to decode buffer");

                    // 2a. REGENERATE AUDIO CLIPS (NLE)
                    const restoredClips: AudioClip[] = [];
                    // We need to map blocks to clips.
                    // Assuming blocks are in order and represent the segments.
                    restoredBlocks.forEach((block, idx) => {
                        const start = block.start_time;
                        const end = block.end_time;
                        const duration = end - start;

                        if (duration > 0) {
                            restoredClips.push({
                                id: block.id, // Link ID
                                buffer: decodedBuffer, // Reference Master Buffer
                                startTime: start,
                                offset: start, // Linear initially
                                duration: duration,
                                volume: 1.0
                            });
                        }
                    });
                    setAudioClips(restoredClips);
                    console.log('[Restore] AudioClips regenerated:', restoredClips.length);

                    // Re-create blobs for each block (Legacy / Block Player support)
                    restoredBlocks = await Promise.all(restoredBlocks.map(async (block) => {
                        // Start/End are in seconds? Check interface.
                        // AlignedSegment has start_time/end_time in seconds.
                        // FinalSegment extends AlignedSegment.
                        const start = block.start_time;
                        const end = block.end_time;
                        const duration = end - start;

                        if (duration > 0) {
                            const sliceBlob = await sliceAudioBuffer(decodedBuffer, start, end);
                            const newUrl = URL.createObjectURL(sliceBlob);
                            return { ...block, blobUrl: newUrl };
                        }
                        return block;
                    }));
                }
                console.log('[Restore] Blobs regenerated successfully for', restoredBlocks.length, 'blocks');
            } catch (e) {
                console.error('[Restore] Failed to regenerate blobs:', e);
                addToast('Audio Warning', 'Could not reload audio files. Previews may be silent.', 'warning');
            }
        }

        setStoryBlocks(restoredBlocks);

        // 2. RESTORE SMART TIMELINE
        // Use saved smartTimeline if available (with video data), otherwise rebuild from blocks
        // Handle both 'smartTimeline' and 'timeline' keys for backward compatibility with recovery data
        const savedTimeline = proj.smartTimeline || proj.timeline || [];

        if (savedTimeline.length > 0) {
            console.log("[Restore] Using saved smartTimeline with", savedTimeline.length, "segments");

            // CRITICAL FIX: Validate video files exist before restoring
            // Videos are stored as file:// URLs - check if they still exist
            let validatedTimeline = savedTimeline;
            if ((window as any).electron) {
                validatedTimeline = await Promise.all(savedTimeline.map(async (seg: any) => {
                    if (seg.video && seg.video.url) {
                        try {
                            // Convert file:// URL to path for validation
                            let videoPath = seg.video.url;
                            if (videoPath.startsWith('file:///')) {
                                videoPath = videoPath.replace('file:///', '');
                            } else if (videoPath.startsWith('file://')) {
                                videoPath = videoPath.replace('file://', '');
                            }
                            videoPath = decodeURIComponent(videoPath);

                            // Check if file exists
                            const exists = await (window as any).electron.invoke('check-file-exists', videoPath);
                            if (!exists) {
                                console.warn(`[Restore] Video file missing for segment ${seg.index}: ${videoPath}`);
                                // Mark segment as needing re-download
                                return {
                                    ...seg,
                                    video: null,
                                    status: 'pending'
                                };
                            }
                        } catch (e) {
                            console.error('[Restore] Error validating video:', e);
                            return { ...seg, video: null, status: 'pending' };
                        }
                    }
                    return seg;
                }));
            }

            setSmartTimeline(validatedTimeline);
            setCurrentView('editor');

            // Check if any segments need video processing (including ones we just invalidated)
            const hasIncomplete = validatedTimeline.some((seg: any) =>
                seg.status !== 'approved' && seg.status !== 'found' && !seg.video
            );

            if (hasIncomplete) {
                console.log("[Restore] Some segments need processing, triggering Smart Fetch...");
                if ((window as any).electron) {
                    const scriptForBackend = typeof proj.scriptText === 'string' ? proj.scriptText : '';
                    (window as any).electron.invoke('smart-fetch-timeline', {
                        blocks: validatedTimeline,
                        scriptText: scriptForBackend
                    }).catch((err: any) => console.error('[Restore] Smart Fetch Error:', err));
                }
            }
        } else if (restoredBlocks.length > 0) {
            console.log("[Restore] No saved smartTimeline, rebuilding from storyBlocks...");

            // Pre-populate Smart Timeline from storyBlocks
            const initialSegments = restoredBlocks.map((block, idx) => ({
                index: idx,
                headline: block.title || `Segment ${idx + 1}`,
                text: block.text || '',
                duration: block.duration || 5,
                start_time: block.start_time,
                end_time: block.end_time,
                startTime: restoredBlocks.slice(0, idx).reduce((acc, b) => acc + (b.duration || 5), 0),
                status: block.videoStatus === 'complete' || block.videoMatches?.length > 0 ? 'found' : 'pending',
                video: block.videoMatches && block.videoMatches.length > 0 ? {
                    url: block.videoMatches[0].url,
                    previewUrl: block.videoMatches[0].url,
                    thumbnail: block.videoMatches[0].thumbnail,
                    duration: block.videoMatches[0].duration,
                    title: block.videoMatches[0].title
                } : null
            }));

            setSmartTimeline(initialSegments);
            setCurrentView('editor');

            // Trigger video fetching for incomplete segments
            const hasIncomplete = restoredBlocks.some(b =>
                b.videoStatus !== 'complete' && (!b.videoMatches || b.videoMatches.length === 0)
            );

            if (hasIncomplete) {
                console.log("[Restore] Needs processing. Triggering Smart Fetch with scriptText...");
                if ((window as any).electron) {
                    const scriptForBackend = typeof proj.scriptText === 'string' ? proj.scriptText : '';
                    (window as any).electron.invoke('smart-fetch-timeline', {
                        blocks: restoredBlocks,
                        scriptText: scriptForBackend
                    }).catch((err: any) => console.error('[Restore] Smart Fetch Error:', err));
                }
            }
        } else {
            // Default to start if empty
            console.log("[Restore] No data to restore, going to start screen");
            setCurrentView('start');
        }

        // RELEASE LOCK - Use a small delay to ensure all state updates are flushed
        // but not too long to cause data loss if user makes changes
        await new Promise(resolve => setTimeout(resolve, 500));
        isRestoringRef.current = false;
        console.log('[Restore] Lock released.');
    };



    const handleNewProject = async (name: string, audioFile: File, scriptText: string) => {
        const newProj = projectService.createNew();
        newProj.name = name; // Override with user input

        // Clear cache for this new project ID just in case
        if (projectCache.current.has(newProj.id)) {
            projectCache.current.delete(newProj.id);
        }

        await projectService.clearSession();
        setResumeableProject(null); // Clear any resume prompt
        setCurrentProject(newProj);
        setAudioFile(audioFile);

        let finalAudioPath = '';

        // Variable to hold the actual File object for processing
        let audioFileForProcessing: File = audioFile;

        if (audioFile) {
            // Check for native path first (from Electron dialog - like pro editors)
            const nativePath = (audioFile as any).nativePath;

            if (nativePath) {
                // PRO EDITOR STYLE: Use the original file path directly (no copying!)
                console.log('[handleNewProject] Using native file path (pro editor style):', nativePath);
                finalAudioPath = nativePath;

                // Read the file from disk for preview AND transcription
                if ((window as any).electron) {
                    try {
                        const buffer = await (window as any).electron.invoke('read-file-buffer', nativePath);
                        if (buffer) {
                            // Create a proper File object with actual data for transcription
                            const blob = new Blob([buffer], { type: 'audio/mpeg' });
                            audioFileForProcessing = new File([blob], audioFile.name, { type: 'audio/mpeg' });
                            (audioFileForProcessing as any).nativePath = nativePath;

                            setMasterAudioUrl(URL.createObjectURL(blob));
                            console.log('[handleNewProject] Audio loaded from native path, size:', buffer.byteLength);
                        }
                    } catch (e) {
                        console.error('[handleNewProject] Failed to read audio for preview:', e);
                    }
                }
            } else {
                // Fallback: Web file input - need to save to disk
                console.log('[handleNewProject] Web file input detected, saving to disk...');
                setMasterAudioUrl(URL.createObjectURL(audioFile));

                if ((window as any).electron) {
                    try {
                        const arrayBuffer = await audioFile.arrayBuffer();
                        const result = await (window as any).electron.invoke('save-audio-file', {
                            arrayBuffer: arrayBuffer,
                            fileName: audioFile.name,
                            projectId: newProj.id
                        });

                        if (result.success && result.path) {
                            finalAudioPath = result.path;
                            console.log('[handleNewProject] Audio saved to:', finalAudioPath);
                        }
                    } catch (e) {
                        console.error('[handleNewProject] Error saving audio file:', e);
                    }
                }
            }

            setAudioFilePath(finalAudioPath);
            setAudioFile(audioFileForProcessing); // Update with real file data
            newProj.audioPath = finalAudioPath;
            newProj.audioName = audioFile.name;
        }

        setScriptText(scriptText);
        setStoryBlocks([]);
        setSmartTimeline([]);
        setProcState({ status: 'transcribing', progress: 5, message: 'Initializing pipeline...' });

        // Switch to Editor immediately (it will show processing state)
        setCurrentView('editor');

        // Start Processing in background - use the file with actual data
        processFullPipeline(audioFileForProcessing, scriptText);
    };

    const processFullPipeline = async (audio: File, script: string) => {
        try {
            // ========== STEP 1: TRANSCRIBE ==========
            setProcState({ status: 'transcribing', progress: 10, message: 'Analyzing audio...' });
            // addToast('Procesando', 'Iniciando análisis de audio...', 'info'); // Removed to reduce noise

            const assemblyData = await transcribeWithAssembly(audio);
            console.log('[Pipeline] Transcription complete:', assemblyData.words?.length, 'words');

            // ========== STEP 2: DECODE ==========
            setProcState({ status: 'aligning', progress: 30, message: 'Processing audio...' });

            // UNIFIED: Use AudioSyncEngine
            const engine = getAudioEngine();
            // We need to ensure context is ready
            await engine.loadFromFile(audio);
            const decodedBuffer = engine.getAudioBuffer();

            if (!decodedBuffer) {
                throw new Error("Could not decode audio buffer");
            }

            // ========== STEP 3: ALIGN ==========
            setProcState({ status: 'aligning', progress: 40, message: 'Syncing script...' });
            const aligned = await alignScriptDeterministic(script, assemblyData.words);

            if (!aligned || aligned.length === 0) {
                throw new Error("Error de Alineación: Asegúrate de que el guión tenga marcadores [ON SCREEN: ...].");
            }

            // ========== STEP 4: SLICE ==========
            setProcState({ status: 'slicing', progress: 50, message: 'Generating audio segments...' });
            // addToast('Cortando', `Generando ${aligned.length} segmentos...`, 'info'); // Removed for cleaner UI

            const processedBlocks: StoryBlock[] = [];

            for (const [idx, segment] of aligned.entries()) {
                let startTime = Math.max(0, segment.start_time);
                let endTime = Math.min(decodedBuffer.duration, segment.end_time);

                if (endTime > startTime) {
                    const sliceBlob = await sliceAudioBuffer(decodedBuffer, startTime, endTime);
                    const blobUrl = URL.createObjectURL(sliceBlob);
                    const duration = endTime - startTime;

                    processedBlocks.push({
                        ...segment,
                        blobUrl: blobUrl,
                        duration: duration,
                        id: `block-${idx}-${Date.now()}`,
                        videoStatus: 'idle',
                        videoMatches: [],
                        videoCount: 0
                    });
                }
            }

            setStoryBlocks(processedBlocks);

            // IMMEDIATE UI UPDATE: Populate Smart Timeline with "Audio Only" segments
            // This ensures the timeline appears immediately, even before video matching
            const initialSmartTimeline = processedBlocks.map((block, idx) => ({
                index: idx,
                headline: block.title || `Segment ${idx + 1}`,
                text: block.text,
                duration: block.duration,
                startTime: block.start_time,
                endTime: block.end_time, // CRITICAL: Required for timeline rendering
                status: 'pending',
                video: null, // No video yet
                progress: 0
            }));
            setSmartTimeline(initialSmartTimeline);

            // ========== STEP 5: FETCH VIDEOS ==========
            setProcState({ status: 'videomatching', progress: 60, message: 'Searching for video footage...' });
            // addToast('Searching Videos', 'Finding matching footage for your segments...', 'info'); // Redundant with Pipeline Overlay

            if ((window as any).electron) {
                const blocksForFetch = processedBlocks.map(block => ({
                    title: block.title,
                    headline: block.title, // Critical: Scraper expects 'headline' for query
                    text: block.text,
                    duration: block.duration,
                    start_time: block.start_time,
                    end_time: block.end_time
                }));

                const result = await (window as any).electron.invoke('smart-fetch-timeline', {
                    blocks: blocksForFetch,
                    scriptText: script
                });

                if (result && Array.isArray(result)) {
                    const mergedTimeline = result.map((videoBlock: any, idx: number) => {
                        const audioBlock = processedBlocks[idx];
                        return {
                            // Video data from scraper
                            ...videoBlock,
                            // CRITICAL: Preserve ALL audio block data (title, text, blobUrl, etc.)
                            // These are from the AssemblyAI alignment and must take precedence
                            title: audioBlock?.title || videoBlock.title || '',
                            headline: audioBlock?.title || audioBlock?.headline || videoBlock.headline || '',
                            text: audioBlock?.text || videoBlock.text || '',
                            blobUrl: audioBlock?.blobUrl || null,
                            duration: audioBlock?.duration || videoBlock.duration,
                            start_time: audioBlock?.start_time,
                            end_time: audioBlock?.end_time,
                            index: idx // Ensure index is set
                        };
                    });
                    setSmartTimeline(mergedTimeline);
                }
            }

            setProcState({ status: 'completed', progress: 100, message: 'Processing Complete!' });
            // addToast('Success', `Generated ${processedBlocks.length} segments successfully.`, 'success'); // Redundant with useEffect hook

        } catch (e: any) {
            console.error('[Pipeline Error]', e);
            setProcState({ status: 'error', progress: 0, message: 'Processing failed' });
            addToast('Error', e.message || 'An unexpected error occurred.', 'error');
        }
    };

    const handleBackToStart = async () => {
        // SAVE SESSION STATE TO MEMORY CACHE
        if (currentProject) {
            console.log('[Session] Caching project state for:', currentProject.name);

            // Update project with current audioPath
            const updatedProject = {
                ...currentProject,
                audioPath: audioFilePath || currentProject.audioPath
            };

            projectCache.current.set(currentProject.id, {
                project: updatedProject,
                storyBlocks,
                smartTimeline,
                scriptText,
                audioFile,
                audioFilePath,
                procState,
                audioClips,
                masterAudioUrl
            });

            // ALSO save to disk so it persists across app restarts
            await projectService.saveSession({
                id: currentProject.id,
                name: currentProject.name,
                scriptText,
                storyBlocks,
                smartTimeline, // CRITICAL: Save the timeline with video data
                procState: { status: 'idle', progress: 0, message: '' },
                audioName: audioFile?.name,
                audioPath: audioFilePath || currentProject.audioPath || ''
            });
        }

        setResumeableProject(null);

        // DON'T clear the session - we want to preserve it for reopening
        // await projectService.clearSession(); // REMOVED

        // RECOVERY LOGIC: Clear crash file on INTENTIONAL exit so next launch is clean
        if ((window as any).electron) {
            await (window as any).electron.invoke('smart-clear-recovery');
        }

        // DON'T reset state - keep it in memory for quick resume
        // The cache will be used when reopening
        // setSmartTimeline([]); // REMOVED
        // setMasterAudioUrl(null); // REMOVED
        setProcState({ status: 'idle', progress: 0, message: '' });
        setCurrentView('start');
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
        console.log('[handleOpenProject] Opening project:', proj.name, 'id:', proj.id);

        // Smart Resume: If opening the exact same project that is currently in memory
        if (currentProject && currentProject.id === proj.id) {
            console.log("[handleOpenProject] Same project already active, just switching view");
            // Make sure audioFilePath is set from cache if available
            if (projectCache.current.has(proj.id)) {
                const cached = projectCache.current.get(proj.id);
                if (cached.audioFilePath && !audioFilePath) {
                    console.log('[handleOpenProject] Restoring audioFilePath from cache:', cached.audioFilePath);
                    setAudioFilePath(cached.audioFilePath);
                }
                if (cached.smartTimeline?.length > 0 && smartTimeline.length === 0) {
                    console.log('[handleOpenProject] Restoring smartTimeline from cache');
                    setSmartTimeline(cached.smartTimeline);
                }
                if (cached.masterAudioUrl && !masterAudioUrl) {
                    console.log('[handleOpenProject] Restoring masterAudioUrl from cache');
                    setMasterAudioUrl(cached.masterAudioUrl);
                }
            }
            setCurrentView('editor');
            return;
        }

        // Check Memory Cache
        if (projectCache.current.has(proj.id)) {
            console.log("[handleOpenProject] Restoring from Memory Cache:", proj.name);
            const cached = projectCache.current.get(proj.id);

            setCurrentProject(cached.project);
            setStoryBlocks(cached.storyBlocks);
            setSmartTimeline(cached.smartTimeline);
            setScriptText(cached.scriptText);
            setAudioFile(cached.audioFile);
            setAudioFilePath(cached.audioFilePath);
            setProcState(cached.procState);
            setAudioClips(cached.audioClips);
            setMasterAudioUrl(cached.masterAudioUrl);

            console.log('[handleOpenProject] Cache restored - audioFilePath:', cached.audioFilePath);
            console.log('[handleOpenProject] Cache restored - smartTimeline segments:', cached.smartTimeline?.length || 0);

            setCurrentView('editor');
            return;
        }

        // Otherwise, perform full load from disk
        console.log('[handleOpenProject] No cache found, loading from disk');
        const fullProject = await projectService.openProject(proj);
        restoreProject(fullProject);
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

    const updateApiKey = async (): Promise<{ success: boolean; message: string }> => {
        if (!apiKeyInput || apiKeyInput.length < 10) {
            return { success: false, message: 'Please enter a valid Gemini API Key (at least 10 characters)' };
        }

        try {
            // Try Electron IPC first (preferred method for packaged app)
            if ((window as any).electron?.config) {
                const result = await (window as any).electron.config.saveGeminiKey(apiKeyInput);
                if (result.success) {
                    setIsUsingCustomKey(true);
                    // Also save to localStorage as backup
                    localStorage.setItem('gemini_api_key', apiKeyInput);
                    addToast('Key Updated', 'API Key saved successfully. Changes take effect immediately.', 'success');
                    return { success: true, message: 'API Key saved successfully!' };
                } else {
                    return { success: false, message: result.error || 'Failed to save API key' };
                }
            }

            // Fallback to HTTP API (for dev mode or web version)
            const res = await fetch(`${API_BASE_URL}/api/config/key`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key: apiKeyInput })
            });

            const data = await res.json();
            if (data.success) {
                setIsUsingCustomKey(true);
                localStorage.setItem('gemini_api_key', apiKeyInput);
                addToast('Key Updated', 'API Key saved successfully. Changes take effect immediately.', 'success');
                return { success: true, message: 'API Key saved successfully!' };
            } else {
                return { success: false, message: data.error || 'Failed to save API key' };
            }
        } catch (e: any) {
            console.error('[App] Failed to save API key:', e);
            return { success: false, message: e.message || 'Failed to save API key' };
        }
    };

    const [viewMode, setViewMode] = useState<'dashboard' | 'editor'>('dashboard');
    const [projectLogs, setProjectLogs] = useState<string[]>([]);
    const [currentTimeline, setCurrentTimeline] = useState<any>(null); // Ideally should have a proper Timeline type

    // Listen for backend logs
    useEffect(() => {
        if ((window as any).electron) {
            // Use 'receive' which is designed for simple message passing
            (window as any).electron.receive('smart-log', (msg: string) => {
                // Add timestamp when log is received (not at render time)
                const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false }).slice(0, 5);
                const logWithTime = `[${timestamp}] ${msg}`;
                setProjectLogs(prev => [...prev.slice(-100), logWithTime]); // Keep last 100 logs
            });

            return () => {
                (window as any).electron.removeAllListeners('smart-log');
            };
        }
    }, []);

    // Listen for Viory login status updates
    useEffect(() => {
        if ((window as any).electron) {
            (window as any).electron.receive('viory-status-update', (status: { status: string, message: string }) => {
                console.log('[App] Viory status update:', status);

                if (status.status === 'waiting_login' || status.status === 'login_required' || status.status === 'navigating_login') {
                    setVioryLoginRequired(true);
                    setVioryLoginMessage(status.message || 'Please log in to Viory in the browser window that opened');
                } else if (status.status === 'logged_in' || status.status === 'ready') {
                    setVioryLoginRequired(false);
                    setVioryLoginMessage('');
                }
            });

            return () => {
                (window as any).electron.removeAllListeners('viory-status-update');
            };
        }
    }, []);

    // --- Refs ---
    const wavesurferRef = useRef<any>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // --- Effects ---

    /**
     * Play a notification sound (pleasant chime)
     */
    const playNotificationSound = useCallback(() => {
        try {
            const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
            const now = ctx.currentTime;

            // Create a pleasant two-tone chime
            const playTone = (freq: number, start: number, duration: number) => {
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.connect(gain);
                gain.connect(ctx.destination);
                osc.frequency.value = freq;
                osc.type = 'sine';
                gain.gain.setValueAtTime(0.3, now + start);
                gain.gain.exponentialRampToValueAtTime(0.01, now + start + duration);
                osc.start(now + start);
                osc.stop(now + start + duration);
            };

            // Two-tone chime (C5 and E5)
            playTone(523.25, 0, 0.15);    // C5
            playTone(659.25, 0.1, 0.2);   // E5
        } catch (err) {
            console.error("Notification sound failed:", err);
        }
    }, []);

    /**
     * Show a system notification with sound
     * @param title - Notification title
     * @param body - Notification body text
     */
    const showNotification = useCallback((title: string, body: string) => {
        console.log('[Notification] Showing:', title, body);

        // 1. Play notification sound
        playNotificationSound();

        // 2. System Notification - Use Electron's native notification if available
        if ((window as any).electron) {
            // Use Electron IPC to show native notification with proper icon
            (window as any).electron.invoke('show-notification', { title, body })
                .catch((e: any) => console.error("Electron notification failed:", e));
        } else {
            // Fallback to browser notification
            const showSystemNotification = () => {
                if ("Notification" in window) {
                    try {
                        new Notification(title, {
                            body: body,
                            silent: true
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
        }
    }, [playNotificationSound]);

    // Reset notification flag when starting new processing
    useEffect(() => {
        if (procState.status === 'videomatching' || procState.status === 'slicing') {
            allVideosReadyNotifiedRef.current = false;
        }
    }, [procState.status]);

    // Detect when ALL segments have videos ready and show notification
    useEffect(() => {
        // Only check if we have segments and haven't notified yet
        if (smartTimeline.length === 0 || allVideosReadyNotifiedRef.current) {
            return;
        }

        // Check if ALL segments have a video with a valid path/url (status 'ready' or has video)
        const allReady = smartTimeline.every((seg: any) => {
            // A segment is ready if it has video data with a path or previewUrl
            const hasVideo = seg.video && (seg.video.path || seg.video.previewUrl || seg.video.url);
            const isReady = seg.status === 'ready' || seg.status === 'approved';
            return hasVideo || isReady;
        });

        // Also make sure we're not still in the middle of processing
        const stillProcessing = smartTimeline.some((seg: any) =>
            seg.status === 'searching' || seg.status === 'pending' || seg.status === 'downloading'
        );

        if (allReady && !stillProcessing) {
            console.log('[Notification] All videos ready! Showing notification...');
            allVideosReadyNotifiedRef.current = true;

            showNotification(
                'ClickSync - Videos Ready',
                'All video clips have been found and are ready for review.'
            );
            addToast('Videos Ready', 'All video clips have been found. Review and export when ready.', 'success');
        }
    }, [smartTimeline, showNotification]);

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
        // Store path for Electron/FFmpeg
        if ((file as any).path) {
            setAudioFilePath((file as any).path);
        }
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

            // UNIFIED: Use AudioSyncEngine
            const engine = getAudioEngine();
            // Reload from file to ensure engine has the correct buffer for this new process
            await engine.loadFromFile(audioFile);
            const decodedBuffer = engine.getAudioBuffer();

            if (!decodedBuffer) {
                throw new Error("Could not decode audio buffer");
            }
            const processedBlocks: StoryBlock[] = [];

            if (isCancelledRef.current) return;

            for (const [idx, segment] of aligned.entries()) {
                if (segment.start_time < 0) segment.start_time = 0;
                if (segment.end_time > decodedBuffer.duration) segment.end_time = decodedBuffer.duration;

                if (segment.end_time > segment.start_time) {
                    const sliceBlob = await sliceAudioBuffer(decodedBuffer, segment.start_time, segment.end_time);
                    const url = URL.createObjectURL(sliceBlob);

                    const blockId = `block-${idx}-${Date.now()}`;

                    processedBlocks.push({
                        ...segment,
                        blobUrl: url,
                        duration: segment.end_time - segment.start_time,
                        id: blockId,
                        videoStatus: 'idle',
                        videoMatches: [],
                        videoCount: 0
                    });
                }
            }

            // GENERATE AUDIOCLIPS (NLE)
            const generatedClips: AudioClip[] = processedBlocks.map(block => ({
                id: block.id,
                buffer: decodedBuffer, // Shared Master Buffer Reference
                startTime: block.start_time,
                offset: block.start_time,
                duration: block.duration,
                volume: 1.0
            }));
            console.log('[App] Generated Clips:', generatedClips.length, generatedClips);
            setAudioClips(generatedClips);

            // Pass to Engine immediately
            engine.setClips(generatedClips);

            setStoryBlocks(processedBlocks);

            // Fix: Update Smart Timeline immediately so EditorView has data (including blobUrls)
            setSmartTimeline(processedBlocks.map((block, idx) => ({
                index: idx,
                headline: block.title || `Segment ${idx + 1}`,
                text: '',
                duration: block.duration,
                startTime: block.start_time,
                status: 'pending',
                video: null,
                blobUrl: block.blobUrl
            })));

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
            // Note: "Videos Ready" notification is handled by useEffect watching smartTimeline

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


    // Audio Clip Update Handler
    const handleUpdateAudioClip = useCallback((id: string, updates: Partial<AudioClip>) => {
        setAudioClips(prev => {
            const next = prev.map(clip => clip.id === id ? { ...clip, ...updates } : clip);
            // Updating the engine in real-time for smooth feedback
            getAudioEngine().setClips(next);
            return next;
        });
    }, []);

    // --- SMART EDITOR INTEGRATION ---
    const handleOpenSmartEditor = () => {
        // 1. Pre-populate timeline from storyBlocks IMMEDIATELY
        const initialSegments = storyBlocks.map((block, idx) => ({
            index: idx,
            headline: block.title || `Segment ${idx + 1}`,
            text: '',
            duration: block.duration || 5,
            startTime: storyBlocks.slice(0, idx).reduce((acc, b) => acc + (b.duration || 5), 0),
            status: 'pending',
            video: null,
            blobUrl: block.blobUrl // Fix: Ensure blobUrl is passed for export
        }));
        console.log('[App] handleOpenSmartEditor. Initializing with', initialSegments.length, 'segments');

        setSmartTimeline(initialSegments);

        // 2. Switch View IMMEDIATELY
        setCurrentView('editor');

        // 3. Trigger background video fetching (non-blocking)
        console.log('[App] Triggering smart-fetch-timeline with', storyBlocks.length, 'blocks');
        if ((window as any).electron) {
            console.log('[App] Calling electron.invoke smart-fetch-timeline...');
            (window as any).electron.invoke('smart-fetch-timeline', {
                blocks: storyBlocks,
                scriptText: scriptText  // Pass script for fallback parsing
            })
                .then((result: any) => {
                    console.log('[App] smart-fetch-timeline completed:', result);
                    if (result && Array.isArray(result)) {
                        setSmartTimeline(result);
                    }
                    // Note: Notification is handled by useEffect watching smartTimeline
                })
                .catch((err: any) => {
                    console.error('[App] smart-fetch-timeline ERROR:', err);
                    addToast("Error fetching timeline: " + err.message, 'error');
                });
        } else {
            console.warn('[App] window.electron not available!');
        }
    };

    // Smart Video Fetcher Actions
    const handleSmartReplace = async (segmentIndex: number) => {
        console.log("Replacing clip for segment", segmentIndex);
        if ((window as any).electron) {
            try {
                const result = await (window as any).electron.invoke('smart-replace-clip', segmentIndex);
                if (result && !result.success && result.message) {
                    addToast('Replace Failed', result.message, 'error');
                }
                return result;
            } catch (err: any) {
                console.error('handleSmartReplace error:', err);
                addToast('Error', err?.message || 'Failed to replace clip', 'error');
                return { success: false, message: err?.message };
            }
        }
        return { success: false, message: 'Electron not available' };
    };

    const handleSkipSearch = async (segmentIndex: number) => {
        if ((window as any).electron) {
            await (window as any).electron.invoke('smart-skip-search', segmentIndex);
        }
    };

    const handleManualVideoUrl = async (segmentIndex: number, videoUrl: string) => {
        if ((window as any).electron) {
            return await (window as any).electron.invoke('viory:manual-video', { segmentIndex, videoUrl });
        }
        return { success: false, message: 'Electron not available' };
    };


    // Track if export complete notification has been shown
    const exportCompleteNotifiedRef = useRef(false);

    const handleSmartExport = async (options: any, onProgress: (p: any) => void) => {
        if ((window as any).electron) {
            // Reset notification flag at start of export
            exportCompleteNotifiedRef.current = false;

            // Remove any existing listener to prevent duplicates
            (window as any).electron.removeAllListeners('smart-export-progress');

            // Listen for progress from main
            (window as any).electron.receive('smart-export-progress', (data: any) => {
                onProgress(data);

                // Show notification when export completes (only once)
                if (data.stage === 'complete' && !exportCompleteNotifiedRef.current) {
                    exportCompleteNotifiedRef.current = true;
                    showNotification(
                        'ClickSync - Export Complete',
                        'Your video has been exported successfully.'
                    );
                    addToast('Export Complete', 'Your video has been exported successfully!', 'success');
                }
            });
            return await (window as any).electron.invoke('smart-export-final', options);
        }
    };

    if (currentView === 'start') {
        return (
            <>
                {/* TitleBar handled within StartScreen */}
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
                    onRename={projectService.renameProject}
                    onOpenSettings={() => setShowSettings(true)}
                />

                {/* Viory Login Required Modal */}
                {vioryLoginRequired && (
                    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center">
                        <div className="bg-[#1a1a1a] rounded-2xl p-8 max-w-md mx-4 border border-white/10 shadow-2xl">
                            <div className="flex items-center gap-3 mb-4">
                                <div className="w-12 h-12 rounded-full bg-[#FF0055]/20 flex items-center justify-center">
                                    <svg className="w-6 h-6 text-[#FF0055]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                    </svg>
                                </div>
                                <h2 className="text-xl font-bold text-white">Viory Login Required</h2>
                            </div>
                            <p className="text-gray-300 mb-6">
                                {vioryLoginMessage || 'A browser window has opened. Please log in to your Viory account to continue.'}
                            </p>
                            <div className="flex items-center gap-3 p-4 bg-[#0a0a0a] rounded-xl">
                                <div className="animate-spin w-5 h-5 border-2 border-[#FF0055] border-t-transparent rounded-full"></div>
                                <span className="text-sm text-gray-400">Waiting for login...</span>
                            </div>
                        </div>
                    </div>
                )}

                <SettingsModal
                    isOpen={showSettings}
                    onClose={() => setShowSettings(false)}
                    apiKey={apiKeyInput}
                    onApiKeyChange={setApiKeyInput}
                    onSaveKey={updateApiKey}
                    version="v2.0.8"
                    isUsingCustomKey={isUsingCustomKey}
                />
            </>
        );
    }

    // Audio Clip Update Handler



    // --- RENDER UNIFIED EDITOR ---
    return (
        <div className="min-h-screen bg-[#050505]">
            {/* TitleBar handled within EditorView */}
            <ToastContainer toasts={toasts} removeToast={removeToast} />

            {/* Viory Login Required Modal */}
            {vioryLoginRequired && (
                <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center">
                    <div className="bg-[#1a1a1a] rounded-2xl p-8 max-w-md mx-4 border border-white/10 shadow-2xl">
                        <div className="flex items-center gap-3 mb-4">
                            <div className="w-12 h-12 rounded-full bg-[#FF0055]/20 flex items-center justify-center">
                                <svg className="w-6 h-6 text-[#FF0055]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                                </svg>
                            </div>
                            <h2 className="text-xl font-bold text-white">Viory Login Required</h2>
                        </div>
                        <p className="text-gray-300 mb-6">
                            {vioryLoginMessage || 'A browser window has opened. Please log in to your Viory account to continue.'}
                        </p>
                        <div className="flex items-center gap-3 p-4 bg-[#0a0a0a] rounded-xl">
                            <div className="animate-spin w-5 h-5 border-2 border-[#FF0055] border-t-transparent rounded-full"></div>
                            <span className="text-sm text-gray-400">Waiting for login...</span>
                        </div>
                    </div>
                </div>
            )}

            {/* Processing Overlay */}
            {procState.status !== 'idle' && procState.status !== 'completed' && procState.status !== 'error' && (
                <div className="fixed top-12 left-1/2 -translate-x-1/2 z-[100] w-full max-w-2xl px-4 pointer-events-auto">
                    <ProcessingHero state={procState} />
                </div>
            )}


            <EditorView
                project={{ ...currentProject, logs: projectLogs }}
                timeline={{ segments: smartTimeline }}
                audioUrl={masterAudioUrl}
                audioFilePath={audioFilePath} // Pass real file path for export
                audioClips={audioClips}
                storyBlocks={storyBlocks}
                onUpdateAudioClip={handleUpdateAudioClip}
                isProcessing={procState.status !== 'idle' && procState.status !== 'completed' && procState.status !== 'error'}

                onReplaceClip={handleSmartReplace}
                onSkipSearch={handleSkipSearch}
                onManualVideoUrl={handleManualVideoUrl}
                onApproveSegment={(idx) => {
                    setSmartTimeline(prev => prev.map((seg, i) =>
                        i === idx ? { ...seg, status: 'approved' } : seg
                    ));
                }}
                onExportFinal={handleSmartExport}
                onUpdateClipProperty={(idx, prop, val) => {
                    if ((window as any).electron) {
                        (window as any).electron.invoke('smart-update-clip-option', { index: idx, prop, value: val });
                    }
                }}
                onBack={handleBackToStart}
            />
        </div>
    );
}
// Removed legacy return
function LegacyRemoved() { return null; }


export default App;
