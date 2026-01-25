const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    // Get app version
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),

    // Get app path
    getAppPath: () => ipcRenderer.invoke('get-app-path'),

    // Check if running in Electron
    isElectron: true,

    // Platform info
    platform: process.platform,

    // Window Controls
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close')
});

// Expose storage API for file-based persistence
contextBridge.exposeInMainWorld('electron', {
    storage: {
        get: (key) => ipcRenderer.invoke('storage-get', key),
        set: (key, value) => ipcRenderer.invoke('storage-set', key, value),
        remove: (key) => ipcRenderer.invoke('storage-remove', key)
    },
    tray: {
        updateProgress: (data) => ipcRenderer.send('update-tray-progress', data)
    },
    // Viory session management
    viory: {
        getStatus: () => ipcRenderer.invoke('get-viory-session-status'),
        verify: () => ipcRenderer.invoke('verify-viory-session'),
        forceLogin: () => ipcRenderer.invoke('force-viory-login'),
        onStatusUpdate: (callback) => {
            const subscription = (event, data) => callback(data);
            ipcRenderer.on('viory-status-update', subscription);
            return () => ipcRenderer.removeListener('viory-status-update', subscription);
        },
        onSessionStatus: (callback) => {
            const subscription = (event, data) => callback(data);
            ipcRenderer.on('viory-session-status', subscription);
            return () => ipcRenderer.removeListener('viory-session-status', subscription);
        }
    },
    // Auto-update and General IPC
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    on: (channel, func) => {
        // Wrapper for ipcRenderer.on
        const subscription = (event, ...args) => func(event, ...args);
        ipcRenderer.on(channel, subscription);
        return () => ipcRenderer.removeListener(channel, subscription);
    },
    receive: (channel, func) => {
        // Legacy support
        ipcRenderer.on(channel, (event, ...args) => func(...args));
    },
    removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),
    send: (channel, ...args) => ipcRenderer.send(channel, ...args)
});
