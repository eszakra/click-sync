// import { processFullAudioPipeline } from './services/gemini';
import JSZip from 'jszip';
import { AlignedSegment } from './services/gemini';
import { alignScriptDeterministic } from './services/matcher';
import { transcribeWithAssembly } from './services/assemblyBackend';
import { sliceAudioBuffer, decodeAudio } from './services/audioProcessor';
import React, { useState, useRef, useEffect } from 'react';
import { LiquidCard, LiquidButton, LiquidTextArea, LiquidDropZone, LiquidProgressBar } from './components/LiquidUI';
import { motion, AnimatePresence } from 'framer-motion';
import gsap from 'gsap';
// @ts-ignore
import { ArrowDownTrayIcon, PlayIcon, PauseIcon, ArrowPathIcon, SparklesIcon, ChevronDownIcon, ChevronUpIcon, FilmIcon, ArrowTopRightOnSquareIcon, BackwardIcon, ForwardIcon, InformationCircleIcon } from '@heroicons/react/24/solid';

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

// Unified Data Model
interface StoryBlock extends FinalSegment {
    id: string; // Unique ID for React keys
    videoStatus: 'idle' | 'searching' | 'complete' | 'error';
    videoMatches: VideoResult[];
    searchQuery?: string;
    videoCount?: number;
}

interface ProcessingState {
    status: 'idle' | 'transcribing' | 'aligning' | 'slicing' | 'videomatching' | 'completed' | 'error';
    progress: number;
    message: string;
}

// --- Internal UI Components ---

/**
 * SonicScrubber: Apple-style audio slider with fluid gradient fill
 */
const SonicScrubber: React.FC<{
    value: number; // 0-100
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    disabled?: boolean;
}> = ({ value, onChange, disabled }) => {
    // Calculate gradient background for "filled" track effect
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
            className="apple-slider apple-slider-filled w-full transition-all disabled:opacity-50"
            style={gradientStyle}
        />
    );
};

// --- Premium Components ---

const ProcessingHero: React.FC<{ state: ProcessingState }> = ({ state }) => {
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
            className="mb-8 p-6 rounded-2xl bg-gradient-to-r from-[#050505] to-[#111] border border-white/10 shadow-2xl relative overflow-hidden"
        >
            {/* Background Glow */}
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#FF0055] to-transparent opacity-50" />

            <div className="flex flex-col md:flex-row items-center justify-between gap-6 relative z-10">
                <div className="flex items-center gap-4">
                    <div className="relative">
                        <div className="w-12 h-12 rounded-full bg-[#FF0055]/10 flex items-center justify-center border border-[#FF0055]/20">
                            <SparklesIcon className="w-6 h-6 text-[#FF0055] animate-pulse" />
                        </div>
                        {/* Spinner Ring */}
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

            {/* Smooth Progress Bar */}
            <div className="mt-6 h-1 bg-white/5 rounded-full overflow-hidden">
                <motion.div
                    className="h-full bg-gradient-to-r from-[#FF0055] to-[#FF5588]"
                    initial={{ width: 0 }}
                    animate={{ width: `${state.progress}%` }}
                    transition={{ type: 'spring', stiffness: 50, damping: 20 }}
                />
            </div>
        </motion.div>
    );
};

const CompactVideoThumb: React.FC<{ video: VideoResult }> = ({ video }) => (
    <motion.a
        href={video.url}
        target="_blank"
        rel="noopener noreferrer"
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        whileHover={{ scale: 1.05, borderColor: 'rgba(255, 0, 85, 0.5)' }}
        className="group relative aspect-video rounded-lg overflow-hidden bg-black/40 border border-white/5 hover:border-[#FF0055]/30 transition-all cursor-pointer block shadow-md"
        title={`Open: ${video.title}`}
    >
        {video.thumbnail ? (
            <img
                src={video.thumbnail}
                alt={video.title}
                className="w-full h-full object-cover opacity-80 group-hover:opacity-100 transition-opacity"
                loading="lazy"
            />
        ) : (
            <div className="w-full h-full flex items-center justify-center bg-white/5">
                <FilmIcon className="w-6 h-6 text-gray-700" />
            </div>
        )}

        <div className="absolute bottom-1 right-1 px-1.5 py-0.5 bg-black/90 backdrop-blur text-white text-[9px] font-mono rounded-sm border border-white/10">
            {video.duration || '0:00'}
        </div>

        <div className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <ArrowTopRightOnSquareIcon className="w-4 h-4 text-white" />
        </div>

        <div className="absolute bottom-0 left-0 right-0 p-2 bg-gradient-to-t from-black to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
            <p className="text-[10px] text-white font-medium truncate">{video.title}</p>
        </div>
    </motion.a>
);

