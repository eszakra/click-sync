import { useState, useEffect, useRef, useCallback } from 'react';
import { getAudioEngine, AudioState } from '../services/AudioSyncEngine';
import { AudioClip } from '../types';

export interface UseAudioSyncResult {
    currentTime: number;
    duration: number;
    isPlaying: boolean;
    isLoading: boolean;
    isReady: boolean;
    error: boolean;
    audioBuffer: AudioBuffer | null;
    play: () => Promise<void>;
    pause: () => void;
    playPause: () => Promise<void>;
    seek: (time: number) => void;
    setVolume: (volume: number) => void;
}

/**
 * React hook that bridges AudioSyncEngine with component state
 * Uses requestAnimationFrame for 60fps time updates
 */
export function useAudioSync(audioUrl: string | null, clips?: AudioClip[]): UseAudioSyncResult {
    const [currentTime, setCurrentTime] = useState(0);
    const [duration, setDuration] = useState(0);
    const [isPlaying, setIsPlaying] = useState(false);
    const [state, setState] = useState<AudioState>('idle');

    const rafRef = useRef<number | null>(null);
    const lastUrlRef = useRef<string | null>(null);
    const desiredTimeRef = useRef(0);

    const engine = getAudioEngine();

    // Animation frame loop for smooth time updates
    const updateLoop = useCallback(() => {
        setCurrentTime(engine.getCurrentTime());
        rafRef.current = requestAnimationFrame(updateLoop);
    }, [engine]);

    // Start/stop the rAF loop based on playing state
    useEffect(() => {
        if (isPlaying) {
            rafRef.current = requestAnimationFrame(updateLoop);
        } else {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
                rafRef.current = null;
            }
            // Update time one last time when paused
            setCurrentTime(engine.getCurrentTime());
        }

        return () => {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
            }
        };
    }, [isPlaying, updateLoop, engine]);

    // Load audio when URL or Clips change
    useEffect(() => {
        // Log props for debugging
        console.log(`[useAudioSync] Effect Triggered. AudioUrl: ${!!audioUrl}, Clips: ${clips?.length ?? 'undefined'}`);

        if (!audioUrl && (!clips || clips.length === 0)) {
            console.log('[useAudioSync] No data. Resetting state.');
            setState('idle');
            setDuration(0);
            setCurrentTime(0);
            desiredTimeRef.current = 0;
            return;
        }

        // Setup Event Handlers (Shared)
        engine.setEventHandlers({
            onStateChange: (newState) => {
                setState(newState);
                setIsPlaying(newState === 'playing');
            },
            onEnded: () => {
                setIsPlaying(false);
            },
            onTimeUpdate: (time) => {
                setCurrentTime(time);
            }
        });

        // ALWAYS load master audio from URL first (ensures fallback works)
        const loadMaster = async () => {
            if (audioUrl && audioUrl !== lastUrlRef.current) {
                console.log('[useAudioSync] Loading master audio from URL...');
                lastUrlRef.current = audioUrl;
                try {
                    await engine.loadFromUrl(audioUrl);
                    console.log('[useAudioSync] Master audio loaded. Duration:', engine.getDuration());
                } catch (err) {
                    console.error('[useAudioSync] Failed to load audio URL:', err);
                }
            }

            // After loading master, apply clips if provided (NLE mode)
            if (clips && clips.length > 0) {
                console.log('[useAudioSync] Applying NLE Clips:', clips.length);
                engine.setClips(clips);
                const totalDuration = clips.reduce((max, clip) => Math.max(max, clip.startTime + clip.duration), 0);
                setDuration(totalDuration);
            } else {
                // No clips, use master buffer duration
                setDuration(engine.getDuration());
            }

            // Seek to desired time if needed
            if (desiredTimeRef.current > 0) {
                engine.seek(desiredTimeRef.current);
                setCurrentTime(desiredTimeRef.current);
            } else {
                setCurrentTime(0);
            }
        };

        loadMaster();
    }, [audioUrl, clips, engine]);


    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (rafRef.current) {
                cancelAnimationFrame(rafRef.current);
            }
        };
    }, []);

    // Actions
    const play = useCallback(async () => {
        if (desiredTimeRef.current !== currentTime) {
            desiredTimeRef.current = currentTime;
        }
        engine.seek(desiredTimeRef.current);
        await engine.play();
    }, [engine, currentTime]);

    const pause = useCallback(() => {
        engine.pause();
    }, [engine]);

    const playPause = useCallback(async () => {
        await engine.playPause();
    }, [engine]);

    const seek = useCallback((time: number) => {
        desiredTimeRef.current = time;
        engine.seek(time);
        setCurrentTime(time);
    }, [engine]);

    const setVolume = useCallback((volume: number) => {
        engine.setVolume(volume);
    }, [engine]);

    const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);

    // ... (logic) ...

    // Update buffer when state changes to ready or loading finishes
    useEffect(() => {
        if (state === 'ready' || state === 'playing' || state === 'paused') {
            setAudioBuffer(engine.getAudioBuffer());
        } else {
            setAudioBuffer(null);
        }
    }, [state, engine]);

    return {
        currentTime,
        duration,
        isPlaying,
        isLoading: state === 'loading',
        isReady: state === 'ready' || state === 'playing' || state === 'paused',
        error: state === 'error',
        audioBuffer, // Exposed
        play,
        pause,
        playPause,
        seek,
        setVolume,
    };
}

export default useAudioSync;
