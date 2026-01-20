import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    appVersion: string;
    apiKey: string;
    onApiKeyChange: (key: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
    isOpen,
    onClose,
    appVersion,
    apiKey,
    onApiKeyChange
}) => {
    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[200] flex items-center justify-center p-6">
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="absolute inset-0 bg-black/80 backdrop-blur-md"
                        onClick={onClose}
                    />
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.95, opacity: 0 }}
                        className="relative bg-[#0A0A0A] border border-white/10 p-8 rounded-2xl w-full max-w-md shadow-2xl z-10"
                    >
                        <h2 className="text-xl font-bold text-white mb-6">Application Settings</h2>

                        <div className="space-y-4">
                            <div>
                                <label className="text-xs font-bold text-gray-500 uppercase tracking-widest mb-2 block">
                                    Gemini API Key
                                </label>
                                <input
                                    type="password"
                                    value={apiKey}
                                    onChange={(e) => onApiKeyChange(e.target.value)}
                                    placeholder="AIzaSy..."
                                    className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white focus:border-[#FF0055] outline-none transition-colors font-mono"
                                />
                                <div className="flex items-center justify-between mt-2">
                                    <p className="text-[10px] text-gray-500">
                                        Key is saved locally in your user folder.
                                    </p>
                                    <p className="text-[10px] text-gray-600 font-mono">
                                        v{appVersion || "..."}
                                    </p>
                                </div>
                            </div>

                            <div className="flex justify-end gap-3 pt-4">
                                <button
                                    onClick={onClose}
                                    className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                                >
                                    Close
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
