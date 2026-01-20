import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
// @ts-ignore
import { XMarkIcon, CheckCircleIcon, ExclamationTriangleIcon, InformationCircleIcon } from '@heroicons/react/24/solid';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastMessage {
    id: string;
    type: ToastType;
    title: string;
    message: string;
}

interface ToastContainerProps {
    toasts: ToastMessage[];
    removeToast: (id: string) => void;
}

const Toast: React.FC<{ toast: ToastMessage; onRemove: () => void }> = ({ toast, onRemove }) => {
    useEffect(() => {
        const timer = setTimeout(() => {
            onRemove();
        }, 5000);
        return () => clearTimeout(timer);
    }, [onRemove]);

    const icons = {
        success: <CheckCircleIcon className="w-6 h-6 text-green-500" />,
        error: <ExclamationTriangleIcon className="w-6 h-6 text-[#FF0055]" />,
        warning: <ExclamationTriangleIcon className="w-6 h-6 text-yellow-500" />,
        info: <InformationCircleIcon className="w-6 h-6 text-blue-500" />
    };

    const bgColors = {
        success: 'bg-[#050505] border-green-500/20 shadow-[0_0_20px_rgba(34,197,94,0.1)]',
        error: 'bg-[#050505] border-[#FF0055]/20 shadow-[0_0_20px_rgba(255,0,85,0.1)]',
        warning: 'bg-[#050505] border-yellow-500/20 shadow-[0_0_20px_rgba(234,179,8,0.1)]',
        info: 'bg-[#050505] border-blue-500/20 shadow-[0_0_20px_rgba(59,130,246,0.1)]'
    };

    return (
        <motion.div
            layout
            initial={{ opacity: 0, x: 50, scale: 0.9 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: 20, scale: 0.95 }}
            className={`pointer-events-auto w-full max-w-sm overflow-hidden rounded-xl border p-4 ${bgColors[toast.type]} backdrop-blur-xl relative group`}
        >
            <div className="flex items-start gap-4">
                <div className="flex-shrink-0 mt-0.5">{icons[toast.type]}</div>
                <div className="flex-1 pt-0.5">
                    <p className="text-sm font-bold text-white mb-1">{toast.title}</p>
                    <p className="text-xs font-medium text-gray-400 leading-relaxed">{toast.message}</p>
                </div>
                <button
                    onClick={onRemove}
                    className="flex-shrink-0 ml-4 text-gray-500 hover:text-white transition-colors"
                >
                    <XMarkIcon className="w-4 h-4" />
                </button>
            </div>

            {/* Progress bar */}
            <motion.div
                initial={{ width: "100%" }}
                animate={{ width: "0%" }}
                transition={{ duration: 5, ease: "linear" }}
                className={`absolute bottom-0 left-0 h-0.5 ${toast.type === 'error' ? 'bg-[#FF0055]' : toast.type === 'success' ? 'bg-green-500' : 'bg-blue-500'} opacity-30`}
            />
        </motion.div>
    );
};

export const ToastContainer: React.FC<ToastContainerProps> = ({ toasts, removeToast }) => {
    return (
        <div className="fixed top-12 right-6 z-[10000] flex flex-col gap-3 pointer-events-none p-4 w-full max-w-md items-end">
            <AnimatePresence mode="popLayout">
                {toasts.map(toast => (
                    <Toast key={toast.id} toast={toast} onRemove={() => removeToast(toast.id)} />
                ))}
            </AnimatePresence>
        </div>
    );
};
