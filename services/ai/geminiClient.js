// geminiClient.js - Singleton client for Gemini API with Vision support
// Handles API key management, rate limiting, and error recovery

import { GoogleGenerativeAI } from '@google/generative-ai';
import fs from 'fs';
import path from 'path';
import os from 'os';
import config from '../../config.js';

// Default API Key (fallback) - also available in config.js
const DEFAULT_KEY = config?.gemini?.apiKey || "AIzaSyC0QCO0_h3jb6l2rDV738Rv8hAvf6_5atk";

// Model to use - gemini-2.0-flash has vision support and is fast
const DEFAULT_MODEL = config?.gemini?.model || "gemini-2.0-flash";

// Rate limiting configuration
const RATE_LIMIT = {
    requestsPerMinute: 15,
    minDelayBetweenRequests: 4000, // 4 seconds minimum between requests
    retryDelayBase: 5000,          // Base delay for retries
    maxRetries: 3
};

class GeminiClient {
    constructor() {
        this.genAI = null;
        this.model = null;
        this.lastRequestTime = 0;
        this.requestCount = 0;
        this.requestCountResetTime = Date.now();
        this.apiKeySource = 'default';
    }

    /**
     * Get API key from config or use default
     */
    getApiKey() {
        try {
            // Try user config first
            const configPath = path.join(os.homedir(), '.clicksync', 'config.json');
            if (fs.existsSync(configPath)) {
                const data = JSON.parse(fs.readFileSync(configPath, 'utf8'));
                if (data.geminiKey && data.geminiKey.trim().length > 10) {
                    console.log("[GeminiClient] Using custom API Key from user config");
                    this.apiKeySource = 'user_config';
                    return data.geminiKey.trim();
                }
            }

            // Try environment variable
            if (process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 10) {
                console.log("[GeminiClient] Using API Key from environment");
                this.apiKeySource = 'environment';
                return process.env.GEMINI_API_KEY;
            }
        } catch (e) {
            console.error("[GeminiClient] Failed to load custom config:", e.message);
        }

        console.log("[GeminiClient] Using default API Key");
        this.apiKeySource = 'default';
        return DEFAULT_KEY;
    }

    /**
     * Initialize or reinitialize the client
     */
    init() {
        const apiKey = this.getApiKey();
        this.genAI = new GoogleGenerativeAI(apiKey);
        // Use gemini-2.0-flash for vision capabilities (faster and cheaper than pro)
        this.model = this.genAI.getGenerativeModel({ model: DEFAULT_MODEL });
        console.log(`[GeminiClient] Initialized with model: ${DEFAULT_MODEL}`);
        return this;
    }

    /**
     * Ensure client is initialized
     */
    ensureInitialized() {
        if (!this.genAI || !this.model) {
            this.init();
        }
        return this;
    }

    /**
     * Rate limiting: wait if necessary
     */
    async waitForRateLimit() {
        const now = Date.now();

        // Reset counter every minute
        if (now - this.requestCountResetTime > 60000) {
            this.requestCount = 0;
            this.requestCountResetTime = now;
        }

        // Check if we've hit the rate limit
        if (this.requestCount >= RATE_LIMIT.requestsPerMinute) {
            const waitTime = 60000 - (now - this.requestCountResetTime);
            console.log(`[GeminiClient] Rate limit reached, waiting ${Math.ceil(waitTime / 1000)}s...`);
            await new Promise(r => setTimeout(r, waitTime + 1000));
            this.requestCount = 0;
            this.requestCountResetTime = Date.now();
        }

        // Ensure minimum delay between requests
        const timeSinceLastRequest = now - this.lastRequestTime;
        if (timeSinceLastRequest < RATE_LIMIT.minDelayBetweenRequests) {
            const delay = RATE_LIMIT.minDelayBetweenRequests - timeSinceLastRequest;
            await new Promise(r => setTimeout(r, delay));
        }

        this.lastRequestTime = Date.now();
        this.requestCount++;
    }

