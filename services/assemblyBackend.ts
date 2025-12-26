import { supabase } from './supabaseClient';

const API_URL = "/api/transcribe";

export interface AssemblyWord {
    text: string;
    start: number;
    end: number;
    confidence: number;
}

export interface AssemblyResponse {
    text: string;
    words: AssemblyWord[];
}

export const transcribeWithAssembly = async (file: File): Promise<AssemblyResponse> => {

    // 1. Check if Supabase is configured (Production/Vercel Mode)
    if (supabase) {
        try {
            console.log("Uploading to Supabase...");
            // A. Upload to Supabase
            // Sanitize filename
            const timestamp = Date.now();
            const safeName = file.name.replace(/[^a-z0-9.]/gi, '_');
            const filename = `upload-${timestamp}-${safeName}`;

            const { data, error } = await supabase.storage
                .from('audio-uploads')
                .upload(filename, file);

            if (error) throw new Error(`Upload Failed: ${error.message}`);

            // B. Get Public URL
            const { data: { publicUrl } } = supabase.storage
                .from('audio-uploads')
                .getPublicUrl(filename);

            console.log("File uploaded, sending to Vercel API:", publicUrl);

            // C. Call Vercel API with URL
            const response = await fetch('/api/transcribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ audioUrl: publicUrl })
            });

            if (!response.ok) {
                const errData = await response.json().catch(() => ({}));
                throw new Error(errData.error || 'Transcription failed');
            }

            return await response.json();

        } catch (err) {
            console.error("Cloud processing failed, falling back to local if possible", err);
            // If cloud fails, fall through to local
        }
    }

    // 2. Local Fallback (Only allowed on localhost)
    const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

    if (!isLocalhost) {
        throw new Error('Supabase configuration missing or Cloud upload failed. Check Vercel Environment Variables.');
    }

    console.log("Using Local Proxy...");
    const formData = new FormData();
    formData.append('audio', file);

    const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
    });

    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to connect to transcription service');
    }

    return await response.json();
};
