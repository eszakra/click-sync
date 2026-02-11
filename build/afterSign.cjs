const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

/**
 * electron-builder afterSign hook
 * This runs AFTER the signing phase (which is skipped due to identity:null)
 * but BEFORE the DMG/ZIP is created.
 * It applies an ad-hoc signature so macOS Gatekeeper doesn't mark the app as "damaged".
 */
exports.default = async function (context) {
    // Only run on macOS builds
    if (process.platform !== 'darwin') {
        console.log('[afterSign] Not macOS, skipping ad-hoc signing');
        return;
    }

    const appName = context.packager.appInfo.productFilename;
    const appPath = path.join(context.appOutDir, `${appName}.app`);

    console.log(`[afterSign] Ad-hoc signing: ${appPath}`);

    try {
        // Remove any existing (possibly broken) signature
        try {
            execSync(`codesign --remove-signature "${appPath}"`, { stdio: 'inherit' });
        } catch (e) {
            // Ignore if no signature exists
        }

        // First, sign the bundled Chromium/Google Chrome for Testing app specifically
        // (--deep sometimes misses nested .app bundles)
        const resourcesPath = path.join(appPath, 'Contents', 'Resources');
        const chromiumBase = path.join(resourcesPath, 'playwright-browsers', 'chromium');
        
        if (fs.existsSync(chromiumBase)) {
            console.log('[afterSign] Signing bundled Chromium browser...');
            
            // Find any .app bundles within the chromium directory
            const findApps = (dir) => {
                const results = [];
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    for (const entry of entries) {
                        const fullPath = path.join(dir, entry.name);
                        if (entry.name.endsWith('.app')) {
                            results.push(fullPath);
                        } else if (entry.isDirectory()) {
                            results.push(...findApps(fullPath));
                        }
                    }
                } catch (e) { /* ignore permission errors */ }
                return results;
            };

            const nestedApps = findApps(chromiumBase);
            for (const nestedApp of nestedApps) {
                console.log(`[afterSign] Signing nested app: ${nestedApp}`);
                try {
                    execSync(`codesign --force --deep --sign - "${nestedApp}"`, { stdio: 'inherit' });
                } catch (e) {
                    console.warn(`[afterSign] Warning: Failed to sign ${nestedApp}: ${e.message}`);
                }
            }
        }

        // Ad-hoc sign the entire app bundle including all nested frameworks and binaries
        execSync(`codesign --force --deep --sign - "${appPath}"`, { stdio: 'inherit' });

        // Verify the signature
        execSync(`codesign --verify --verbose=2 "${appPath}"`, { stdio: 'inherit' });

        console.log('[afterSign] Ad-hoc signing completed successfully!');
    } catch (error) {
        console.error('[afterSign] Ad-hoc signing failed:', error.message);
        // Don't fail the build - the app will still work but may show Gatekeeper warning
    }
};
