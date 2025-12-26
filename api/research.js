
import { reSearchBlock } from '../services/videoMatcher.js';

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { block, customQuery } = req.body;

    if (!block) {
        return res.status(400).json({ error: 'Block data is required' });
    }

    try {
        console.log(`[API] Researching block ${block.index}...`);

        const result = await reSearchBlock(block, customQuery);

        res.status(200).json({
            success: true,
            block: result
        });

    } catch (error) {
        console.error('[API] Research error:', error);
        res.status(500).json({ error: error.message });
    }
}
