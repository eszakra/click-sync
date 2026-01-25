// scriptAnalyzer.js - Analyzes script to extract global context and entities
// Uses Gemini to understand the overall theme, people, places, and visual cues

import geminiClient from './geminiClient.js';

/**
 * Analyze the entire script to extract global context
 * This helps generate better queries and validate results
 * @param {string} script - The full script text
 * @returns {Object} Global context object
 */
export async function analyzeGlobalContext(script) {
    console.log("[ScriptAnalyzer] Analyzing global context...");

    const prompt = `Eres un analista de noticias experto. Analiza este guion de noticias y extrae informacion clave.

GUION:
"${script.substring(0, 12000)}"

EXTRAE Y RESPONDE EN JSON:
{
  "theme": "palabra clave del tema principal (Politics, War, Economy, Diplomacy, Sports, etc.)",
  "main_people": ["lista de nombres COMPLETOS de personas mencionadas, maximo 10"],
  "main_places": ["lista de paises/ciudades mencionadas, maximo 5"],
  "main_organizations": ["lista de organizaciones/instituciones mencionadas, maximo 5"],
  "visual_cues": ["lista de elementos visuales esperados como: White House, podium, flags, military, etc."],
  "tone": "formal/informal/urgent/dramatic",
  "summary_es": "resumen de 1 linea en espanol"
}

IMPORTANTE: Solo responde con el JSON, sin texto adicional.`;

    try {
        const result = await geminiClient.generateContent(prompt);

        if (!result.success) {
            console.error("[ScriptAnalyzer] API Error:", result.message);
            return getDefaultContext();
        }

        // Parse JSON response
        const jsonText = result.text.replace(/```json\n?|```/g, '').trim();
        const context = JSON.parse(jsonText);

        console.log("[ScriptAnalyzer] Global context extracted:", {
            theme: context.theme,
            people: context.main_people?.length || 0,
            places: context.main_places?.length || 0
        });

        return context;

    } catch (error) {
        console.error("[ScriptAnalyzer] Failed to analyze context:", error.message);
        return getDefaultContext();
    }
}

/**
 * Parse script into blocks based on [ON SCREEN: ...] markers
 * @param {string} script - The full script text
 * @returns {Array} Array of block objects
 */
export function parseScriptBlocks(script) {
    const blocks = [];
    const cleanScript = script.replace(/\r\n/g, '\n');

    // Match various ON SCREEN formats
    const markerRegex = /\[ON\s*SCREEN[:\s-]*([^\]]+)\]/gi;
    const matches = Array.from(cleanScript.matchAll(markerRegex));

    if (matches.length === 0) {
        console.log("[ScriptAnalyzer] No [ON SCREEN] markers found, treating as single block");
        return [{
            index: 0,
            headline: "News Content",
            text: cleanScript.trim(),
            startPos: 0,
            endPos: cleanScript.length
        }];
    }

    for (let i = 0; i < matches.length; i++) {
        const currentMatch = matches[i];
        const headline = currentMatch[1].trim();
        const textStart = currentMatch.index + currentMatch[0].length;
        const textEnd = (i < matches.length - 1) ? matches[i + 1].index : cleanScript.length;
        const text = cleanScript.substring(textStart, textEnd).trim();

        blocks.push({
            index: i,
            headline: headline,
            text: text,
            startPos: currentMatch.index,
            endPos: textEnd
        });
    }

    console.log(`[ScriptAnalyzer] Parsed ${blocks.length} blocks from script`);
    return blocks;
}

/**
 * Analyze a single block to determine content type and entities
 * @param {Object} block - Block object with headline and text
 * @param {Object} globalContext - Global context from analyzeGlobalContext
 * @param {Object} previousBlock - Previous block's analysis for continuity
 * @returns {Object} Block analysis
 */
