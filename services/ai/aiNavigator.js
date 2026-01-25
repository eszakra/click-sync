import { GoogleGenerativeAI } from '@google/generative-ai';
import config from '../../config.js';

class AIVisionNavigator {
    constructor() {
        this.genAI = new GoogleGenerativeAI(config.gemini.apiKey);
        this.model = this.genAI.getGenerativeModel({ model: config.gemini.model });
    }

    /**
     * Converts a Playwright Screenshot Buffer to Gemini inline data
     */
    bufferToGenerativePart(buffer, mimeType) {
        return {
            inlineData: {
                data: buffer.toString("base64"),
                mimeType
            }
        };
    }

    async decideAction(screenshot, goal, context) {
        const prompt = `
            You are an expert web automation agent. You are looking at a screenshot of a video stock website (Viory.video).
            
            GOAL: ${goal}
            CONTEXT: ${context}

            Analyze the image and decide the next best action.

            Possible Actions:
            - "click": If you see a button/link/video that helps achieve the goal. Provide x,y coordinates (0-100%).
            - "type": If there is a search box.
            - "scroll": If you need to see more results (e.g., "scroll_down").
            - "wait": If the page is loading.
            - "login_needed": If you see a login wall.
            - "goal_complete": If the goal is achieved (e.g. video found and metadata extracted).
            - "find_alternative": If current video is processed/unavailable ("My Content").

            Return ONLY valid JSON:
            {
                "analysis": "Brief description of what you see",
                "action": "click" | "type" | "scroll" | "wait" | "login_needed" | "goal_complete",
                "target_position_percent": { "x": 50, "y": 50 }, // For clicks
                "text_to_type": "string", // For type
                "confidence": 0.0-1.0,
                "reasoning": "Why this action?"
            }
        `;

        try {
            const imagePart = this.bufferToGenerativePart(screenshot, "image/png");

            // Generate content
            const result = await this.model.generateContent([prompt, imagePart]);
            const response = await result.response;
            const text = response.text();

            // Clean markdown if present
            const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanText);

        } catch (error) {
            console.error('[AI Navigator] Error deciding action:', error);
            // Fail safe action
            return { action: 'wait', reasoning: 'AI Error', confidence: 0 };
        }
    }

    /**
     * Specific analysis for search results to pick the best video
     */
    async analyzeSearchResults(screenshot, query) {
        const prompt = `
            Analyze these video search results for query: "${query}".
            Find the SINGLE best video match.
            
            CRITERIA:
            1. Title relevance (exact match > partial match).
            2. Visual relevance (thumbnail).
            3. Recent date preferred.
            4. Duration > 10s.

            Return JSON:
            {
                "best_match": {
                    "exists": true/false,
                    "title": "Visible title",
                    "position_percent": { "x": 50, "y": 50 },
                    "reasoning": "..."
                }
            }
        `;

        // Implementation similar to decideAction
        // ...
        try {
            const imagePart = this.bufferToGenerativePart(screenshot, "image/png");
            const result = await this.model.generateContent([prompt, imagePart]);
            const cleanText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanText);
        } catch (e) {
            return { best_match: { exists: false } };
        }
    }

    async analyzeVideoPage(screenshot) {
        const prompt = `
            Analyze this video player page.
            Check for "Download" button and availability.
            Check if "Processing" or "My Content" message is visible (which means unavailable).
            
            Return JSON:
            {
                "download_button": { "visible": true, "position_percent": { "x": 0, "y": 0 } },
                "is_processing": true/false,
                "is_unavailable": true/false
            }
        `;
        // ... execution
        try {
            const imagePart = this.bufferToGenerativePart(screenshot, "image/png");
            const result = await this.model.generateContent([prompt, imagePart]);
            const cleanText = result.response.text().replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(cleanText);
        } catch (e) {
            return { download_button: { visible: false } };
        }
    }
}

export default new AIVisionNavigator();
