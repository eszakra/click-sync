// visualValidator.js - Visual validation using Gemini Vision
// Analyzes video thumbnails/screenshots to verify content relevance

import geminiClient from './geminiClient.js';

/**
 * Analyze a video thumbnail/screenshot to determine if it matches the target
 * @param {Buffer|string} imageData - Image buffer or base64 string
 * @param {Object} targetAnalysis - Block analysis with visual_targets
 * @param {Object} textMetadata - Text metadata from the video (title, description, etc.)
 * @returns {Object} Visual analysis result
 */
export async function analyzeVideoThumbnail(imageData, targetAnalysis, textMetadata = {}) {
    console.log("[VisualValidator] Analyzing thumbnail...");

    const visualTargets = targetAnalysis.visual_targets || {};
    const mustShow = visualTargets.must_show || [];
    const preferred = visualTargets.preferred || [];
    const avoid = visualTargets.avoid || [];

    const prompt = `Eres un analista visual experto. Analiza esta imagen de un video de noticias.

ESTOY BUSCANDO:
- Tipo de contenido: ${targetAnalysis.block_type || 'NEWS'}
- Persona principal: ${targetAnalysis.main_person || 'No especificada'}
- Persona secundaria: ${targetAnalysis.secondary_person || 'Ninguna'}
- Tema: ${targetAnalysis.topic || 'Noticias'}
- Lugar: ${targetAnalysis.location || 'No especificado'}

ELEMENTOS QUE DEBE MOSTRAR:
${mustShow.map(m => `- ${m}`).join('\n') || '- Contenido relevante'}

ELEMENTOS PREFERIDOS:
${preferred.map(p => `- ${p}`).join('\n') || '- N/A'}

ELEMENTOS A EVITAR:
${avoid.map(a => `- ${a}`).join('\n') || '- Contenido no relacionado'}

METADATOS DEL VIDEO:
- Titulo: ${textMetadata.title || 'N/A'}
- Descripcion: ${(textMetadata.description || '').substring(0, 300)}

ANALIZA LA IMAGEN Y RESPONDE EN JSON:
{
  "visual_match": true/false,
  "confidence": 0.0-1.0,
  "detected_elements": ["lista de elementos visibles en la imagen"],
  "detected_people": ["descripcion de personas visibles, ej: 'hombre en podio', 'mujer con microfono'"],
  "person_match": "CONFIRMED|LIKELY|UNLIKELY|NO_PERSON",
  "scene_type": "SPEECH|MEETING|EVENT|LOCATION|GRAPHICS|OTHER",
  "is_real_footage": true/false,
  "issues": ["lista de problemas, ej: 'solo graficos', 'persona incorrecta'"],
  "recommendation": "ACCEPT|REVIEW|REJECT",
  "relevance_score": 0-100,
  "explanation_es": "explicacion breve en espanol de por que aceptar o rechazar"
}

CRITERIOS DE EVALUACION:
- ACCEPT (70-100): Claramente muestra el contenido buscado
- REVIEW (40-69): Podria ser relevante pero no es claro
- REJECT (0-39): No muestra el contenido buscado o es solo graficos/texto

IMPORTANTE: Solo responde con el JSON, sin texto adicional.`;

    try {
        const result = await geminiClient.analyzeImage(imageData, prompt);

        if (!result.success) {
            console.error("[VisualValidator] API Error:", result.message);
            return getDefaultVisualAnalysis(result.error);
        }

        const jsonText = result.text.replace(/```json\n?|```/g, '').trim();
        const analysis = JSON.parse(jsonText);

        console.log("[VisualValidator] Analysis complete:", {
            match: analysis.visual_match,
            confidence: analysis.confidence,
            recommendation: analysis.recommendation,
            score: analysis.relevance_score
        });

        return {
            success: true,
            ...analysis
        };

    } catch (error) {
        console.error("[VisualValidator] Analysis failed:", error.message);
        return getDefaultVisualAnalysis('PARSE_ERROR');
    }
}

/**
 * Analyze multiple video thumbnails and rank them
 * @param {Array} videos - Array of {imageData, metadata} objects
 * @param {Object} targetAnalysis - Block analysis
 * @returns {Array} Ranked videos with visual scores
 */
