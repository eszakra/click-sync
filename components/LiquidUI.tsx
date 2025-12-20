
import React, { ReactNode } from 'react';

// -- CUSTOM GLASS CARD (User Request Adaptation) --
interface LiquidCardProps extends React.HTMLAttributes<HTMLDivElement> {
    children: ReactNode;
    title?: string;
    rightElement?: ReactNode; // Kept matching App.tsx interface
}

export const LiquidCard: React.FC<LiquidCardProps> = ({ children, className = '', title, rightElement, ...props }) => {
    return (
        <div
            className={`
            relative flex flex-col rounded-2xl border border-white/10 
            bg-white/[0.02] backdrop-blur-xl shadow-xl 
            transition-all duration-500 
            hover:border-white/20 hover:shadow-2xl hover:bg-white/[0.04] 
            ${className}
        `}
            {...props}
        >

            {/* Header Section */}
            {(title || rightElement) && (
                <div className="px-6 py-5 border-b border-white/5 flex justify-between items-center bg-white/[0.02]">
                    {title && (
                        <h3 className="text-sm font-semibold text-white/90 tracking-widest uppercase">
                            {title}
                        </h3>
                    )}
                    {rightElement && <div>{rightElement}</div>}
                </div>
            )}

            {/* Body Section */}
            <div className="p-6 relative z-10 flex-1 flex flex-col gap-4">
                {children}
            </div>

            {/* Shine effect */}
            <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-50" />
        </div>
    );
};


// -- CUSTOM BUTTON (User Request Adaptation) --
interface LiquidButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: 'primary' | 'secondary' | 'ghost';
    isLoading?: boolean;
}

export const LiquidButton: React.FC<LiquidButtonProps> = ({
    children,
    variant = 'primary',
    isLoading,
    className = '',
    disabled,
    ...props
}) => {

    const baseStyle = "relative overflow-hidden transition-all duration-300 rounded-xl font-medium text-sm tracking-wide focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]";

    // Adapted to Magenta Theme
    const variants = {
        primary: "bg-[#FF0055] text-white hover:bg-[#FF1F69] px-6 py-3 shadow-[0_0_15px_rgba(255,0,85,0.4)] hover:shadow-[0_0_25px_rgba(255,0,85,0.6)]",
        secondary: "bg-white/5 text-white border border-white/10 hover:bg-white/10 px-6 py-3 hover:border-white/20",
        ghost: "text-gray-400 hover:text-white px-4 py-2 hover:bg-white/5"
    };

    return (
        <button
            className={`${baseStyle} ${variants[variant]} ${className} flex items-center justify-center`}
            disabled={disabled || isLoading}
            {...props}
        >
            {isLoading ? (
                <div className="flex items-center justify-center gap-2">
                    {/* Liquid Loader Small */}
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
                    <span>Processing...</span>
                </div>
            ) : children}
        </button>
    );
};

// -- TEXT AREA (Refined to match) --
export const LiquidTextArea = (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <div className="relative group">
        <textarea
            className="w-full bg-transparent text-gray-300 text-sm leading-relaxed p-4 rounded-xl border border-white/10 focus:border-[#FF0055]/50 focus:ring-0 outline-none transition-all resize-none placeholder-gray-700 font-mono focus:bg-white/[0.02]"
            style={{ minHeight: '200px' }}
            {...props}
        />
        {/* Subtle Shine Bottom */}
        <div className="absolute bottom-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-white/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>
);

// -- PROGRESS BAR --
export const LiquidProgressBar = ({ progress }: { progress: number }) => (
    <div className="w-full h-1 bg-white/5 rounded-full overflow-hidden mt-1">
        <div
            className="h-full bg-[#FF0055] shadow-[0_0_15px_#FF0055] transition-all duration-500 ease-out"
            style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
        />
    </div>
);

// -- DROP ZONE --
export const LiquidDropZone = ({
    onFileSelect,
    accept,
    label,
    fileName
}: {
    onFileSelect: (file: File) => void;
    accept?: string;
    label: string;
    fileName?: string | null;
}) => {
    const fileInputRef = React.useRef<HTMLInputElement>(null);

    return (
        <div
            onClick={() => fileInputRef.current?.click()}
            className={`
                relative overflow-hidden
                border border-dashed rounded-xl p-8 text-center cursor-pointer transition-all duration-500
                group flex flex-col items-center justify-center gap-4
                ${fileName
                    ? 'bg-[#FF0055]/5 border-[#FF0055]/30'
                    : 'bg-white/[0.02] border-white/10 hover:border-white/20 hover:bg-white/[0.04]'
                }
            `}
        >
            <input
                type="file"
                ref={fileInputRef}
                className="hidden"
                accept={accept}
                onChange={(e) => e.target.files?.[0] && onFileSelect(e.target.files[0])}
            />

            {fileName ? (
                <>
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-[#FF0055] to-rose-600 flex items-center justify-center shadow-lg shadow-pink-900/40">
                        <svg className="w-6 h-6 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                    </div>
                    <span className="text-white font-medium text-base tracking-tight">{fileName}</span>
                    <span className="text-[#FF0055] text-xs uppercase tracking-widest font-bold">Ready</span>
                </>
            ) : (
                <>
                    <div className="w-12 h-12 rounded-full bg-white/5 flex items-center justify-center group-hover:scale-110 transition-transform duration-300">
                        <svg className="w-6 h-6 text-gray-400 group-hover:text-white transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                        </svg>
                    </div>
                    <div className="space-y-1">
                        <p className="text-gray-300 font-medium text-sm">{label}</p>
                        <p className="text-gray-600 text-xs">Support: MP3, WAV</p>
                    </div>
                </>
            )}

            {/* Shine effect */}
            <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
        </div>
    );
};
