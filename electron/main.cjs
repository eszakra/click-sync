const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');
const log = require('electron-log');

// Configure logging
log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.autoDownload = true; // Spotify-style: Download silently, then ask to restart

// Keep a global reference of the window object
let mainWindow;
let tray = null;

// Determine if we're in development or production
const isDev = !app.isPackaged;

// CRITICAL: Set App User Model ID for Windows Notifications (Fixes "electron.app.ClickSync" title)
if (process.platform === 'win32') {
    app.setAppUserModelId('com.clicksync.app');
}

// --- AUTO UPDATE EVENTS ---
function setupAutoUpdater() {
    autoUpdater.on('checking-for-update', () => {
        log.info('Checking for update...');
        if (mainWindow) mainWindow.webContents.send('update-status', { status: 'checking', message: 'Checking for updates...' });
    });

    autoUpdater.on('update-available', (info) => {
        log.info('Update available.', info);
        if (mainWindow) mainWindow.webContents.send('update-available', info);
    });

    autoUpdater.on('update-not-available', (info) => {
        log.info('Update not available.');
        if (mainWindow) mainWindow.webContents.send('update-status', { status: 'latest', message: 'You are on the latest version.' });
    });

    autoUpdater.on('error', (err) => {
        log.error('Error in auto-updater. ' + err);
        if (mainWindow) mainWindow.webContents.send('update-error', err.toString());
    });

    autoUpdater.on('download-progress', (progressObj) => {
        let log_message = "Download speed: " + progressObj.bytesPerSecond;
        log_message = log_message + ' - Downloaded ' + progressObj.percent + '%';
        log_message = log_message + ' (' + progressObj.transferred + "/" + progressObj.total + ')';
        log.info(log_message);
        if (mainWindow) mainWindow.webContents.send('update-progress', progressObj);
    });

    autoUpdater.on('update-downloaded', (info) => {
        log.info('Update downloaded');
        if (mainWindow) mainWindow.webContents.send('update-downloaded', info);
    });
}

setupAutoUpdater();

// Create System Tray
function createTray() {
    try {
        let iconPath;
        if (app.isPackaged) {
            // In production, use the icon we copied to resources/assets using extraResources in package.json
            iconPath = path.join(process.resourcesPath, 'assets/tray-icon.png');
        } else {
            // In development, use public folder
            iconPath = path.join(__dirname, '../public/tray-icon.png');
        }

        console.log('[Tray] Loading icon from:', iconPath);

        // Ensure path exists before loading, otherwise nativeImage fail might crash? 
        // Actually nativeImage.createFromPath handles missing files gracefully (returns empty)

        let trayIcon;
        try {
            trayIcon = nativeImage.createFromPath(iconPath);
            // Resize if needed, though 32x32 is ideal
            if (trayIcon.isEmpty()) {
                console.warn('[Tray] Icon empty at path, falling back to exe icon');
                trayIcon = nativeImage.createFromPath(app.getPath('exe'));
            }
        } catch (e) {
            console.error('[Tray] Exception loading icon:', e);
            trayIcon = nativeImage.createFromPath(app.getPath('exe'));
        }

        tray = new Tray(trayIcon);

        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Check for Updates',
                click: () => {
                    autoUpdater.checkForUpdates();
                    if (mainWindow) {
                        mainWindow.show();
                        mainWindow.webContents.send('update-status', { status: 'checking', message: 'Manually checking...' });
                    }
                }
            },
            { type: 'separator' },
            {
                label: 'Show ClickSync',
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                        mainWindow.focus();
                    }
                }
            },
            { type: 'separator' },
            {
                label: 'Quit',
                click: () => {
                    app.isQuitting = true;
                    app.quit();
                }
            }
        ]);

        tray.setToolTip('ClickSync - Ready');
        tray.setContextMenu(contextMenu);

        // Double click to show window
        tray.on('double-click', () => {
            if (mainWindow) {
                mainWindow.show();
                mainWindow.focus();
            }
        });

        // Click to show window (single click)
        tray.on('click', () => {
            if (mainWindow) {
                mainWindow.show();
                mainWindow.focus();
            }
        });

        console.log('[Tray] System tray created successfully');
    } catch (error) {
        console.error('[Tray] Failed to create system tray:', error);
    }
}

function createWindow() {
    // Create the browser window
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 600,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.cjs')
        },
        // Modern frameless look
        frame: false,
        titleBarStyle: 'hidden',
        backgroundColor: '#000000',
        show: false, // Don't show until ready
        icon: path.join(__dirname, '../public/logo.png')
    });

    // Load the app
    if (isDev) {
        // In development, load from Vite dev server
        mainWindow.loadURL('http://localhost:5173');
        // Open DevTools in development
        mainWindow.webContents.openDevTools();
    } else {
        // In production, load the built files
        mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }

    // Show window when ready to prevent visual flash
    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Minimize to tray instead of closing
    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault();
            mainWindow.hide();

            // Show notification on first minimize
            if (tray && !mainWindow.trayNotificationShown) {
                tray.displayBalloon({
                    title: 'ClickSync',
                    content: 'App is running in the background. Click the tray icon to restore.'
                });
                mainWindow.trayNotificationShown = true;
            }
        }
        return false;
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

