import { supabase } from './supabaseClient';
import { API_BASE_URL } from './config';

const API_URL = API_BASE_URL;

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
    // Unified Pipeline: Always send to Railway Backend
    // This works for both Local (localhost:5000) and Prod (Railway URL)
    console.log(`Uploading to Backend: ${API_URL}/transcribe`);

    const formData = new FormData();
    formData.append('audio', file);

    try {
        const response = await fetch(`${API_URL}/transcribe`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.error || 'Transcription failed on server');
        }

        return await response.json();
    } catch (error: any) {
        console.error("Transcription Error:", error);
        throw new Error(error.message || "Failed to connect to backend");
    }
};
