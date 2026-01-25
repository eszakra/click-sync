// hybridScorer.js - Combines text-based and visual scoring for video ranking
// Uses weighted combination of text metadata analysis and Gemini Vision results

// Priority keywords that boost score
const PRIORITY_KEYWORDS = [
    'speech', 'address', 'statement', 'interview', 'remarks',
    'talking', 'speaks', 'announces', 'conference', 'meeting',
    'summit', 'press', 'declaration', 'briefing'
];

// Negative keywords that reduce score
const NEGATIVE_KEYWORDS = [
    'graphic', 'animation', 'illustration', 'map', 'chart',
    'infographic', 'logo', 'text only', 'breaking news graphic'
];

/**
 * Calculate text-based relevance score
 * @param {string} query - Original search query
 * @param {Object} metadata - Video metadata (title, description, videoInfo, shotList)
 * @param {Object} blockAnalysis - Block analysis with main_person, topic, etc.
 * @returns {Object} Text score breakdown
 */
export function calculateTextScore(query, metadata, blockAnalysis) {
    let score = 0;
    const breakdown = {
        exactMatch: 0,
        keywordMatches: 0,
        titleMatches: 0,
        personMatch: 0,
        priorityKeywords: 0,
        negativeKeywords: 0
    };

    const queryLower = (query || '').toLowerCase();
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);

    // Combine all text content
    const content = (
        (metadata.title || '') + ' ' +
        (metadata.description || '') + ' ' +
        (metadata.videoInfo || '') + ' ' +
        (metadata.shotList || '')
    ).toLowerCase();

    const titleLower = (metadata.title || '').toLowerCase();

    // 1. Exact query match in content (+30)
    if (content.includes(queryLower)) {
        score += 30;
        breakdown.exactMatch = 30;
    }

    // 2. Individual keyword matches (+8 each, max 40)
    let keywordScore = 0;
    queryWords.forEach(word => {
        if (content.includes(word)) {
            keywordScore += 8;
            breakdown.keywordMatches++;
        }
    });
    score += Math.min(keywordScore, 40);

    // 3. Keywords in title (extra weight, +10 each, max 30)
    let titleScore = 0;
    queryWords.forEach(word => {
        if (titleLower.includes(word)) {
            titleScore += 10;
            breakdown.titleMatches++;
        }
    });
    score += Math.min(titleScore, 30);

    // 4. Main person name match (+25)
    if (blockAnalysis.main_person) {
        const personParts = blockAnalysis.main_person.toLowerCase().split(' ');
        const hasPersonMatch = personParts.some(part =>
            part.length > 3 && content.includes(part)
        );
        if (hasPersonMatch) {
            score += 25;
            breakdown.personMatch = 25;
        }
    }

    // 5. Priority keywords bonus (+5 each, max 20)
    let priorityScore = 0;
    PRIORITY_KEYWORDS.forEach(kw => {
        if (content.includes(kw)) {
            priorityScore += 5;
            breakdown.priorityKeywords++;
        }
    });
    score += Math.min(priorityScore, 20);

    // 6. Negative keywords penalty (-10 each, max -30)
    let negativeScore = 0;
    NEGATIVE_KEYWORDS.forEach(kw => {
        if (content.includes(kw)) {
            negativeScore -= 10;
            breakdown.negativeKeywords++;
        }
    });
    score += Math.max(negativeScore, -30);

    // 7. Missing title penalty (-15)
    if (!metadata.title || metadata.title.length < 5) {
        score -= 15;
    }

    // Normalize to 0-100 range
    const normalizedScore = Math.max(0, Math.min(100, score));

    return {
        score: normalizedScore,
        breakdown,
        raw: score
    };
}

/**
 * Calculate hybrid score combining text and visual analysis
 * @param {Object} textScore - Result from calculateTextScore
 * @param {Object} visualAnalysis - Result from visualValidator.analyzeVideoThumbnail
 * @param {Object} blockAnalysis - Block analysis
 * @param {Object} options - Scoring options
 * @returns {Object} Final hybrid score
 */
