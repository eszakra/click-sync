import React, { useState, useEffect } from 'react';
// @ts-ignore
import { MinusIcon, StopIcon, XMarkIcon } from '@heroicons/react/24/solid';

// Window interface is defined in vite-env.d.ts

const TitleBar: React.FC = () => {
    const [isMaximized, setIsMaximized] = useState(false);

    // Only render if running in Electron
    if (!window.electronAPI?.isElectron) return null;

    return (
        <div className="fixed top-0 left-0 right-0 h-8 bg-transparent flex items-center justify-end z-[9999] select-none" style={{ WebkitAppRegion: 'drag' } as any}>

            {/* Window Controls - No Drag Region */}
            <div className="flex h-full" style={{ WebkitAppRegion: 'no-drag' } as any}>
                <button
                    onClick={() => window.electronAPI?.minimize()}
                    className="w-12 h-full flex items-center justify-center text-gray-500 hover:bg-white/10 hover:text-white transition-colors focus:outline-none"
                    title="Minimize"
                >
                    <MinusIcon className="w-4 h-4" />
                </button>

                <button
                    onClick={() => {
                        window.electronAPI?.maximize();
                        setIsMaximized(!isMaximized);
                    }}
                    className="w-12 h-full flex items-center justify-center text-gray-500 hover:bg-white/10 hover:text-white transition-colors focus:outline-none"
                    title="Maximize"
                >
                    <StopIcon className="w-3.5 h-3.5" />
                </button>

                <button
                    onClick={() => window.electronAPI?.close()}
                    className="w-12 h-full flex items-center justify-center text-gray-500 hover:bg-[#FF0055] hover:text-white transition-colors focus:outline-none"
                    title="Close"
                >
                    <XMarkIcon className="w-4 h-4" />
                </button>
            </div>
        </div>
    );
};

export default TitleBar;
