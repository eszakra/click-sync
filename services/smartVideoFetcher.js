// smartVideoFetcher.js - Intelligent Video Fetcher with Gemini Vision
// Orchestrates script analysis, smart search, visual validation, and hybrid scoring

import path from 'path';
import fs from 'fs';
import { chromium } from 'playwright';
import followRedirects from 'follow-redirects';
const { https } = followRedirects;

import config from '../config.js';
import sessionManager from './browser/sessionManager.js';
import timelineManager from './timeline/timelineManager.js';
import videoEditor from './videoEditor.js';

// AI modules
import geminiClient from './ai/geminiClient.js';
import scriptAnalyzer from './ai/scriptAnalyzer.js';
import visualValidator from './ai/visualValidator.js';
import hybridScorer from './ai/hybridScorer.js';

import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { VioryDownloader } = require('../../electron/vioryDownloader.cjs');

class SmartVideoFetcher {
    constructor() {
        this.browser = null;
        this.context = null;
        this.page = null;
        this.isProcessing = false;
        this.globalContext = null;
        this.useVisualValidation = true; // Can be disabled if API fails
        this.apiErrorCount = 0;
        this.maxApiErrors = 5; // Disable visual validation after this many errors
    }

    /**
     * MAIN ENTRY POINT - Process timeline with AI-powered video matching
     * @param {string|null} scriptTextOrNull - Script text or null to use existing timeline
     * @param {Object} callbacks - Progress callbacks
     */
    async processTimeline(scriptTextOrNull, callbacks = {}) {
        if (this.isProcessing) throw new Error('Already processing');
        this.isProcessing = true;

        const {
            onSegmentStart = () => {},
            onSearchProgress = () => {},
            onVideoFound = () => {},
            onDownloadProgress = () => {},
            onSegmentComplete = () => {},
            onTimelineUpdate = () => {},
            onError = () => {},
            onAIStatus = () => {} // New: AI-specific status updates
        } = callbacks;

        try {
            console.log('═══════════════════════════════════════════════════════════');
            console.log('🚀 Starting Smart Video Fetcher with Gemini Vision');
            console.log('═══════════════════════════════════════════════════════════');

            // 1. Get segments from timeline
            let segments = timelineManager.segments;

            if (segments.length === 0 && scriptTextOrNull) {
                segments = timelineManager.parseScript(scriptTextOrNull);
            }

            if (segments.length === 0) {
                throw new Error('No segments found in timeline');
            }

            onTimelineUpdate(timelineManager.getTimelineForUI());

            // 2. PHASE 1: Global Script Analysis with Gemini
            onAIStatus({ phase: 'analyzing', message: 'Analizando contexto global del guion...' });

            try {
                this.globalContext = await scriptAnalyzer.analyzeGlobalContext(scriptTextOrNull || '');
                console.log('[SmartFetcher] Global context:', this.globalContext);
                onAIStatus({
                    phase: 'context_ready',
                    context: this.globalContext,
                    message: `Tema: ${this.globalContext.theme}, Personas: ${this.globalContext.main_people?.length || 0}`
                });
            } catch (e) {
                console.warn('[SmartFetcher] Global analysis failed, using defaults:', e.message);
                this.globalContext = { theme: 'News', main_people: [], main_places: [] };
            }

            // 3. Initialize browser & session
            await this.initBrowser();
            let hasSession = await sessionManager.loadSession(this.context);

            if (hasSession) {
                const isValid = await sessionManager.validateSession(this.page);
                if (!isValid) {
                    console.warn('[SmartFetcher] Session expired');
                    hasSession = false;
                }
            }

            if (!hasSession) {
                console.log('⚠️ No active session. Requesting manual login...');
                const loggedIn = await sessionManager.requestManualLogin();
                if (!loggedIn) throw new Error("User failed to log in to Viory.");
                await sessionManager.loadSession(this.context);
                await this.page.reload();
            }

            // 4. Process each segment with AI-powered matching
            let previousBlockAnalysis = null;

            for (let i = 0; i < segments.length; i++) {
                const segment = segments[i];

                if (segment.status === 'found') {
                    console.log(`[SmartFetcher] Segment ${i} already complete, skipping`);
                    continue;
                }

                onSegmentStart(segment);

                try {
                    // 4a. Analyze this segment with Gemini
                    onAIStatus({
                        phase: 'analyzing_block',
                        blockIndex: i,
                        message: `Analizando segmento ${i + 1}...`
                    });

                    const blockAnalysis = await scriptAnalyzer.analyzeBlock(
                        { index: i, headline: segment.headline, text: segment.text || segment.headline },
                        this.globalContext,
                        previousBlockAnalysis
                    );

                    console.log(`[SmartFetcher] Block ${i} analysis:`, {
                        type: blockAnalysis.block_type,
                        person: blockAnalysis.main_person,
                        queries: blockAnalysis.queries?.length
                    });

                    onAIStatus({
                        phase: 'block_analyzed',
                        blockIndex: i,
                        analysis: blockAnalysis,
                        message: `Tipo: ${blockAnalysis.block_type}, Persona: ${blockAnalysis.main_person || 'N/A'}`
                    });

                    // 4b. Search with smart queries
                    const videoResult = await this.findBestVideoWithAI(
                        segment,
                        blockAnalysis,
                        {
                            onProgress: onSearchProgress,
                            onDownload: onDownloadProgress,
                            onAIStatus
                        }
                    );

                    if (videoResult) {
                        // 4c. Update timeline & editor
                        timelineManager.assignVideo(segment.index, videoResult);
                        onVideoFound({ segment: segment.index, video: videoResult });

                        await videoEditor.addClipToTimeline(
                            segment.index,
                            videoResult.downloadPath,
                            segment.duration,
                            { headline: segment.headline }
                        );

                        onSegmentComplete({ segment: segment.index, success: true, video: videoResult });
                    } else {
                        onSegmentComplete({ segment: segment.index, success: false });
                    }

                    previousBlockAnalysis = blockAnalysis;
                    onTimelineUpdate(timelineManager.getTimelineForUI());

                } catch (err) {
                    console.error(`[SmartFetcher] Error processing segment ${i}:`, err);
                    onError({ segment: segment.index, error: err.message });
                    segment.status = 'error';
                }
            }

            return timelineManager.getTimelineForUI();

        } finally {
            await this.cleanup();
            this.isProcessing = false;
        }
    }

