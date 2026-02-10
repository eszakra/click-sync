
// Central API Configuration
// In Vercel, set VITE_API_URL to your Railway URL (e.g. https://click-sync-production.up.railway.app)
// In Local, it falls back to http://localhost:5000 (or 5050 on macOS to avoid AirPlay conflict)

// Detect platform: in Electron renderer, window.electronAPI.platform is available
const getDefaultPort = () => {
    try {
        // @ts-ignore - electronAPI is injected by preload
        if (window?.electronAPI?.platform === 'darwin') return 5050;
    } catch (e) { /* not in Electron renderer */ }
    return 5000;
};

export const API_BASE_URL = import.meta.env.VITE_API_URL || `http://localhost:${getDefaultPort()}`;
