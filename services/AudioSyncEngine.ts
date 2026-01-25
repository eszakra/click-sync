/**
 * AudioSyncEngine - Web Audio API Singleton for frame-accurate playback
 * 
 * Provides ±1ms synchronization accuracy vs ±250ms with HTML audio elements.
 * Uses audioContext.currentTime as the single source of truth.
 */

export type AudioState = 'idle' | 'loading' | 'ready' | 'playing' | 'paused' | 'error';

export interface AudioEngineEvents {
    onStateChange?: (state: AudioState) => void;
    onTimeUpdate?: (time: number) => void;
    onEnded?: () => void;
}

import { AudioClip } from '../types';





class AudioSyncEngine {
    private static instance: AudioSyncEngine;
    private audioContext: AudioContext | null = null;
    private masterGain: GainNode | null = null;

    // NLE: Clips instead of single buffer
    private clips: AudioClip[] = [];
    private activeSources: Map<string, AudioBufferSourceNode> = new Map();
    private masterBuffer: AudioBuffer | null = null; // Unified master buffer

    private _state: AudioState = 'idle';
    private _currentTime: number = 0;       // Current timeline position
    private _playbackAnchorTime: number = 0; // AudioContext time when timeline was at 0 (virtual)
    private _pausedAt: number = 0;
    private _duration: number = 0;          // Total timeline duration

    private events: AudioEngineEvents = {};
    private rafId: number | null = null;

    private constructor() { }

    public static getInstance(): AudioSyncEngine {
        if (!AudioSyncEngine.instance) {
            AudioSyncEngine.instance = new AudioSyncEngine();
        }
        return AudioSyncEngine.instance;
    }