    /**
     * Find the best video using AI-powered analysis
     */
    async findBestVideoWithAI(segment, blockAnalysis, callbacks = {}) {
        const { onProgress, onDownload, onAIStatus } = callbacks;
        const queries = blockAnalysis.queries || [segment.headline];

        console.log(`[SmartFetcher] Finding video for: "${segment.headline}"`);
        console.log(`[SmartFetcher] Using ${queries.length} smart queries`);

        // Initialize downloader
        const downloader = new VioryDownloader();

        try {
            const cookiesPath = sessionManager.cookiesFile;
            onProgress({ type: 'init', message: 'Inicializando buscador...' });

            await downloader.init({
                headless: true,
                cookiesPath: cookiesPath
            });

            // Search with smart queries and capture screenshots
            onAIStatus({ phase: 'searching', message: 'Buscando videos con queries inteligentes...' });

            const searchResult = await downloader.searchWithSmartQueries(
                queries,
                blockAnalysis,
                {
                    maxVideosPerQuery: 3,
                    captureScreenshots: this.useVisualValidation,
                    onProgress: (data) => {
                        onProgress(data);
                        if (data.type === 'found') {
                            onAIStatus({
                                phase: 'videos_found',
                                count: data.totalSoFar,
                                message: `Encontrados ${data.totalSoFar} videos`
                            });
                        }
                    }
                }
            );

            if (!searchResult.videos || searchResult.videos.length === 0) {
                console.log('[SmartFetcher] No videos found with any query');
                return null;
            }

            console.log(`[SmartFetcher] Found ${searchResult.videos.length} candidate videos`);

            // Visual validation phase
            let rankedVideos = searchResult.videos;

            if (this.useVisualValidation && this.apiErrorCount < this.maxApiErrors) {
                onAIStatus({ phase: 'visual_validation', message: 'Validando visualmente con Gemini Vision...' });

                try {
                    rankedVideos = await this.validateAndRankVideos(
                        searchResult.videos,
                        blockAnalysis,
                        queries[0] || segment.headline
                    );
                } catch (e) {
                    console.error('[SmartFetcher] Visual validation failed:', e.message);
                    this.apiErrorCount++;

                    if (this.apiErrorCount >= this.maxApiErrors) {
                        console.warn('[SmartFetcher] Too many API errors, disabling visual validation');
                        this.useVisualValidation = false;
                        onAIStatus({
                            phase: 'visual_disabled',
                            message: 'Validacion visual deshabilitada por errores de API'
                        });
                    }

                    // Fall back to text-only scoring
                    rankedVideos = this.rankByTextOnly(searchResult.videos, queries[0], blockAnalysis);
                }
            } else {
                // Text-only scoring
                rankedVideos = this.rankByTextOnly(searchResult.videos, queries[0], blockAnalysis);
            }

            // Get best video that passes threshold
            const bestVideo = hybridScorer.getBestVideo(rankedVideos, blockAnalysis, {
                minScore: 35,
                requirePersonMatch: blockAnalysis.block_type === 'PERSONA_HABLANDO'
            });

            if (!bestVideo) {
                // Fallback: just take the highest scored video
                console.log('[SmartFetcher] No video passed threshold, using best available');
                const fallback = rankedVideos[0];
                if (fallback && fallback.finalScore >= 20) {
                    return await this.downloadAndReturn(downloader, fallback, segment, onDownload);
                }
                return null;
            }

            onAIStatus({
                phase: 'best_selected',
                video: bestVideo,
                message: `Mejor video: Score ${bestVideo.finalScore} - "${(bestVideo.title || '').substring(0, 40)}..."`
            });

            // Download the best video
            return await this.downloadAndReturn(downloader, bestVideo, segment, onDownload);

        } catch (e) {
            console.error('[SmartFetcher] Error in findBestVideoWithAI:', e);
            throw e;
        } finally {
            try {
                await downloader.close();
                downloader.clearScreenshotCache();
            } catch (e) { /* ignore */ }
        }
    }

