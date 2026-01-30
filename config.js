import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = {
    gemini: {
        apiKey: process.env.GEMINI_API_KEY || "AIzaSyC0QCO0_h3jb6l2rDV738Rv8hAvf6_5atk", // Default key
model: "gemini-3-flash-preview", // Fast model with vision support
        modelPro: "gemini-3-flash-preview", // Pro model for complex analysis
        maxRetries: 3,
        rateLimitPerMinute: 15
    },
    viory: {
        baseUrl: "https://www.viory.video",
        searchUrl: "https://www.viory.video/en/videos",
        myContentUrl: "https://www.viory.video/en/my-content"
    },
    paths: {
        root: __dirname,
        downloads: path.join(os.homedir(), 'ClickStudio', 'Downloads'),
        session: path.join(os.homedir(), '.clickstudio', 'viory-session'),
        inputAudio: path.join(os.homedir(), 'ClickStudio', 'Input'),
        outputVideo: path.join(os.homedir(), 'ClickStudio', 'Output'),
        temp: path.join(os.homedir(), 'ClickStudio', 'Temp'),
        cache: path.join(os.homedir(), '.clickstudio', 'cache')
    },
    ai: {
        maxNavigationAttempts: 15,
        screenshotDelay: 1000, // Increased delay for stability
        confidenceThreshold: 0.7
    },
    editor: {
        resolution: '1920x1080',
        fps: 30,
        tempDir: path.join(os.homedir(), 'ClickStudio', 'Temp')
    }
};

export default config;