    private async ensureContext(): Promise<AudioContext> {
        if (!this.audioContext) {
            this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
            this.masterGain = this.audioContext.createGain();
            this.masterGain.connect(this.audioContext.destination);
        }
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume();
        }
        return this.audioContext!;
    }

    /**
     * NLE: Set the clips for the timeline
     */
    public setClips(clips: AudioClip[]) {
        this.stop(); // Clear current playback
        this.clips = clips;

        // Recalculate total duration based on last clip end
        this._duration = clips.reduce((max, clip) =>
            Math.max(max, clip.startTime + clip.duration), 0);

        this.setState('ready');
    }

    public getClips(): AudioClip[] {
        return this.clips;
    }

    public async play() {
        if (this._state === 'playing') return;
        const context = await this.ensureContext();

        // Calculate the "Anchor Time":
        // If we want to start playing at T=_pausedAt, and the current clock is ContextTime,
        // then the virtual timeline started at (ContextTime - _pausedAt).
        // This makes time math simple: EventTime_Context = Anchor_Context + EventTime_Timeline
        this._playbackAnchorTime = context.currentTime - this._pausedAt;

        // FALLBACK: If no clips but we have a masterBuffer, play it directly (like original)
        if (this.clips.length === 0 && this.masterBuffer) {
            console.log('[AudioSyncEngine] FALLBACK: Playing masterBuffer directly (no clips)');
            this.playMasterBufferDirect();
        } else {
            this.scheduleClips();
        }
        this.setState('playing');
        this.startLoop();
    }

    /**
     * Fallback playback: Play the entire masterBuffer as a single source
     * Used when no AudioClips are defined (legacy/simple mode)
     */
    private playMasterBufferDirect() {
        if (!this.audioContext || !this.masterGain || !this.masterBuffer) return;

        const source = this.audioContext.createBufferSource();
        source.buffer = this.masterBuffer;
        source.connect(this.masterGain);

        const startOffset = this._pausedAt;
        source.start(0, startOffset);

        const sourceId = `master_${Date.now()}`;
        this.activeSources.set(sourceId, source);
        source.onended = () => {
            this.activeSources.delete(sourceId);
        };
    }


    public pause() {
        if (this._state !== 'playing') return;

        this.stopAllSources();
        this._pausedAt = this.getCurrentTime();
        this.setState('paused');
        this.stopLoop();
    }

    public async playPause() {
        if (this._state === 'playing') {
            this.pause();
        } else {
            await this.play();
        }
    }

    public seek(time: number) {
        const wasPlaying = this._state === 'playing';
        if (wasPlaying) {
            this.stopAllSources();
        }

        // Clamp to valid range
        this._pausedAt = Math.max(0, time); // Allow seeking past end for creating space? limit to duration for now
        if (this._duration > 0) {
            this._pausedAt = Math.min(this._pausedAt, this._duration + 1); // Allow 1s past end
        }

        this._currentTime = this._pausedAt;
        this.events.onTimeUpdate?.(this._currentTime);

        if (wasPlaying) {
            if (this.audioContext) {
                this._playbackAnchorTime = this.audioContext.currentTime - this._pausedAt;
            }
            this.scheduleClips();
        }
    }

    /**
     * Core NLE Scheduler
     * Schedules all relevant clips based on current time
     */
    private scheduleClips() {
        if (!this.audioContext || !this.masterGain) return;

        const nowTimeline = this._pausedAt;
        const nowContext = this.audioContext.currentTime;
        const lookahead = 0.1; // Scheduling tolerance


        console.log(`[AudioSyncEngine] scheduleClips. Time: ${nowTimeline}, Ctx: ${nowContext}, Clips: ${this.clips.length}`);

        this.clips.forEach(clip => {

            const clipEnd = clip.startTime + clip.duration;

            // Only schedule if the clip ends in the future (or right now)
            if (clipEnd > nowTimeline) {

                // create source
                const source = this.audioContext!.createBufferSource();
                source.buffer = clip.buffer;
                source.connect(this.masterGain!);

                // Logic:
                // Clip Start on Timeline: clip.startTime
                // Current Timeline: nowTimeline

                let whenToStartContext = 0;
                let offsetInClip = 0;
                let durationToPlay = 0;

                if (clip.startTime >= nowTimeline) {
                    // CASE 1: Future Clip
                    // Starts after current time.
                    // Schedule it relative to anchor.
                    whenToStartContext = this._playbackAnchorTime + clip.startTime;
                    offsetInClip = clip.offset;
                    durationToPlay = clip.duration;

                } else {
                    // CASE 2: Currently Playing Clip
                    // We are starting middle of the clip.
                    const timeIntoClip = nowTimeline - clip.startTime;

                    // It should start RIGHT NOW (or slightly adjusted for processing latency if we want consistency)
                    // But standard approach is:
                    whenToStartContext = nowContext; // Start now

                    // We must jump into the buffer by the amount we missed
                    offsetInClip = clip.offset + timeIntoClip;
                    durationToPlay = clip.duration - timeIntoClip;
                }

                // Protect against tiny negative durations or offsets if math is slighty off
                if (durationToPlay > 0) {
                    console.log(`[AudioSyncEngine] Starting Clip ${clip.id}: @ ${whenToStartContext} (offset: ${offsetInClip}, dur: ${durationToPlay})`);
                    source.start(whenToStartContext, offsetInClip, durationToPlay);

                    // Store strict reference
                    const sourceId = `${clip.id}_${Date.now()}_${Math.random()}`;
                    this.activeSources.set(sourceId, source);

                    source.onended = () => {
                        this.activeSources.delete(sourceId);
                    };
                }
            }
        });
    }

    private stopAllSources() {
        this.activeSources.forEach(source => {
            try { source.stop(); } catch (e) { }
            source.disconnect();
        });
        this.activeSources.clear();
    }

    private stop() {
        this.stopAllSources();
        this._pausedAt = 0;
        this.setState('idle');
        this.stopLoop();
    }

    public setVolume(val: number) {
        if (this.masterGain && this.audioContext) {
            this.masterGain.gain.cancelScheduledValues(0);
            this.masterGain.gain.setTargetAtTime(Math.max(0, Math.min(1, val)), this.audioContext.currentTime, 0.05);
        }
    }

    public getDuration() { return this._duration; }

    public getCurrentTime() {
        if (this._state === 'playing' && this.audioContext) {
            return this.audioContext.currentTime - this._playbackAnchorTime;
        }
        return this._pausedAt;
    }

    public setEventHandlers(events: AudioEngineEvents) {
        this.events = events;
    }

    private setState(state: AudioState) {
        this._state = state;
        this.events.onStateChange?.(state);
    }

    private startLoop() {
        this.stopLoop();
        const loop = () => {
            const time = this.getCurrentTime();
            this._currentTime = time;
            this.events.onTimeUpdate?.(time);

            if (time >= this._duration && this._duration > 0 && this.activeSources.size === 0) {
                // If past duration AND no sources playing (silence at end?)
                // Pause just at the end
                this.pause();
                this.seek(0);
                this.events.onEnded?.();
            } else {
                this.rafId = requestAnimationFrame(loop);
            }
        };
        loop();
    }

    private stopLoop() {
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
    }

    // --- Data Loading ---

    public getAudioBuffer() { return this.masterBuffer; }

    public async loadFromFile(file: File): Promise<void> {
        const context = await this.ensureContext();
        const arrayBuffer = await file.arrayBuffer();
        this.masterBuffer = await context.decodeAudioData(arrayBuffer);
        this._duration = this.masterBuffer.duration;
        this.setState('ready');
    }

    public async loadFromUrl(url: string): Promise<void> {
        const context = await this.ensureContext();
        const response = await fetch(url);
        const arrayBuffer = await response.arrayBuffer();
        this.masterBuffer = await context.decodeAudioData(arrayBuffer);
        this._duration = this.masterBuffer.duration;
        this.setState('ready');
    }

    public dispose() { this.stop(); this.audioContext?.close(); }
}

// Export singleton instance getter
export const getAudioEngine = () => AudioSyncEngine.getInstance();
export default AudioSyncEngine;
