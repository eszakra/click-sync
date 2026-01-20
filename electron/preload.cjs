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
    // Auto-update and General IPC
    invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
    receive: (channel, func) => {
        // Deliberately strip event as it includes `sender` 
        ipcRenderer.on(channel, (event, ...args) => func(...args));
    },
    send: (channel, ...args) => ipcRenderer.send(channel, ...args)
});