export async function analyzeBlock(block, globalContext, previousBlock = null) {
    console.log(`[ScriptAnalyzer] Analyzing block ${block.index}: "${block.headline.substring(0, 50)}..."`);

    // Build continuity context
    let continuitySection = '';
    if (previousBlock && previousBlock.main_person) {
        continuitySection = `
CONTEXTO DEL BLOQUE ANTERIOR (para continuidad):
- Persona principal anterior: "${previousBlock.main_person}"
- Persona secundaria: "${previousBlock.secondary_person || 'ninguna'}"
- Tema: "${previousBlock.topic || 'N/A'}"

REGLA DE CONTINUIDAD: Si este bloque es una CONTINUACION de la historia anterior (mismas personas, mismo evento), usa las MISMAS entidades principales.`;
    }

    const prompt = `Eres un experto en busqueda de videos de noticias. Analiza este bloque y genera busquedas INTELIGENTES.

BLOQUE #${block.index + 1}:
Titular: "${block.headline}"
Texto: "${block.text.substring(0, 1500)}"

CONTEXTO GLOBAL:
- Tema: ${globalContext.theme || 'News'}
- Personas principales del guion: ${(globalContext.main_people || []).join(', ')}
- Lugares: ${(globalContext.main_places || []).join(', ')}
${continuitySection}

DETERMINA EL TIPO DE CONTENIDO:
1. PERSONA_HABLANDO - Una persona dando declaraciones, discurso, conferencia
2. MULTI_PERSONA - Dos o mas personas en reunion, cumbre, entrevista
3. FOOTAGE_EVENTO - Imagenes de un evento (explosion, protesta, desastre)
4. FOOTAGE_LUGAR - Tomas de un lugar (ciudad, edificio, pais)
5. INSTITUCION - Contenido sobre una organizacion (ONU, NATO, gobierno)
6. GENERICO - Contenido general sin persona especifica

GENERA QUERIES DE BUSQUEDA (6-8 queries, de mas especifico a mas general):
- Si hay DOS personas mencionadas: "PersonaA PersonaB" juntas primero
- Si hay UNA persona: "Nombre Completo" + accion (speech, conference, etc.)
- Si hay un CARGO sin nombre (ej: "el presidente", "el ministro"): "titulo + pais" (ej: "Russian President", "Chinese Minister")
- Incluye variantes con ACCIONES: speech, press conference, meeting, announcement
- Incluye variantes con LUGARES
- Query generico de respaldo al final

DESCRIBE QUE BUSCAR VISUALMENTE:
- Que DEBE aparecer en el video
- Que seria PREFERIBLE ver
- Que EVITAR (graficos solo texto, persona incorrecta)

RESPONDE SOLO JSON:
{
  "block_type": "PERSONA_HABLANDO|MULTI_PERSONA|FOOTAGE_EVENTO|FOOTAGE_LUGAR|INSTITUCION|GENERICO",
  "main_person": "Nombre completo o null",
  "secondary_person": "Nombre completo o null",
  "topic": "tema principal en 2-3 palabras",
  "institution": "organizacion o null",
  "location": "lugar principal o null",
  "is_continuation": true/false,
  "queries": [
    "query 1 mas especifico",
    "query 2",
    "query 3",
    "query 4",
    "query 5",
    "query 6 mas general"
  ],
  "visual_targets": {
    "must_show": ["que DEBE aparecer"],
    "preferred": ["que seria bueno ver"],
    "avoid": ["que evitar"]
  },
  "search_priority": "PERSON|EVENT|PLACE|INSTITUTION"
}`;

    try {
        const result = await geminiClient.generateContent(prompt);

        if (!result.success) {
            console.error(`[ScriptAnalyzer] Block ${block.index} API Error:`, result.message);
            return getDefaultBlockAnalysis(block, globalContext);
        }

        const jsonText = result.text.replace(/```json\n?|```/g, '').trim();
        const analysis = JSON.parse(jsonText);

        console.log(`[ScriptAnalyzer] Block ${block.index} analyzed:`, {
            type: analysis.block_type,
            person: analysis.main_person,
            queries: analysis.queries?.length || 0
        });

        return analysis;

    } catch (error) {
        console.error(`[ScriptAnalyzer] Block ${block.index} analysis failed:`, error.message);
        return getDefaultBlockAnalysis(block, globalContext);
    }
}

/**
 * Generate a professional summary of the script context in Spanish
 * @param {string} script - The full script
 * @returns {string} Summary in Spanish
 */
export async function generateScriptSummary(script) {
    const prompt = `Actua como un editor de noticias experto. Analiza este guion y genera un RESUMEN EJECUTIVO MUY BREVE (maximo 2 frases) en ESPANOL que explique el contexto general y los protagonistas principales.

Guion: "${script.substring(0, 8000)}"

RESUMEN EN ESPANOL (2 frases maximo):`;

    try {
        const result = await geminiClient.generateContent(prompt);

        if (!result.success) {
            const context = await analyzeGlobalContext(script);
            return `Reportaje sobre ${context.theme}. Protagonistas: ${(context.main_people || []).slice(0, 3).join(', ')}.`;
        }

        return result.text.trim();

    } catch (error) {
        console.error("[ScriptAnalyzer] Summary generation failed:", error.message);
        return "Contenido de noticias.";
    }
}

/**
 * Default context when API fails
 */
function getDefaultContext() {
    return {
        theme: "News",
        main_people: [],
        main_places: [],
        main_organizations: [],
        visual_cues: ["news footage", "people", "buildings"],
        tone: "formal",
        summary_es: "Contenido de noticias"
    };
}

/**
 * Default block analysis when API fails
 */
function getDefaultBlockAnalysis(block, globalContext) {
    // Extract words from headline for basic queries
    const headlineWords = block.headline.split(/\s+/).filter(w => w.length > 3);
    const queries = [
        block.headline,
        headlineWords.slice(0, 3).join(' '),
        headlineWords[0] || 'news',
        globalContext.theme || 'news footage'
    ];

    return {
        block_type: "GENERICO",
        main_person: null,
        secondary_person: null,
        topic: headlineWords.slice(0, 2).join(' '),
        institution: null,
        location: null,
        is_continuation: false,
        queries: queries,
        visual_targets: {
            must_show: ["relevant footage"],
            preferred: ["people", "action"],
            avoid: ["unrelated content"]
        },
        search_priority: "EVENT"
    };
}

export default {
    analyzeGlobalContext,
    parseScriptBlocks,
    analyzeBlock,
    generateScriptSummary
};