async function startServer() {
    // In production, start the embedded server directly
    // In development, the server is started separately via npm run server
    if (!isDev) {
        try {
            const serverPath = path.join(__dirname, '../server.js');
            console.log(`[Electron] Server path: ${serverPath}`);

            // CRITICAL: Convert Windows path to file:// URL for ESM import
            const serverUrl = pathToFileURL(serverPath).href;
            console.log(`[Electron] Server URL: ${serverUrl}`);

            // Dynamic import using file:// URL
            const serverModule = await import(serverUrl);
            if (serverModule && serverModule.startServer) {
                await serverModule.startServer();
                console.log('[Electron] Server started successfully in-process');
            } else {
                const errMsg = 'No se encontró la función startServer en server.js';
                console.error('[Electron]', errMsg);
                dialog.showErrorBox('Error del Servidor', errMsg);
            }
        } catch (e) {
            const errMsg = `El servidor no pudo iniciar.\n\nError: ${e.message}`;
            console.error('[Electron] Failed to start server:', e);
            console.error('[Electron] Stack:', e.stack);

            // Show error dialog to user
            dialog.showErrorBox('Error al Iniciar Servidor',
                `${errMsg}\n\nPosibles causas:\n1. Chromium/Playwright no instalado\n2. Firewall bloqueando puerto 5000\n3. Puerto 5000 ocupado por otra app\n\nDetalles técnicos:\n${e.stack ? e.stack.substring(0, 500) : 'N/A'}`);
        }
    }
}

// This method will be called when Electron has finished initialization
app.whenReady().then(async () => {
    // Start server first
    await startServer();

    // Create window
    createWindow();

    // Create system tray
    // --- IPC HANDLERS for Auto Updates ---
    ipcMain.handle('check-for-updates', async () => {
        if (!isDev) {
            return autoUpdater.checkForUpdates();
        } else {
            return { message: 'Development mode: Updates disabled' };
        }
    });

    ipcMain.handle('start-update-download', async () => {
        return autoUpdater.downloadUpdate();
    });

    ipcMain.handle('quit-and-install', () => {
        autoUpdater.quitAndInstall();
    });

    createTray();

    // Add JumpList for Windows to allow opening new instances
    if (process.platform === 'win32') {
        app.setUserTasks([
            {
                program: process.execPath,
                arguments: '--new-window',
                iconPath: process.execPath,
                iconIndex: 0,
                title: 'New Window',
                description: 'Open a new ClickSync window'
            }
        ]);
    }

    app.on('activate', () => {
        // On macOS it's common to re-create a window when the dock icon is clicked
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

// Quit when all windows are closed (except on macOS)
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// Clean up on app quit
app.on('before-quit', () => {
    // Server runs in-process, will close automatically
});

// IPC handlers for communication with renderer
ipcMain.handle('get-app-version', () => {
    return app.getVersion();
});

ipcMain.handle('get-app-path', () => {
    return app.getAppPath();
});

// Window Controls
ipcMain.on('window-minimize', () => {
    if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
    if (mainWindow) {
        if (mainWindow.isMaximized()) {
            mainWindow.unmaximize();
        } else {
            mainWindow.maximize();
        }
    }
});


ipcMain.on('window-close', () => {
    if (mainWindow) mainWindow.close();
});

// Storage IPC Handlers (AppData persistence)
const fs = require('fs');

const getStoragePath = () => {
    const userDataPath = app.getPath('userData');
    const storagePath = path.join(userDataPath, 'storage');

    // Ensure storage directory exists
    if (!fs.existsSync(storagePath)) {
        fs.mkdirSync(storagePath, { recursive: true });
    }

    return storagePath;
};

ipcMain.handle('storage-get', async (event, key) => {
    try {
        const storagePath = getStoragePath();
        const filePath = path.join(storagePath, `${key}.json`);

        if (fs.existsSync(filePath)) {
            const data = fs.readFileSync(filePath, 'utf-8');
            return data;
        }
        return null;
    } catch (e) {
        console.error('Storage get error:', e);
        return null;
    }
});

ipcMain.handle('storage-set', async (event, key, value) => {
    try {
        const storagePath = getStoragePath();
        const filePath = path.join(storagePath, `${key}.json`);
        fs.writeFileSync(filePath, value, 'utf-8');
        return true;
    } catch (e) {
        console.error('Storage set error:', e);
        return false;
    }
});

ipcMain.handle('storage-remove', async (event, key) => {
    try {
        const storagePath = getStoragePath();
        const filePath = path.join(storagePath, `${key}.json`);

        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
        return true;
    } catch (e) {
        console.error('Storage remove error:', e);
        return false;
    }
});

// Tray Progress Update IPC
ipcMain.on('update-tray-progress', (event, data) => {
    if (tray) {
        const { status, progress, message, activeProjects } = data;

        let tooltip = 'ClickSync';

        if (status === 'processing') {
            tooltip = `ClickSync - Processing: ${Math.round(progress)}%`;
            if (message) {
                tooltip += `\n${message}`;
            }
        } else if (status === 'idle') {
            tooltip = 'ClickSync - Ready';
        } else if (status === 'completed') {
            tooltip = 'ClickSync - Completed!';
        }

        // Add active projects count if provided
        if (activeProjects && activeProjects > 0) {
            tooltip += `\n${activeProjects} active project(s)`;
        }

        tray.setToolTip(tooltip);
    }
});