    /**
     * Validate videos visually and rank them
     */
    async validateAndRankVideos(videos, blockAnalysis, query) {
        console.log(`[SmartFetcher] Validating ${videos.length} videos visually...`);

        const validatedVideos = [];

        for (let i = 0; i < Math.min(videos.length, 5); i++) {
            const video = videos[i];

            // Calculate text score
            const textScore = hybridScorer.calculateTextScore(
                query,
                {
                    title: video.title,
                    description: video.description,
                    videoInfo: video.videoInfo,
                    shotList: video.shotList
                },
                blockAnalysis
            );

            video.textScoreResult = textScore;

            // Visual validation if screenshot available
            if (video.screenshot || video.screenshotBase64) {
                try {
                    const imageData = video.screenshot || Buffer.from(video.screenshotBase64, 'base64');

                    const visualAnalysis = await visualValidator.analyzeVideoThumbnail(
                        imageData,
                        blockAnalysis,
                        { title: video.title, description: video.description }
                    );

                    video.visualAnalysis = visualAnalysis;

                    // Calculate hybrid score
                    const hybridResult = hybridScorer.calculateHybridScore(
                        textScore,
                        visualAnalysis,
                        blockAnalysis
                    );

                    video.hybridResult = hybridResult;
                    video.finalScore = hybridResult.finalScore;

                    console.log(`[SmartFetcher] Video ${i + 1}: Text=${textScore.score}, Visual=${visualAnalysis.relevance_score}, Final=${hybridResult.finalScore}`);

                } catch (e) {
                    console.warn(`[SmartFetcher] Visual analysis failed for video ${i}:`, e.message);
                    video.finalScore = textScore.score;
                    video.hybridResult = { finalScore: textScore.score, textScore: textScore.score, visualScore: null };
                }
            } else {
                // No screenshot, use text score only
                video.finalScore = textScore.score;
                video.hybridResult = { finalScore: textScore.score, textScore: textScore.score, visualScore: null };
            }

            validatedVideos.push(video);

            // Delay between API calls
            if (i < videos.length - 1 && video.screenshot) {
                await new Promise(r => setTimeout(r, 1500));
            }
        }

        // Sort by final score
        validatedVideos.sort((a, b) => b.finalScore - a.finalScore);

        return validatedVideos;
    }

    /**
     * Rank videos using text-only scoring (fallback)
     */
    rankByTextOnly(videos, query, blockAnalysis) {
        return videos.map(video => {
            const textScore = hybridScorer.calculateTextScore(
                query,
                {
                    title: video.title,
                    description: video.description,
                    videoInfo: video.videoInfo,
                    shotList: video.shotList
                },
                blockAnalysis
            );

            return {
                ...video,
                textScoreResult: textScore,
                finalScore: textScore.score,
                hybridResult: { finalScore: textScore.score, textScore: textScore.score, visualScore: null }
            };
        }).sort((a, b) => b.finalScore - a.finalScore);
    }

    /**
     * Download video and return result
     */
    async downloadAndReturn(downloader, video, segment, onDownload) {
        console.log(`[SmartFetcher] Downloading: ${video.url}`);

        const result = await downloader.downloadVideo(video.url, (progressData) => {
            if (progressData.status === 'downloading') {
                onDownload({ type: 'downloading', percent: 50, filename: progressData.filename });
            }
        });

        if (result && result.success) {
            return {
                url: video.url,
                downloadPath: result.path,
                title: video.title,
                segmentDuration: segment.duration,
                finalScore: video.finalScore,
                textScore: video.textScoreResult?.score,
                visualScore: video.visualAnalysis?.relevance_score,
                recommendation: video.hybridResult?.recommendation
            };
        }

        console.warn('[SmartFetcher] Download failed');
        return null;
    }

