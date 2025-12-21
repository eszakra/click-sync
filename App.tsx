
// import { processFullAudioPipeline } from './services/gemini';
import JSZip from 'jszip';
import { AlignedSegment } from './services/gemini';
import { alignScriptDeterministic } from './services/matcher';
import { transcribeWithAssembly } from './services/assemblyBackend';
import { sliceAudioBuffer, decodeAudio } from './services/audioProcessor';
import React, { useState, useRef, useEffect } from 'react';
import { LiquidCard, LiquidButton, LiquidTextArea, LiquidDropZone, LiquidProgressBar } from './components/LiquidUI';
import { AudioTimeline } from './components/AudioTimeline';
// @ts-ignore
import { ArrowDownTrayIcon, PlayIcon, PauseIcon, AdjustmentsHorizontalIcon } from '@heroicons/react/24/solid';

interface ProcessingState {
  status: 'idle' | 'transcribing' | 'aligning' | 'slicing' | 'completed' | 'error';
  progress: number;
  message: string;
}

interface FinalSegment extends AlignedSegment {
  blobUrl: string;
  duration: number; // in seconds
}

function App() {
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [scriptText, setScriptText] = useState<string>("");

  const [procState, setProcState] = useState<ProcessingState>({
    status: 'idle',
    progress: 0,
    message: ''
  });

  const [segments, setSegments] = useState<FinalSegment[]>([]);
  const [playingId, setPlayingId] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [showTimeline, setShowTimeline] = useState(false);
  // Playback Progress State
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  // Source Audio State
  const [sourceDuration, setSourceDuration] = useState(0);
  const [sourceProgress, setSourceProgress] = useState(0);
  const [sourcePlaying, setSourcePlaying] = useState(false);
  const sourceAudioRef = useRef<HTMLAudioElement | null>(null);

  const handleAudioSelect = (file: File) => {
    // Note: Migrated to Gemini Flash pipeline which supports large audio files (hours long)
    // No more 10MB limit check needed here.
    setAudioFile(file);
    // Reset source player
    setSourceProgress(0);
    setSourcePlaying(false);
    if (sourceAudioRef.current) {
      sourceAudioRef.current.pause();
      sourceAudioRef.current = null; // Re-init later
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

  const seekSource = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!sourceAudioRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    sourceAudioRef.current.currentTime = percent * sourceAudioRef.current.duration;
    setSourceProgress(percent * 100);
  };

  const seekSegment = (e: React.MouseEvent<HTMLDivElement>, duration: number) => {
    if (!audioRef.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const percent = (e.clientX - rect.left) / rect.width;
    audioRef.current.currentTime = percent * audioRef.current.duration; // note: audioRef is the segment blob
    // Optimization: The ongoing ontimeupdate will correct state, but we can set it optimistically?
    // Actually relying on ontimeupdate is safer for segments.
  };

  const startProcessing = async () => {
    if (!audioFile || !scriptText.trim()) return;

    try {
      // 1. Transcribe
      setProcState({ status: 'transcribing', progress: 15, message: 'Analyzing Voice Frequency Spectrum...' });
      const assemblyData = await transcribeWithAssembly(audioFile);

      // 2. Align
      setProcState({ status: 'aligning', progress: 50, message: 'Synchronizing Temporal Nodes...' });

      // Delay slightly for dramatic effect
      await new Promise(r => setTimeout(r, 600));

      const aligned = await alignScriptDeterministic(scriptText, assemblyData.words);

      // ERROR CHECK: No alignment found
      if (!aligned || aligned.length === 0) {
        throw new Error("Alignment Failed: No segments were matched. Please ensure your script contains '[ON SCREEN: ...]' markers and exactly matches the spoken audio.");
      }

      // 3. Slice
      setProcState({ status: 'slicing', progress: 85, message: 'Rendering Precision Audio Cuts...' });
      const decodedBuffer = await decodeAudio(audioFile);

      const processedSegments: FinalSegment[] = [];

      for (const segment of aligned) {
        // Safety check for timestamps to avoid Slice errors
        if (segment.start_time < 0) segment.start_time = 0;
        if (segment.end_time > decodedBuffer.duration) segment.end_time = decodedBuffer.duration;

        if (segment.end_time > segment.start_time) {
          const sliceBlob = await sliceAudioBuffer(decodedBuffer, segment.start_time, segment.end_time);
          const url = URL.createObjectURL(sliceBlob);
          processedSegments.push({
            ...segment,
            blobUrl: url,
            duration: segment.end_time - segment.start_time
          });
        }
      }

      setSegments(processedSegments);
      setProcState({ status: 'completed', progress: 100, message: 'Done!' });

    } catch (error: any) {
      console.error(error);
    }
  };

  const updateSegmentsPrecision = async (newSegments: AlignedSegment[]) => {
    if (!audioFile) return;
    const tempSegments = newSegments.map(s => {
      const existing = segments.find(old => old.title === s.title);
      return { ...s, blobUrl: existing?.blobUrl || '', duration: s.end_time - s.start_time } as FinalSegment;
    });
    setSegments(tempSegments);
    try {
      const decodedBuffer = await decodeAudio(audioFile);
      const reProcessed: FinalSegment[] = [];
      for (const segment of newSegments) {
        let startTime = Math.max(0, segment.start_time);
        let endTime = Math.min(decodedBuffer.duration, segment.end_time);
        if (endTime > startTime) {
          const sliceBlob = await sliceAudioBuffer(decodedBuffer, startTime, endTime);
          reProcessed.push({ ...segment, blobUrl: URL.createObjectURL(sliceBlob), duration: endTime - startTime });
        }
      }
      setSegments(reProcessed);
    } catch (e) {
      console.error(e);
    }
  };

  const playPreview = (url: string) => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current.ontimeupdate = null; // Cleanup
    }

    if (playingId === url) {
      setPlayingId(null);
      setProgress(0);
      setCurrentTime(0);
      return;
    }

    const audio = new Audio(url);
    audioRef.current = audio;

    // Update progress
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
    if (segments.length === 0) return;

    const zip = new JSZip();

    // Add each segment to the zip
    segments.forEach((seg, idx) => {
      const filename = `segment_${String(idx + 1).padStart(2, '0')}_${seg.title.replace(/[^a-z0-9]/gi, '_')}.wav`;
      // We need to fetch the blob from the URL to add it to zip
      zip.file(filename, fetch(seg.blobUrl).then(r => r.blob()));
    });

    try {
      const content = await zip.generateAsync({ type: "blob" });
      const url = URL.createObjectURL(content);
      const a = document.createElement("a");
      a.href = url;
      a.download = `clicksync_segments_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("Failed to zip", e);
      alert("Failed to create zip file.");
    }
  };


  return (
    <div className="min-h-screen p-6 md:p-12 max-w-[1600px] mx-auto">

      <div className="sticky top-0 z-50 -mx-6 md:-mx-12 px-6 md:px-12 py-4 mb-8 bg-[#050505]/80 backdrop-blur-md border-b border-white/5 flex items-center justify-between transition-all duration-300">
        <div className="flex items-baseline gap-2">
          <h1 className="text-2xl font-extrabold tracking-tighter text-white">
            ClickSync<span className="text-[#FF0055]">.</span>
          </h1>
        </div>

        {/* Status Indicator */}
        <div className="flex items-center gap-3 bg-white/5 px-3 py-1.5 rounded-full border border-white/5">
          <div className={`w-2 h-2 rounded-full ${procState.status === 'error' ? 'bg-red-500' : 'bg-[#FF0055]'} animate-pulse shadow-[0_0_8px_currentColor]`} />
          <span className="text-[10px] font-bold font-mono text-gray-400 uppercase tracking-widest">
            {procState.status === 'idle' ? 'SYSTEM READY' : procState.status}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-8 items-start animate-in fade-in slide-in-from-bottom-8 duration-700 fill-mode-forwards">

        {/* LEFT COLUMN: INPUTS (5 cols) */}
        <div className="xl:col-span-5 flex flex-col gap-6 sticky top-24">

          {/* 1. SOURCE */}
          <LiquidCard title="1. Original Voiceover File">
            <p className="text-xs text-gray-600 mb-2">
              Supported formats: MP3, WAV, M4A. Steps: Upload Audio → Paste Script → Analyze.
            </p>
            <LiquidDropZone
              label="Drop your source audio here"
              fileName={audioFile?.name}
              accept="audio/*"
              onFileSelect={handleAudioSelect}
            />
            {/* Source Player */}
            {audioFile && (
              <div className="mt-4 p-4 rounded-xl bg-white/5 border border-white/5 animate-in fade-in slide-in-from-top-2">
                <div className="flex items-center gap-4">
                  <button
                    onClick={toggleSourcePlay}
                    className={`w-10 h-10 rounded-full flex items-center justify-center transition-all ${sourcePlaying ? 'bg-[#FF0055] text-white shadow-[0_0_15px_#FF0055]' : 'bg-white/10 text-white hover:bg-white/20'}`}
                  >
                    {sourcePlaying ? <PauseIcon className="w-4 h-4" /> : <PlayIcon className="w-4 h-4 ml-0.5" />}
                  </button>
                  <div className="flex-1">
                    <div className="flex justify-between text-[10px] text-gray-400 font-mono mb-1.5 uppercase tracking-wider">
                      <span>ORIGINAL AUDIO</span>
                      <span>{sourceDuration > 0 ? (sourceDuration / 60).toFixed(2) + ' min' : '--:--'}</span>
                    </div>
                    <div
                      className="h-1.5 bg-white/10 rounded-full overflow-hidden w-full cursor-pointer group hover:h-2 transition-all"
                      onClick={seekSource}
                    >
                      <div
                        className="h-full bg-[#FF0055] shadow-[0_0_10px_#FF0055] relative"
                        style={{ width: `${sourceProgress}%` }}
                      />
                    </div>
                  </div>
                </div>
              </div>
            )}
          </LiquidCard>

          {/* 2. SCRIPT */}
          <LiquidCard title="2. Script with Markers">
            <p className="text-xs text-gray-600 mb-2">
              Paste the text. Use <code>[ON SCREEN: Title]</code> before each visual/section you want to cut.
            </p>
            <LiquidTextArea
              placeholder="# Example:\n[ON SCREEN: Intro]\nWelcome to this video...\n\n[ON SCREEN: Main Topic]\nToday we will discuss..."
              value={scriptText}
              onChange={(e) => setScriptText(e.target.value)}
            />
            <div className="pt-2">
              <LiquidButton
                disabled={!audioFile || !scriptText || (procState.status !== 'idle' && procState.status !== 'completed' && procState.status !== 'error')}
                onClick={startProcessing}
                className="w-full"
              >
                {procState.status === 'idle' || procState.status === 'completed' || procState.status === 'error' ? 'Analyze & Segment' : 'Processing...'}
              </LiquidButton>
            </div>

            {/* Active Processing State */}
            {procState.status !== 'idle' && procState.status !== 'completed' && procState.status !== 'error' && (
              <div className="mt-8 flex flex-col items-center justify-center py-4 animate-in fade-in duration-500">
                <div className="liquid-loader" />
                <p className="mt-4 text-xs font-medium text-gray-400 animate-pulse tracking-widest uppercase">{procState.message}</p>
                <div className="w-32 mt-2">
                  <LiquidProgressBar progress={procState.progress} />
                </div>
              </div>
            )}

            {procState.status === 'error' && (
              <div className="mt-4 p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-500 text-sm">
                {procState.message}
              </div>
            )}
          </LiquidCard>

        </div>

        {/* RIGHT COLUMN: OUTPUTS (7 cols) */}
        <div className="xl:col-span-7">
          <LiquidCard
            title="3. Generated Segments"
            className="min-h-[600px]"
            rightElement={
              segments.length > 0 && (
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setShowTimeline(true)}
                    className="flex items-center gap-2 bg-[#FF0055]/10 hover:bg-[#FF0055]/20 text-[#FF0055] px-3 py-1.5 rounded-full text-[10px] font-bold uppercase tracking-wider transition-all border border-[#FF0055]/20 active:scale-95"
                  >
                    <AdjustmentsHorizontalIcon className="w-3 h-3" />
                    Manual Precision Cut
                  </button>
                  <span className="bg-white/10 px-3 py-1.5 rounded-full text-[10px] font-bold text-gray-400 uppercase tracking-wider">
                    {segments.length} Segments
                  </span>
                </div>
              )
            }
          >
            {segments.length === 0 ? (
              <div className="flex-1 flex flex-col items-center justify-center h-full min-h-[400px] text-center opacity-40">
                <div className="w-16 h-16 mb-4 rounded-full bg-white/5 flex items-center justify-center">
                  <ArrowDownTrayIcon className="w-6 h-6 text-white" />
                </div>
                <h3 className="text-lg font-medium text-white">No Segments Yet</h3>
                <p className="text-sm text-gray-500 max-w-xs mt-2">
                  Upload audio and paste your script to generate precision cuts instantly.
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                {segments.map((seg, idx) => (
                  <div
                    key={idx}
                    className={`
                                            group relative p-3 rounded-xl border transition-all duration-200
                                            hover:bg-white/5 hover:border-white/10 flex items-center gap-3
                                            ${playingId === seg.blobUrl ? 'bg-[#FF0055]/5 border-[#FF0055]/20' : 'bg-transparent border-white/5'}
                                        `}
                  >
                    {/* Play Button - Smaller */}
                    <button
                      onClick={() => playPreview(seg.blobUrl)}
                      className={`
                                                    w-8 h-8 rounded-full flex items-center justify-center transition-all flex-shrink-0
                                                    ${playingId === seg.blobUrl ? 'bg-[#FF0055] text-white shadow-[0_0_15px_rgba(255,0,85,0.4)]' : 'bg-white/5 text-gray-500 group-hover:bg-white/10 group-hover:text-white'}
                                                `}
                    >
                      {playingId === seg.blobUrl ? <PauseIcon className="w-3 h-3" /> : <PlayIcon className="w-3 h-3 ml-0.5" />}
                    </button>

                    {/* Info - Compact */}
                    <div className="flex-1 min-w-0 flex flex-col justify-center">
                      <h4 className={`text-sm font-medium truncate leading-tight ${playingId === seg.blobUrl ? 'text-[#FF0055]' : 'text-gray-300 group-hover:text-white'} `}>
                        {seg.title}
                      </h4>
                      <div className="flex items-center gap-2 text-[10px] text-gray-600 font-mono mt-0.5">
                        <span className="uppercase tracking-wider">Seg {String(idx + 1).padStart(2, '0')}</span>
                        <span>•</span>
                        <span>{seg.duration.toFixed(1)}s</span>
                      </div>
                      {seg.text && (
                        <p className="text-xs text-gray-500 mt-2 line-clamp-2 italic border-l-2 border-white/5 pl-2">
                          "{seg.text}"
                        </p>
                      )}

                      {/* Progress Bar (Only when playing) */}
                      {playingId === seg.blobUrl && (
                        <div className="mt-3 animate-in fade-in slide-in-from-top-1 duration-300">
                          <div className="flex justify-between text-[10px] text-[#FF0055] font-mono mb-1 tracking-wider">
                            <span>{currentTime.toFixed(1)}s</span>
                            <span>{seg.duration.toFixed(1)}s</span>
                          </div>
                          <div
                            className="h-1 bg-white/10 rounded-full overflow-hidden w-full cursor-pointer hover:h-2 transition-all"
                            onClick={(e) => seekSegment(e, seg.duration)}
                          >
                            <div
                              className="h-full bg-[#FF0055] shadow-[0_0_10px_#FF0055] transition-all duration-100 ease-linear"
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Actions */}
                    <a
                      href={seg.blobUrl}
                      download={`segment_${idx + 1}.wav`}
                      className="opacity-0 group-hover:opacity-100 p-1.5 rounded-md hover:bg-white/10 text-gray-500 hover:text-white transition-all"
                    >
                      <ArrowDownTrayIcon className="w-4 h-4" />
                    </a>
                  </div>
                ))}

                <div className="mt-4 pt-6 border-t border-white/5 flex justify-end">
                  <LiquidButton variant="secondary" onClick={downloadAllSegments}>
                    Download All Segments (ZIP)
                  </LiquidButton>
                </div>
              </div>
            )}
          </LiquidCard>
        </div>

      </div>

      {/* Full Screen Modal Timeline */}
      {showTimeline && audioFile && segments.length > 0 && (
        <AudioTimeline
          audioFile={audioFile}
          segments={segments}
          onSegmentsUpdate={updateSegmentsPrecision}
          onClose={() => setShowTimeline(false)}
          onDownloadAll={downloadAllSegments}
        />
      )}
    </div>
  );

}

export default App;