    /**
     * Generate content with automatic retry and error handling
     * @param {string|Array} prompt - Text prompt or array with image data
     * @param {Object} options - Additional options
     */
    async generateContent(prompt, options = {}) {
        this.ensureInitialized();

        const maxRetries = options.maxRetries || RATE_LIMIT.maxRetries;
        let lastError = null;

        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            try {
                await this.waitForRateLimit();

                console.log(`[GeminiClient] Request attempt ${attempt}/${maxRetries}`);
                const result = await this.model.generateContent(prompt);
                const response = result.response;
                const text = response.text();

                return {
                    success: true,
                    text: text,
                    attempt: attempt
                };

            } catch (error) {
                lastError = error;
                console.error(`[GeminiClient] Attempt ${attempt} failed:`, error.message);

                // Check for specific error types
                if (error.message.includes('quota') || error.message.includes('429')) {
                    // Quota exceeded - wait longer
                    const waitTime = RATE_LIMIT.retryDelayBase * Math.pow(2, attempt);
                    console.log(`[GeminiClient] Quota exceeded, waiting ${waitTime / 1000}s...`);
                    await new Promise(r => setTimeout(r, waitTime));
                } else if (error.message.includes('API key')) {
                    // Invalid API key - don't retry
                    return {
                        success: false,
                        error: 'INVALID_API_KEY',
                        message: 'La API key de Gemini es invalida. Por favor configura una key valida en Settings.',
                        attempt: attempt
                    };
                } else if (error.message.includes('blocked') || error.message.includes('safety')) {
                    // Content blocked - don't retry
                    return {
                        success: false,
                        error: 'CONTENT_BLOCKED',
                        message: 'El contenido fue bloqueado por los filtros de seguridad.',
                        attempt: attempt
                    };
                } else if (attempt < maxRetries) {
                    // Generic error - wait and retry
                    const waitTime = RATE_LIMIT.retryDelayBase * attempt;
                    console.log(`[GeminiClient] Retrying in ${waitTime / 1000}s...`);
                    await new Promise(r => setTimeout(r, waitTime));
                }
            }
        }

        // All retries exhausted
        return {
            success: false,
            error: 'MAX_RETRIES_EXCEEDED',
            message: `Error despues de ${maxRetries} intentos: ${lastError?.message || 'Unknown error'}`,
            originalError: lastError
        };
    }

    /**
     * Generate content with image (Vision)
     * @param {Buffer|string} imageData - Image buffer or base64 string
     * @param {string} prompt - Text prompt to analyze the image
     * @param {string} mimeType - Image MIME type (default: image/png)
     */
    async analyzeImage(imageData, prompt, mimeType = 'image/png') {
        // Convert buffer to base64 if needed
        const base64Data = Buffer.isBuffer(imageData)
            ? imageData.toString('base64')
            : imageData;

        const content = [
            {
                inlineData: {
                    mimeType: mimeType,
                    data: base64Data
                }
            },
            prompt
        ];

        return await this.generateContent(content);
    }

    /**
     * Analyze multiple images at once
     * @param {Array} images - Array of {data, mimeType} objects
     * @param {string} prompt - Text prompt
     */
    async analyzeMultipleImages(images, prompt) {
        const content = images.map(img => ({
            inlineData: {
                mimeType: img.mimeType || 'image/png',
                data: Buffer.isBuffer(img.data) ? img.data.toString('base64') : img.data
            }
        }));

        content.push(prompt);
        return await this.generateContent(content);
    }

    /**
     * Get client status
     */
    getStatus() {
        return {
            initialized: !!this.model,
            apiKeySource: this.apiKeySource,
            requestCount: this.requestCount,
            lastRequestTime: this.lastRequestTime
        };
    }

    /**
     * Force reinitialization (e.g., after API key change)
     */
    reinitialize() {
        this.genAI = null;
        this.model = null;
        return this.init();
    }
}

// Singleton instance
const geminiClient = new GeminiClient();

export default geminiClient;
export { GeminiClient, RATE_LIMIT };
