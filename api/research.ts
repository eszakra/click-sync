import type { VercelRequest, VercelResponse } from '@vercel/node';
import { reSearchBlock } from '../services/videoMatcher.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { block, customQuery } = req.body;

    if (!block) {
        return res.status(400).json({ error: 'Block data is required' });
    }

    try {
        console.log(`[API] Re-searching block ${block.index}...`);
        const result = await reSearchBlock(block, customQuery);

        res.json({
            success: true,
            block: result
        });

    } catch (error: any) {
        console.error('[API] Re-search error:', error);
        res.status(500).json({ error: error.message });
    }
}