export async function rankVideosByVisual(videos, targetAnalysis) {
    console.log(`[VisualValidator] Ranking ${videos.length} videos visually...`);

    const results = [];

    for (let i = 0; i < videos.length; i++) {
        const video = videos[i];

        if (!video.imageData) {
            console.log(`[VisualValidator] Video ${i} has no image data, skipping visual analysis`);
            results.push({
                ...video,
                visualAnalysis: getDefaultVisualAnalysis('NO_IMAGE'),
                visualScore: 30 // Default middle score
            });
            continue;
        }

        try {
            const analysis = await analyzeVideoThumbnail(
                video.imageData,
                targetAnalysis,
                video.metadata || {}
            );

            results.push({
                ...video,
                visualAnalysis: analysis,
                visualScore: analysis.relevance_score || 0
            });

            // Small delay between analyses to avoid rate limiting
            if (i < videos.length - 1) {
                await new Promise(r => setTimeout(r, 1000));
            }

        } catch (error) {
            console.error(`[VisualValidator] Error analyzing video ${i}:`, error.message);
            results.push({
                ...video,
                visualAnalysis: getDefaultVisualAnalysis('ERROR'),
                visualScore: 20
            });
        }
    }

    // Sort by visual score descending
    results.sort((a, b) => b.visualScore - a.visualScore);

    console.log("[VisualValidator] Ranking complete. Top scores:",
        results.slice(0, 3).map(r => r.visualScore));

    return results;
}

/**
 * Quick check if an image shows a real person vs graphics
 * @param {Buffer|string} imageData - Image data
 * @returns {Object} Quick analysis result
 */
export async function quickPersonCheck(imageData) {
    const prompt = `Analiza esta imagen rapidamente.

RESPONDE SOLO JSON:
{
  "has_real_person": true/false,
  "person_description": "descripcion breve o null",
  "is_graphics_only": true/false,
  "scene_type": "PERSON_SPEAKING|MEETING|EVENT|GRAPHICS|LOCATION|OTHER"
}`;

    try {
        const result = await geminiClient.analyzeImage(imageData, prompt);

        if (!result.success) {
            return { has_real_person: null, is_graphics_only: null, error: result.error };
        }

        const jsonText = result.text.replace(/```json\n?|```/g, '').trim();
        return JSON.parse(jsonText);

    } catch (error) {
        return { has_real_person: null, is_graphics_only: null, error: error.message };
    }
}

/**
 * Compare two images to see if they show the same person/scene
 * @param {Buffer|string} image1 - First image
 * @param {Buffer|string} image2 - Second image
 * @returns {Object} Comparison result
 */
export async function compareImages(image1, image2) {
    const prompt = `Compara estas dos imagenes de videos de noticias.

RESPONDE SOLO JSON:
{
  "same_person": true/false/null,
  "same_event": true/false,
  "similarity_score": 0-100,
  "differences": ["lista de diferencias principales"]
}`;

    try {
        const result = await geminiClient.analyzeMultipleImages(
            [{ data: image1 }, { data: image2 }],
            prompt
        );

        if (!result.success) {
            return { same_person: null, same_event: null, error: result.error };
        }

        const jsonText = result.text.replace(/```json\n?|```/g, '').trim();
        return JSON.parse(jsonText);

    } catch (error) {
        return { same_person: null, same_event: null, error: error.message };
    }
}

/**
 * Validate if video content type matches what we need
 * @param {string} blockType - Expected block type (PERSONA_HABLANDO, FOOTAGE_EVENTO, etc.)
 * @param {Object} visualAnalysis - Visual analysis from analyzeVideoThumbnail
 * @returns {boolean} Whether the content type matches
 */
export function validateContentType(blockType, visualAnalysis) {
    if (!visualAnalysis || !visualAnalysis.scene_type) return true; // Can't validate

    const sceneType = visualAnalysis.scene_type;

    switch (blockType) {
        case 'PERSONA_HABLANDO':
            return sceneType === 'SPEECH' || sceneType === 'MEETING';

        case 'MULTI_PERSONA':
            return sceneType === 'MEETING' || sceneType === 'SPEECH';

        case 'FOOTAGE_EVENTO':
            return sceneType === 'EVENT' || sceneType === 'LOCATION';

        case 'FOOTAGE_LUGAR':
            return sceneType === 'LOCATION' || sceneType === 'EVENT';

        case 'INSTITUCION':
            return sceneType !== 'GRAPHICS'; // Accept most except pure graphics

        case 'GENERICO':
            return true; // Accept anything

        default:
            return true;
    }
}

/**
 * Default visual analysis when API fails
 */
function getDefaultVisualAnalysis(errorType = 'UNKNOWN') {
    return {
        success: false,
        error: errorType,
        visual_match: null,
        confidence: 0,
        detected_elements: [],
        detected_people: [],
        person_match: 'UNKNOWN',
        scene_type: 'UNKNOWN',
        is_real_footage: null,
        issues: [`API error: ${errorType}`],
        recommendation: 'REVIEW',
        relevance_score: 30, // Middle score for fallback
        explanation_es: 'No se pudo analizar visualmente, usando solo texto'
    };
}

export default {
    analyzeVideoThumbnail,
    rankVideosByVisual,
    quickPersonCheck,
    compareImages,
    validateContentType
};