const CompactVideoGrid: React.FC<{ videos: VideoResult[] }> = ({ videos }) => {
    const [expanded, setExpanded] = useState(false);

    // Show top 3 by default
    const displayedVideos = expanded ? videos : videos.slice(0, 3);

    return (
        <div className="w-full">
            <motion.div layout className="grid grid-cols-3 gap-3">
                <AnimatePresence>
                    {displayedVideos.map((video, idx) => (
                        <CompactVideoThumb key={`${video.url}-${idx}`} video={video} />
                    ))}
                </AnimatePresence>
            </motion.div>

            {videos.length > 3 && (
                <motion.div layout className="mt-3 flex justify-center">
                    <button
                        onClick={() => setExpanded(!expanded)}
                        className="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-gray-500 hover:text-white transition-colors bg-white/5 hover:bg-white/10 px-4 py-1.5 rounded-full border border-white/5"
                    >
                        {expanded ? (
                            <>Show Less <ChevronUpIcon className="w-3 h-3" /></>
                        ) : (
                            <>View {videos.length - 3} More Matches <ChevronDownIcon className="w-3 h-3" /></>
                        )}
                    </button>
                </motion.div>
            )}
        </div>
    );
};

// --- Main App ---

function App() {
    // State
    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [scriptText, setScriptText] = useState<string>("");
    const [scriptSummary, setScriptSummary] = useState<string | null>(null);

    const [procState, setProcState] = useState<ProcessingState>({
        status: 'idle',
        progress: 0,
        message: ''
    });

    const [storyBlocks, setStoryBlocks] = useState<StoryBlock[]>([]);
    const [playingId, setPlayingId] = useState<string | null>(null);
    const audioRef = useRef<HTMLAudioElement | null>(null);

    // Playback Progress State
    const [progress, setProgress] = useState(0);
    const [currentTime, setCurrentTime] = useState(0);

    // Source Audio State
    const [sourceDuration, setSourceDuration] = useState(0);
    const [sourceProgress, setSourceProgress] = useState(0);
    const [sourcePlaying, setSourcePlaying] = useState(false);
    const sourceAudioRef = useRef<HTMLAudioElement | null>(null);

    // --- Handlers ---

    const formatTime = (time: number) => {
        if (!time || isNaN(time)) return "00:00";
        const minutes = Math.floor(time / 60);
        const seconds = Math.floor(time % 60);
        return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
    };

    const handleAudioSelect = (file: File) => {
        setAudioFile(file);
        setSourceProgress(0);
        setSourcePlaying(false);
        if (sourceAudioRef.current) {
            sourceAudioRef.current.pause();
            sourceAudioRef.current = null;
        }
    };

    const toggleSourcePlay = () => {
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
    };

    const seekSource = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!sourceAudioRef.current) return;
        const percent = parseFloat(e.target.value);
        sourceAudioRef.current.currentTime = (percent / 100) * sourceAudioRef.current.duration;
        setSourceProgress(percent);
    };

    const skipSource = (seconds: number) => {
        if (!sourceAudioRef.current) return;
        sourceAudioRef.current.currentTime = Math.min(Math.max(sourceAudioRef.current.currentTime + seconds, 0), sourceAudioRef.current.duration);
    };

    const seekSegment = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (!audioRef.current) return;
        const percent = parseFloat(e.target.value);
        audioRef.current.currentTime = (percent / 100) * audioRef.current.duration;
        setProgress(percent);
    };

    // --- CORE PIPELINE ---

    const startProcessing = async () => {
        if (!audioFile || !scriptText.trim()) return;

        try {
            // 1. Transcribe (Voiceover Pipeline)
            setProcState({ status: 'transcribing', progress: 10, message: 'Analyzing Voice Frequency Spectrum...' });
            const assemblyData = await transcribeWithAssembly(audioFile);

            // 2. Align (Voiceover Pipeline)
            setProcState({ status: 'aligning', progress: 30, message: 'Synchronizing Temporal Nodes...' });
            await new Promise(r => setTimeout(r, 600)); // Dramatic pause
            const aligned = await alignScriptDeterministic(scriptText, assemblyData.words);

            if (!aligned || aligned.length === 0) {
                throw new Error("Alignment Failed: Please ensure your script contains '[ON SCREEN: ...]' markers.");
            }

            // 3. Slice (Voiceover Pipeline)
            setProcState({ status: 'slicing', progress: 50, message: 'Rendering Precision Audio Cuts...' });
            const decodedBuffer = await decodeAudio(audioFile);
            const processedBlocks: StoryBlock[] = [];

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

            // 4. Video Matching (New Pipeline Integration)
            setProcState({ status: 'videomatching', progress: 60, message: 'AI Finding Relevant Footage...' });
            await matchVideosForBlocks(processedBlocks);

            setProcState({ status: 'completed', progress: 100, message: 'All Processing Complete!' });

        } catch (error: any) {
            console.error(error);
            setProcState({ status: 'error', progress: 0, message: error.message || 'Processing Failed' });
        }
    };

    // Video Matching Helper
    const matchVideosForBlocks = async (blocks: StoryBlock[]) => {
        // Helper to update specific block state
        const updateBlock = (blockIndex: number, updates: Partial<StoryBlock>) => {
            setStoryBlocks(prev => prev.map((b, idx) =>
                idx === blockIndex ? { ...b, ...updates } : b
            ));
        };

        // Mark all as searching initially
        setStoryBlocks(prev => prev.map(b => ({ ...b, videoStatus: 'searching' })));

        // Reset summary
        setScriptSummary(null);

        // Process each block SEQUENTIALLY
        let contextFetched = false;

        for (let i = 0; i < blocks.length; i++) {
            const block = blocks[i];

            // Calculate progress
            const currentProgress = 60 + ((i / blocks.length) * 35);
            setProcState(prev => ({
                ...prev,
                progress: currentProgress,
                message: `Matching Footage for Block ${i + 1}/${blocks.length}...`
            }));

            try {
                // Determine API endpoint based on whether we need context (first block)
                // Actually, the main API call returns context in 'context' field if generated for the *whole script*
                // But we are calling 'research' endpoint here? No, 'matchVideosToScript' in previous versions
                // The current flow calls 'research' endpoint per block in loop?
                // Wait, 'research' endpoint uses `reSearchBlock` which calls `generateSearchQuery`.
                // It does NOT return global context.
                // WE NEED TO CALL THE MAIN ENDPOINT if we want context.
                // But the logic here is client-side iteration.
                // WORKAROUND: Call the main endpoint ONCE with the whole script to get context, then iterate?
                // OR: Update 'research' endpoint? No.
                // Let's create a separate small fetch for context if it's the first block.
                // Actually, let's just use the server's existing /api/video-matching endpoint which returns blocks AND context?
                // BUT the client-side code here does the Loop.
                // I will add a special call for context on the first iteration.

                if (!contextFetched) {
                    // Fetch context from API
                    fetch('/api/video-matching', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ script: scriptText })
                    }).then(res => res.json()).then(data => {
                        if (data.context) setScriptSummary(data.context);
                    }).catch(console.error);

                    contextFetched = true;
                }

                // Standard Block Search
                const response = await fetch('/api/research', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        block: {
                            index: i,
                            headline: block.title, // Map 'title' to 'headline'
                            text: block.text
                        }
                    })
                });

                if (!response.ok) throw new Error('Search failed');

                const data = await response.json();
                const resultBlock = data.block; // This has { searchQuery, videos }

                updateBlock(i, {
                    videoStatus: 'complete',
                    videoMatches: resultBlock.videos,
                    searchQuery: resultBlock.searchQuery,
                    videoCount: resultBlock.videos.length
                });

            } catch (err) {
                console.error(`Failed to match video for block ${i}`, err);
                updateBlock(i, { videoStatus: 'error' });
            }

            // Small delay
            await new Promise(r => setTimeout(r, 500));
        }
    };

    const retryVideoMatch = async (blockIndex: number, block: StoryBlock) => {
        setStoryBlocks(prev => prev.map((b, idx) => idx === blockIndex ? { ...b, videoStatus: 'searching' } : b));

        try {
            const response = await fetch('/api/research', {
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
                videoCount: resultBlock.videos.length
            } : b));

        } catch (err) {
            setStoryBlocks(prev => prev.map((b, idx) => idx === blockIndex ? { ...b, videoStatus: 'error' } : b));
        }
    };

    const playPreview = (url: string) => {
        if (audioRef.current) {
            audioRef.current.pause();
            audioRef.current.currentTime = 0;
            audioRef.current.ontimeupdate = null;
        }

        if (playingId === url) {
            setPlayingId(null);
            setProgress(0);
            setCurrentTime(0);
            return;
        }

        const audio = new Audio(url);
        audioRef.current = audio;

        audio.ontimeupdate = () => {
            if (audio.duration) {
                setProgress((audio.currentTime / audio.duration) * 100);
                setCurrentTime(audio.currentTime);
            }
        };

        audio.onended = () => {
            setPlayingId(null);
            setProgress(0);
            setCurrentTime(0);
        };

        audio.play();
        setPlayingId(url);
    };

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

    // --- RENDER ---
    return (
        <div className="min-h-screen p-6 md:p-12 max-w-[1800px] mx-auto pb-40">

            {/* HEADER */}
            <div className="sticky top-0 z-50 -mx-6 md:-mx-12 px-6 md:px-12 py-4 mb-8 bg-[#050505]/90 backdrop-blur-xl border-b border-white/5 flex items-center justify-between transition-all duration-300">
                <div className="flex items-baseline gap-2">
                    <h1 className="text-2xl font-extrabold tracking-tighter text-white">
                        ClickSync<span className="text-[#FF0055]">.</span>
                    </h1>
                    <span className="px-2 py-0.5 rounded bg-white/5 text-[10px] uppercase font-bold text-gray-400 tracking-widest border border-white/5">
                        Unified Studio
                    </span>
                </div>

                {/* Status Pill */}
                <div className="flex items-center gap-3 bg-white/5 px-4 py-1.5 rounded-full border border-white/5">
                    <div className={`w-2 h-2 rounded-full ${procState.status === 'error' ? 'bg-red-500' : procState.status !== 'idle' && procState.status !== 'completed' ? 'bg-[#FF0055] animate-pulse' : 'bg-[#00FF88]'} shadow-[0_0_10px_currentColor]`} />
                    <span className="text-[10px] font-bold font-mono uppercase tracking-widest text-gray-400">
                        {procState.status === 'idle' ? 'SYSTEM READY' : procState.status}
                    </span>
                </div>
            </div>

            {/* PROCESSING OVERLAY (Hero) */}
            <AnimatePresence>
                {(procState.status !== 'idle' && procState.status !== 'completed' && procState.status !== 'error') && (
                    <div className="mb-8">
                        <ProcessingHero state={procState} />
                    </div>
                )}
            </AnimatePresence>

            <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start">

                {/* --- LEFT COLUMN: INPUTS (4 cols) --- */}
                <div className="xl:col-span-4 flex flex-col gap-6 sticky top-24">

                    {/* INPUT CARD 1: AUDIO */}
                    <LiquidCard title="1. Link Audio">
                        <div className="space-y-4">
                            <LiquidDropZone
                                label="Drop Voiceover File"
                                fileName={audioFile?.name}
                                accept="audio/*"
                                onFileSelect={handleAudioSelect}
                            />

                            {audioFile && (
                                <div className="p-4 rounded-xl bg-black/40 border border-white/10 space-y-3">
                                    <div className="flex items-center gap-3">
                                        <button
                                            onClick={toggleSourcePlay}
                                            className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${sourcePlaying ? 'bg-[#FF0055] text-white shadow-[0_0_15px_#FF0055]' : 'bg-white/10 text-white hover:bg-white/20'}`}
                                        >
                                            {sourcePlaying ? <PauseIcon className="w-5 h-5" /> : <PlayIcon className="w-5 h-5 ml-1" />}
                                        </button>

                                        <div className="flex-1">
                                            {/* Apple-Style Scrubber */}
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
                            )}
                        </div>
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
                                <div className="w-full h-full flex items-center justify-center">
                                    <span className="text-[10px] font-medium text-white/30 tracking-[0.2em] uppercase animate-pulse">
                                        Generating Timeline...
                                    </span>
                                </div>
                            )}
                        </div>
                    </LiquidCard>
                </div>

                {/* --- RIGHT COLUMN: UNIFIED TIMELINE (8 cols) --- */}
                <div className="xl:col-span-8">
                    {/* Unified Timeline Summary Header */}
                    <div className="flex flex-col gap-4 mb-4">
                        <div className="flex items-center justify-between">
                            <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
                                Unified Timeline
                                <span className="px-2 py-0.5 rounded-full bg-white/5 text-[10px] text-gray-500 border border-white/5">
                                    {storyBlocks.length} SCENES
                                </span>
                            </h2>
                            {storyBlocks.length > 0 && (
                                <button onClick={downloadAllSegments} className="flex items-center gap-2 text-xs font-bold text-[#FF0055] hover:text-white transition-colors">
                                    <ArrowDownTrayIcon className="w-4 h-4" /> DOWNLOAD ZIP
                                </button>
                            )}
                        </div>

                        {/* SPANISH CONTEXT BLOCK */}
                        {storyBlocks.length > 0 && (
                            <motion.div
                                initial={{ opacity: 0, y: -10 }}
                                animate={{ opacity: 1, y: 0 }}
                                className="p-4 rounded-xl border border-white/5 bg-white/[0.02] flex items-start gap-3"
                            >
                                <InformationCircleIcon className="w-5 h-5 text-[#FF0055] mt-0.5 flex-shrink-0" />
                                <div>
                                    <h5 className="text-[10px] font-bold text-gray-500 uppercase tracking-widest mb-1">VIDEO CONTEXT</h5>
                                    <p className="text-sm text-gray-300 leading-relaxed font-medium">
                                        {scriptSummary || "Generando resumen del contexto..."}
                                    </p>
                                </div>
                            </motion.div>
                        )}
                    </div>

                    {storyBlocks.length === 0 ? (
                        <div className="min-h-[500px] rounded-2xl border border-white/5 bg-black/20 flex flex-col items-center justify-center text-center p-12">
                            <div className="w-24 h-24 mb-6 rounded-full bg-white/[0.02] border border-white/5 flex items-center justify-center">
                                <FilmIcon className="w-8 h-8 text-gray-700" />
                            </div>
                            <h3 className="text-lg font-medium text-white mb-2">Ready to Create</h3>
                            <p className="text-sm text-gray-600 max-w-sm">
                                Upload audio and script to generate your unified video timeline with AI-matched footage.
                            </p>
                        </div>
                    ) : (
                        <div className="space-y-3"> {/* COMPACT SPACING */}
                            <AnimatePresence mode="popLayout">
                                {storyBlocks.map((block, idx) => (
                                    <motion.div
                                        key={block.id}
                                        initial={{ opacity: 0, y: 20 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        transition={{ delay: idx * 0.05 }}
                                        className={`
                                group relative rounded-xl border overflow-hidden transition-all duration-300
                                ${playingId === block.blobUrl ? 'bg-black/80 border-[#FF0055]/40 shadow-[0_0_20px_rgba(255,0,85,0.05)]' : 'bg-black/40 border-white/5 hover:border-white/10 hover:bg-black/60'}
                            `}
                                    >
                                        <div className="flex flex-col lg:flex-row items-stretch">
                                            {/* LEFT: AUDIO & INFO (Compact width) */}
                                            <div className="lg:w-[320px] flex-shrink-0 p-5 border-b lg:border-b-0 lg:border-r border-white/5 flex flex-col justify-between relative bg-white/[0.01]">
                                                <div>
                                                    <div className="flex items-center justify-between gap-3 mb-3">
                                                        <div className="flex items-center gap-3">
                                                            <div className="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-[11px] font-bold text-gray-500 border border-white/5 group-hover:border-[#FF0055]/30 group-hover:text-[#FF0055] transition-colors">
                                                                {idx + 1}
                                                            </div>
                                                            <div className="flex flex-col">
                                                                <h4 className="text-sm font-bold text-gray-200 truncate max-w-[140px]">{block.title}</h4>
                                                                {/* Time Range Display */}
                                                                <span className="text-[10px] font-mono text-gray-600">
                                                                    {formatTime(block.start_time)} <span className="text-[#FF0055]">&rarr;</span> {formatTime(block.end_time)}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <p className="text-[11px] text-gray-500 line-clamp-2 leading-relaxed font-medium">
                                                        {block.text}
                                                    </p>
                                                </div>

                                                {/* Enahanced Segment Player */}
                                                <div className="mt-5 pt-4 border-t border-white/5">
                                                    <div className="flex items-center gap-3 mb-2">
                                                        <button
                                                            onClick={() => playPreview(block.blobUrl)}
                                                            className={`
                                                w-10 h-10 rounded-full flex items-center justify-center transition-all flex-shrink-0
                                                ${playingId === block.blobUrl ? 'bg-[#FF0055] text-white shadow-lg scale-105' : 'bg-white/10 text-gray-400 hover:bg-white/20 hover:text-white'}
                                            `}
                                                        >
                                                            {playingId === block.blobUrl ? <PauseIcon className="w-4 h-4" /> : <PlayIcon className="w-4 h-4 ml-0.5" />}
                                                        </button>

                                                        <div className="flex-1">
                                                            {/* Apple-Style Scrubber */}
                                                            <SonicScrubber
                                                                value={playingId === block.blobUrl ? progress : 0}
                                                                onChange={seekSegment}
                                                                disabled={playingId !== block.blobUrl}
                                                            />
                                                            <div className="flex justify-between text-[9px] font-mono text-gray-500 mt-1">
                                                                <span>{playingId === block.blobUrl ? formatTime(currentTime) : "00:00"}</span>
                                                                <span>{block.duration.toFixed(1)}s</span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                </div>
                                            </div>

                                            {/* RIGHT: VIDEO MATCHES (Flexible) */}
                                            <div className="flex-1 p-4 bg-black/20 min-h-[160px]">
                                                <div className="flex items-center justify-between mb-3">
                                                    <div className="flex items-center gap-2">
                                                        {block.videoStatus === 'searching' && (
                                                            <span className="flex items-center gap-2 text-[10px] text-[#FF0055] animate-pulse font-bold tracking-wider">
                                                                <span className="w-1.5 h-1.5 rounded-full bg-[#FF0055]" />
                                                                MATCHING...
                                                            </span>
                                                        )}
                                                        {block.searchQuery && (
                                                            <code className="text-[9px] text-gray-600 px-1.5 py-0.5 rounded bg-white/5 border border-white/5">
                                                                Query: "{block.searchQuery}"
                                                            </code>
                                                        )}
                                                    </div>

                                                    {block.videoStatus === 'error' && (
                                                        <button onClick={() => retryVideoMatch(idx, block)} className="text-[10px] text-red-500 hover:text-red-400 flex items-center gap-1">
                                                            <ArrowPathIcon className="w-3 h-3" /> Retry
                                                        </button>
                                                    )}
                                                </div>

                                                {/* Video Grid Container */}
                                                {block.videoStatus === 'searching' ? (
                                                    <div className="grid grid-cols-3 gap-3">
                                                        {[1, 2, 3].map(sk => (
                                                            <div key={sk} className="aspect-video bg-white/5 rounded-lg animate-pulse" />
                                                        ))}
                                                    </div>
                                                ) : block.videoMatches && block.videoMatches.length > 0 ? (
                                                    <CompactVideoGrid videos={block.videoMatches} />
                                                ) : (
                                                    <div className="h-full min-h-[100px] rounded-lg border border-white/5 border-dashed flex items-center justify-center text-xs text-gray-700">
                                                        No matches found
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </motion.div>
                                ))}
                            </AnimatePresence>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

export default App;