export function calculateHybridScore(textScore, visualAnalysis, blockAnalysis, options = {}) {
    // Default weights: 40% text, 60% visual (when visual is available)
    const weights = options.weights || {
        text: 0.4,
        visual: 0.6
    };

    // If no visual analysis, use text only
    if (!visualAnalysis || !visualAnalysis.success || visualAnalysis.relevance_score === undefined) {
        return {
            finalScore: textScore.score,
            textScore: textScore.score,
            visualScore: null,
            weights: { text: 1.0, visual: 0 },
            confidence: 'TEXT_ONLY',
            recommendation: getRecommendation(textScore.score, null, blockAnalysis)
        };
    }

    const visualScore = visualAnalysis.relevance_score || 0;

    // Calculate weighted score
    let finalScore = (textScore.score * weights.text) + (visualScore * weights.visual);

    // Apply bonuses/penalties based on visual analysis

    // Bonus: Visual confirms person match (+15)
    if (visualAnalysis.person_match === 'CONFIRMED') {
        finalScore += 15;
    } else if (visualAnalysis.person_match === 'LIKELY') {
        finalScore += 8;
    }

    // Bonus: High visual confidence (+10)
    if (visualAnalysis.confidence >= 0.8) {
        finalScore += 10;
    }

    // Penalty: Graphics only (-25)
    if (visualAnalysis.is_graphics_only || visualAnalysis.scene_type === 'GRAPHICS') {
        finalScore -= 25;
    }

    // Penalty: Content type mismatch
    if (blockAnalysis.block_type === 'PERSONA_HABLANDO' &&
        visualAnalysis.scene_type !== 'SPEECH' &&
        visualAnalysis.scene_type !== 'MEETING') {
        finalScore -= 15;
    }

    // Penalty: Visual says reject but text is high
    if (visualAnalysis.recommendation === 'REJECT' && textScore.score > 60) {
        finalScore -= 10; // Trust visual more
    }

    // Normalize final score
    finalScore = Math.max(0, Math.min(100, finalScore));

    return {
        finalScore: Math.round(finalScore),
        textScore: textScore.score,
        visualScore: visualScore,
        weights,
        visualConfidence: visualAnalysis.confidence,
        personMatch: visualAnalysis.person_match,
        sceneType: visualAnalysis.scene_type,
        confidence: visualAnalysis.confidence >= 0.7 ? 'HIGH' : visualAnalysis.confidence >= 0.4 ? 'MEDIUM' : 'LOW',
        recommendation: getRecommendation(finalScore, visualAnalysis, blockAnalysis)
    };
}

/**
 * Get recommendation based on score and analysis
 */
function getRecommendation(score, visualAnalysis, blockAnalysis) {
    // If visual explicitly rejects, follow that
    if (visualAnalysis?.recommendation === 'REJECT' && visualAnalysis?.confidence >= 0.7) {
        return 'REJECT';
    }

    // Score thresholds
    if (score >= 70) return 'ACCEPT';
    if (score >= 45) return 'REVIEW';
    return 'REJECT';
}

/**
 * Rank multiple videos using hybrid scoring
 * @param {Array} videos - Array of video objects with metadata and visualAnalysis
 * @param {string} query - Search query
 * @param {Object} blockAnalysis - Block analysis
 * @returns {Array} Sorted array with scores
 */
export function rankVideos(videos, query, blockAnalysis) {
    console.log(`[HybridScorer] Ranking ${videos.length} videos...`);

    const scored = videos.map(video => {
        // Calculate text score
        const textScoreResult = calculateTextScore(query, video.metadata || video, blockAnalysis);

        // Calculate hybrid score (visualAnalysis may or may not exist)
        const hybridResult = calculateHybridScore(
            textScoreResult,
            video.visualAnalysis,
            blockAnalysis
        );

        return {
            ...video,
            textScoreResult,
            hybridResult,
            finalScore: hybridResult.finalScore
        };
    });

    // Sort by final score descending
    scored.sort((a, b) => b.finalScore - a.finalScore);

    // Log top results
    console.log("[HybridScorer] Top 3 results:");
    scored.slice(0, 3).forEach((v, i) => {
        console.log(`  ${i + 1}. Score: ${v.finalScore} | Text: ${v.textScoreResult.score} | Visual: ${v.hybridResult.visualScore ?? 'N/A'} | "${(v.metadata?.title || v.title || '').substring(0, 40)}..."`);
    });

    return scored;
}

/**
 * Filter videos by minimum score threshold
 * @param {Array} rankedVideos - Result from rankVideos
 * @param {number} minScore - Minimum score threshold (default: 40)
 * @returns {Array} Filtered videos
 */
export function filterByThreshold(rankedVideos, minScore = 40) {
    const filtered = rankedVideos.filter(v => v.finalScore >= minScore);
    console.log(`[HybridScorer] ${filtered.length}/${rankedVideos.length} videos passed threshold of ${minScore}`);
    return filtered;
}

/**
 * Get the best video that passes all criteria
 * @param {Array} rankedVideos - Result from rankVideos
 * @param {Object} blockAnalysis - Block analysis
 * @param {Object} options - Options including minScore
 * @returns {Object|null} Best video or null
 */
export function getBestVideo(rankedVideos, blockAnalysis, options = {}) {
    const minScore = options.minScore || 40;
    const requirePersonMatch = options.requirePersonMatch || false;

    for (const video of rankedVideos) {
        // Check minimum score
        if (video.finalScore < minScore) {
            continue;
        }

        // If we need a person and visual says no person, skip
        if (requirePersonMatch &&
            blockAnalysis.block_type === 'PERSONA_HABLANDO' &&
            video.hybridResult.personMatch === 'UNLIKELY') {
            continue;
        }

        // Check if visual analysis rejects with high confidence
        if (video.visualAnalysis?.recommendation === 'REJECT' &&
            video.visualAnalysis?.confidence >= 0.8) {
            continue;
        }

        // This video passes all criteria
        console.log(`[HybridScorer] Best video selected: Score ${video.finalScore} - "${(video.metadata?.title || video.title || '').substring(0, 50)}"`);
        return video;
    }

    console.log("[HybridScorer] No video passed all criteria");
    return null;
}

export default {
    calculateTextScore,
    calculateHybridScore,
    rankVideos,
    filterByThreshold,
    getBestVideo,
    PRIORITY_KEYWORDS,
    NEGATIVE_KEYWORDS
};
