const { execSync } = require('child_process');
const path = require('path');

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
