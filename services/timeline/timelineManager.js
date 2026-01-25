class TimelineManager {
    constructor() {
        this.segments = []; // Segmentos del script
        this.timeline = []; // Videos asignados
    }

    /**
     * Parsea script y extrae segmentos
     * @param {string} script - Script con marcadores [ON SCREEN: ...]
     */
    parseScript(script) {
        const segments = [];
        const markerRegex = /\[ON\s*SCREEN[:\s-]*([^\]]+)\]/gi;
        const matches = Array.from(script.matchAll(markerRegex));

        if (matches.length === 0) {
            // Fallback if no markers found, treat whole text as one segment? or return empty
            console.warn('No [ON SCREEN] markers found in script.');
            // Optional: default to single segment using first line as headline
            const lines = script.trim().split('\n');
            if (lines.length > 0) {
                segments.push({
                    index: 0,
                    headline: lines[0],
                    text: lines.slice(1).join('\n'),
                    duration: this.estimateDuration(script),
                    status: 'pending'
                });
            }
            this.segments = segments;
            return segments;
        }

        for (let i = 0; i < matches.length; i++) {
            const headline = matches[i][1].trim();
            const textStart = matches[i].index + matches[i][0].length;
            const textEnd = (i < matches.length - 1) ? matches[i + 1].index : script.length;
            const text = script.substring(textStart, textEnd).trim();

            segments.push({
                index: i,
                headline,
                text,
                duration: this.estimateDuration(text), // segundos estimados
                video: null, // se asigna después
                status: 'pending' // pending, searching, found, downloaded, error
            });
        }

        this.segments = segments;
        return segments;
    }

    /**
     * Carga segmentos desde bloques ya procesados (App.tsx)
     * @param {Array} blocks - Array de StoryBlocks
     */
    loadSegmentsFromBlocks(blocks) {
        this.segments = blocks.map((b, idx) => ({
            index: idx,
            headline: b.title || "Scene " + (idx + 1),
            text: b.text,
            duration: b.duration || 5,
            video: null, // Se rellenará si ya existe match
            status: 'pending' // O checkear si b.videoMatches.length > 0
        }));
        this.updateTimeline();
        return this.segments;
    }

    /**
     * Estima duración en segundos basado en palabras
     * (aprox 150 palabras por minuto para narración)
     */
    estimateDuration(text) {
        const words = text.split(/\s+/).length;
        // 150 wpm = 2.5 words per second
        // Minimum 5 seconds duration
        return Math.max(5, Math.ceil(words / 2.5));
    }

    /**
     * Asigna un video a un segmento
     */
    assignVideo(segmentIndex, videoInfo) {
        if (!this.segments[segmentIndex]) return;

        this.segments[segmentIndex].video = videoInfo;
        this.segments[segmentIndex].status = 'found';

        this.updateTimeline();
    }

    updateTimeline() {
        this.timeline = this.segments.map((seg, idx) => ({
            segmentIndex: idx,
            headline: seg.headline,
            duration: seg.duration,
            video: seg.video,
            startTime: this.calculateStartTime(idx)
        }));
    }

    /**
     * Calcula tiempo de inicio acumulado
     */
    calculateStartTime(segmentIndex) {
        let time = 0;
        for (let i = 0; i < segmentIndex; i++) {
            time += this.segments[i].duration;
        }
        return time;
    }

    /**
     * Genera timeline visual para UI
     */
    getTimelineForUI() {
        return {
            totalDuration: this.segments.reduce((sum, s) => sum + s.duration, 0),
            segments: this.segments.map((seg, idx) => ({
                index: idx,
                headline: seg.headline,
                text: seg.text.length > 100 ? seg.text.substring(0, 100) + '...' : seg.text,
                duration: seg.duration,
                startTime: this.calculateStartTime(idx),
                video: seg.video ? {
                    title: seg.video.title,
                    thumbnail: seg.video.thumbnail,
                    url: seg.video.url,
                    downloadPath: seg.video.downloadPath // Important for Editor
                } : null,
                status: seg.status,
                progress: seg.progress || 0
            }))
        };
    }
}

export default new TimelineManager();
