
// Central API Configuration
// In Vercel, set VITE_API_URL to your Railway URL (e.g. https://click-sync-production.up.railway.app)
// In Local, it falls back to http://localhost:5000

export const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';
