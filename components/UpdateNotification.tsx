import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowDownTrayIcon, SparklesIcon, XMarkIcon } from '@heroicons/react/24/solid';

interface UpdateNotificationProps {
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error';
    progress?: number;
    version?: string;
    message?: string;
    onDownload: () => void;
    onInstall: () => void;
    onDismiss: () => void;
}

export const UpdateNotification: React.FC<UpdateNotificationProps> = ({
    status,
    progress = 0,
    version,
    message,
    onDownload,
    onInstall,
    onDismiss
}) => {
    // Only show for relevant statuses
    const isVisible = ['available', 'downloading', 'ready'].includes(status);

    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    initial={{ y: -100, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -100, opacity: 0 }}
                    className="fixed top-8 left-1/2 -translate-x-1/2 z-[100] w-full max-w-md"
                >
                    <div className="bg-[#111]/90 backdrop-blur-md border border-[#00FF88]/20 rounded-xl p-4 shadow-[0_0_30px_rgba(0,255,136,0.15)] flex flex-col gap-3 relative overflow-hidden">

                        {/* Progress Bar Background */}
                        {status === 'downloading' && (
                            <div
                                className="absolute bottom-0 left-0 h-1 bg-[#00FF88]/50 transition-all duration-300"
                                style={{ width: `${progress}%` }}
                            />
                        )}

                        <div className="flex items-start justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="w-10 h-10 rounded-full bg-[#00FF88]/10 flex items-center justify-center border border-[#00FF88]/20">
                                    {status === 'available' && <SparklesIcon className="w-5 h-5 text-[#00FF88]" />}
                                    {status === 'downloading' && <div className="w-4 h-4 rounded-full border-2 border-[#00FF88] border-t-transparent animate-spin" />}
                                    {status === 'ready' && <ArrowDownTrayIcon className="w-5 h-5 text-[#00FF88]" />}
                                </div>
                                <div>
                                    <h4 className="text-white font-bold text-sm">Update Available {version && <span className="text-[#00FF88] text-xs px-1.5 py-0.5 rounded bg-[#00FF88]/10 ml-2">{version}</span>}</h4>
                                    <p className="text-gray-400 text-xs mt-0.5">
                                        {status === 'available' && "A new version of ClickSync is available."}
                                        {status === 'downloading' && `Downloading... ${Math.round(progress)}%`}
                                        {status === 'ready' && "Download complete. Ready to install."}
                                    </p>
                                </div>
                            </div>

                            <button onClick={onDismiss} className="text-gray-500 hover:text-white transition-colors">
                                <XMarkIcon className="w-5 h-5" />
                            </button>
                        </div>

                        {/* Actions */}
                        <div className="flex gap-2 justify-end mt-1">
                            {status === 'available' && (
                                <button
                                    onClick={onDownload}
                                    className="px-3 py-1.5 bg-[#00FF88] hover:bg-[#00FF88]/90 text-black text-xs font-bold rounded-lg transition-colors shadow-[0_0_10px_rgba(0,255,136,0.2)]"
                                >
                                    Download Update
                                </button>
                            )}
                            {status === 'ready' && (
                                <button
                                    onClick={onInstall}
                                    className="px-3 py-1.5 bg-[#00FF88] hover:bg-[#00FF88]/90 text-black text-xs font-bold rounded-lg transition-colors shadow-[0_0_10px_rgba(0,255,136,0.2)] animate-pulse"
                                >
                                    Restart & Install
                                </button>
                            )}
                        </div>
                    </div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};
