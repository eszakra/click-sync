
import { generateScriptContext } from '../services/videoMatcher.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { script } = req.body;

    if (!script) {
        return res.status(400).json({ error: 'Script is required' });
    }

    try {
        console.log('[API] Generating Context...');
        const context = await generateScriptContext(script);

        // We return empty blocks because the client fetches them individually via /research
        res.status(200).json({
            success: true,
            context: context,
            blocks: []
        });

    } catch (error) {
        console.error('[API] Context generation error:', error);
        res.status(500).json({ error: error.message });
    }
}
