import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
    apiKey: string;
    onApiKeyChange: (key: string) => void;
    onSaveKey: () => Promise<{ success: boolean; message: string }>;
    version: string;
    isUsingCustomKey?: boolean;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
    isOpen,
    onClose,
    apiKey,
    onApiKeyChange,
    onSaveKey,
    version,
    isUsingCustomKey = false
}) => {
    const [isSaving, setIsSaving] = useState(false);
    const [saveStatus, setSaveStatus] = useState<{ type: 'success' | 'error' | null; message: string }>({ type: null, message: '' });

    // Clear status when modal closes or apiKey changes
    useEffect(() => {
        if (!isOpen) {
            setSaveStatus({ type: null, message: '' });
        }
    }, [isOpen]);

    const handleSave = async () => {
        if (!apiKey || apiKey.length < 10) {
            setSaveStatus({ type: 'error', message: 'Please enter a valid API key (at least 10 characters)' });
            return;
        }

        setIsSaving(true);
        setSaveStatus({ type: null, message: '' });

        try {
            const result = await onSaveKey();
            if (result.success) {
                setSaveStatus({ type: 'success', message: result.message || 'API key saved successfully!' });
            } else {
                setSaveStatus({ type: 'error', message: result.message || 'Failed to save API key' });
            }
        } catch (e: any) {
            setSaveStatus({ type: 'error', message: e.message || 'An error occurred while saving' });
        } finally {
            setIsSaving(false);
        }
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
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
                        className="relative bg-[#0A0A0A] border border-white/10 p-8 rounded-2xl w-full max-w-md shadow-2xl"
                    >
                        <h2 className="text-xl font-bold text-white mb-6">Application Settings</h2>

                        <div className="space-y-4">
                            <div>
                                <div className="flex items-center justify-between mb-2">
                                    <label className="text-xs font-bold text-gray-500 uppercase tracking-widest">
                                        Gemini API Key
                                    </label>
                                    {isUsingCustomKey && (
                                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400 font-medium">
                                            Custom Key Active
                                        </span>
                                    )}
                                </div>
                                <input
                                    type="password"
                                    value={apiKey}
                                    onChange={(e) => {
                                        onApiKeyChange(e.target.value);
                                        setSaveStatus({ type: null, message: '' });
                                    }}
                                    placeholder="AIzaSy..."
                                    className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-sm text-white focus:border-[#FF0055] outline-none transition-colors font-mono"
                                />

                                {/* Status message */}
                                {saveStatus.type && (
                                    <motion.p
                                        initial={{ opacity: 0, y: -5 }}
                                        animate={{ opacity: 1, y: 0 }}
                                        className={`text-xs mt-2 ${saveStatus.type === 'success' ? 'text-green-400' : 'text-red-400'}`}
                                    >
                                        {saveStatus.message}
                                    </motion.p>
                                )}

                                <div className="flex justify-between items-center mt-2">
                                    <p className="text-[10px] text-gray-500">
                                        Key is saved locally in ~/.clicksync/config.json
                                    </p>
                                    <p className="text-[10px] text-gray-600 font-mono">
                                        {version}
                                    </p>
                                </div>
                            </div>

                            <div className="flex justify-end gap-3 pt-4">
                                <button
                                    onClick={onClose}
                                    className="px-4 py-2 text-sm text-gray-400 hover:text-white transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleSave}
                                    disabled={isSaving || !apiKey || apiKey.length < 10}
                                    className={`px-4 py-2 text-sm rounded-lg font-medium transition-all ${
                                        isSaving || !apiKey || apiKey.length < 10
                                            ? 'bg-white/5 text-gray-500 cursor-not-allowed'
                                            : 'bg-[#FF0055] text-white hover:bg-[#FF0055]/80'
                                    }`}
                                >
                                    {isSaving ? (
                                        <span className="flex items-center gap-2">
                                            <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                                            </svg>
                                            Saving...
                                        </span>
                                    ) : (
                                        'Save Key'
                                    )}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    );
};