    /**
     * Get Chromium executable path (cross-platform, handles bundled + cache)
     */
    _getChromiumExecutablePath() {
        // Try bundled Chromium in packaged app
        try {
            const appPath = path.dirname(process.execPath);
            const resourceBase = path.join(appPath, 'resources', 'playwright-browsers', 'chromium');
            
            let chromiumPath;
            if (process.platform === 'win32') {
                chromiumPath = path.join(resourceBase, 'chrome-win64', 'chrome.exe');
            } else if (process.platform === 'darwin') {
                const macPaths = [
                    path.join(resourceBase, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                    path.join(resourceBase, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                    path.join(resourceBase, 'chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                    path.join(resourceBase, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                    path.join(resourceBase, 'chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                    path.join(resourceBase, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
                ];
                chromiumPath = macPaths.find(p => fs.existsSync(p));
            } else {
                chromiumPath = path.join(resourceBase, 'chrome-linux', 'chrome');
            }
            
            if (chromiumPath && fs.existsSync(chromiumPath)) {
                console.log('[SmartFetcher] Using bundled Chromium:', chromiumPath);
                return chromiumPath;
            }
        } catch (e) { /* Not in packaged app */ }

        // On macOS, try Playwright's default cache location
        if (process.platform === 'darwin') {
            try {
                const homeDir = process.env.HOME || '';
                const playwrightCache = path.join(homeDir, 'Library', 'Caches', 'ms-playwright');
                if (fs.existsSync(playwrightCache)) {
                    const chromiumDirs = fs.readdirSync(playwrightCache).filter(d => d.startsWith('chromium-')).sort().reverse();
                    for (const dir of chromiumDirs) {
                        const cachePaths = [
                            path.join(playwrightCache, dir, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                            path.join(playwrightCache, dir, 'chrome-mac-x64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'),
                            path.join(playwrightCache, dir, 'chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
                            path.join(playwrightCache, dir, 'chrome-mac-x64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium')
                        ];
                        const found = cachePaths.find(p => fs.existsSync(p));
                        if (found) {
                            console.log('[SmartFetcher] Using Playwright cache Chromium:', found);
                            return found;
                        }
                    }
                }
            } catch (e) { /* ignore */ }
        }

        return undefined;
    }

    /**
     * Initialize browser for session management
     */
    async initBrowser() {
        const executablePath = this._getChromiumExecutablePath();
        const launchOptions = {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        };
        if (executablePath) {
            launchOptions.executablePath = executablePath;
        } else {
            launchOptions.channel = 'chromium';
        }
        this.browser = await chromium.launch(launchOptions);
        this.context = await this.browser.newContext({
            viewport: { width: 1280, height: 720 }
        });
        this.page = await this.context.newPage();
    }

    /**
     * Re-enable visual validation (e.g., after API key change)
     */
    enableVisualValidation() {
        this.useVisualValidation = true;
        this.apiErrorCount = 0;
        geminiClient.reinitialize();
        console.log('[SmartFetcher] Visual validation re-enabled');
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            isProcessing: this.isProcessing,
            visualValidationEnabled: this.useVisualValidation,
            apiErrorCount: this.apiErrorCount,
            globalContext: this.globalContext,
            geminiStatus: geminiClient.getStatus()
        };
    }

    /**
     * Cleanup resources
     */
    async cleanup() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
            this.context = null;
            this.page = null;
        }
    }

    /**
     * Legacy download method for compatibility
     */
    async downloadVideo(url, index, onProgress) {
        const filename = `segment_${index}_${Date.now()}.mp4`;
        const destPath = path.join(config.paths.downloads, filename);

        if (!fs.existsSync(config.paths.downloads)) {
            fs.mkdirSync(config.paths.downloads, { recursive: true });
        }

        onProgress({ type: 'download_start', filename });

        return new Promise((resolve, reject) => {
            const file = fs.createWriteStream(destPath);
            https.get(url, (response) => {
                const total = parseInt(response.headers['content-length'], 10);
                let cur = 0;

                response.on('data', (chunk) => {
                    cur += chunk.length;
                    file.write(chunk);
                    if (total) {
                        onProgress({
                            type: 'downloading',
                            percent: (cur / total) * 100
                        });
                    }
                });

                response.on('end', () => {
                    file.end();
                    onProgress({ type: 'download_complete', path: destPath });
                    resolve(destPath);
                });
            }).on('error', (err) => {
                fs.unlink(destPath, () => {});
                reject(err);
            });
        });
    }
}

export default new SmartVideoFetcher();
