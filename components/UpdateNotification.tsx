import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ArrowDownTrayIcon, SparklesIcon, XMarkIcon } from '@heroicons/react/24/solid';

interface UpdateNotificationProps {
    status: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'error' | 'latest';
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
    const isVisible = ['available', 'downloading', 'ready', 'checking', 'latest', 'error'].includes(status);

    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    initial={{ opacity: 0, x: 50, scale: 0.9 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    exit={{ opacity: 0, x: 20, scale: 0.95 }}
                    className="fixed top-24 right-6 z-[9000] w-full max-w-sm"
                >
                    <div className={`bg-[#050505] backdrop-blur-xl border ${status === 'error' ? 'border-[#FF0055]/20 shadow-[0_0_20px_rgba(255,0,85,0.1)]' : 'border-green-500/20 shadow-[0_0_20px_rgba(34,197,94,0.1)]'} rounded-xl p-4 relative overflow-hidden group`}>

                        {/* Progress Bar Background */}
                        {status === 'downloading' && (
                            <div
                                className="absolute bottom-0 left-0 h-1 bg-[#00FF88]/50 transition-all duration-300"
                                style={{ width: `${progress}%` }}
                            />
                        )}

                        <div className="flex items-start justify-between gap-4">
                            <div className="flex items-center gap-3">
                                <div className="flex-shrink-0 mt-0.5">
                                    {status === 'available' && <SparklesIcon className="w-6 h-6 text-green-500" />}
                                    {status === 'downloading' && <div className="w-5 h-5 rounded-full border-2 border-green-500 border-t-transparent animate-spin" />}
                                    {status === 'ready' && <ArrowDownTrayIcon className="w-6 h-6 text-green-500" />}
                                    {status === 'checking' && <div className="w-5 h-5 rounded-full border-2 border-gray-500 border-t-transparent animate-spin" />}
                                    {status === 'latest' && <SparklesIcon className="w-6 h-6 text-gray-400" />}
                                    {status === 'error' && <XMarkIcon className="w-6 h-6 text-[#FF0055]" />}
                                </div>
                                <div className="flex-1 pt-0.5">
                                    <h4 className="text-sm font-bold text-white mb-1">
                                        {status === 'latest' ? 'Up to Date' :
                                            status === 'checking' ? 'Checking for Updates' :
                                                status === 'error' ? 'Update Failed' :
                                                    `Update Available`}
                                        {version && status !== 'checking' && status !== 'latest' && status !== 'error' && <span className="text-green-500 text-xs px-1.5 py-0.5 rounded bg-green-500/10 ml-2">{version}</span>}
                                    </h4>
                                    <p className="text-xs font-medium text-gray-400 leading-relaxed">
                                        {status === 'available' && "A new version of ClickSync is available."}
                                        {status === 'downloading' && `Downloading... ${Math.round(progress)}%`}
                                        {status === 'ready' && "Download complete. Ready to install."}
                                        {status === 'checking' && "Connecting to update server..."}
                                        {status === 'latest' && "You are using the latest version."}
                                        {status === 'error' && (message || "Could not check for updates.")}
                                    </p>
                                </div>
                            </div>

                            <button onClick={onDismiss} className="flex-shrink-0 ml-4 text-gray-500 hover:text-white transition-colors">
                                <XMarkIcon className="w-4 h-4" />
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
