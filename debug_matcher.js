
import { matchVideosToScript, generateScriptContext } from './services/videoMatcher.js';

async function test() {
    console.log("Starting Matcher Test...");
    try {
        const script = "[ON SCREEN: Test Block]\nText content here.";
        const context = await generateScriptContext(script);
        console.log("Context:", context);

        const results = await matchVideosToScript(script);
        console.log("Results:", results);
    } catch (e) {
        console.error("CRASH DETECTED:");
        console.error(e);
    }
}

test();
