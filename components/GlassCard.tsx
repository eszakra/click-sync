import React from 'react';

interface GlassCardProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  action?: React.ReactNode;
}

export const GlassCard: React.FC<GlassCardProps> = ({ children, className = '', title, action }) => {
  return (
    <div className={`relative flex flex-col rounded-2xl border border-glass-border bg-glass-100 backdrop-blur-xl shadow-xl transition-all duration-500 hover:border-glass-highlight hover:shadow-2xl hover:bg-glass-200 ${className}`}>
      
      {/* Header Section */}
      {(title || action) && (
        <div className="px-6 py-5 border-b border-glass-border flex justify-between items-center bg-white/[0.02]">
          {title && (
            <h3 className="text-sm font-semibold text-white/90 tracking-widest uppercase">
              {title}
            </h3>
          )}
          {action && <div>{action}</div>}
        </div>
      )}
      
      {/* Body Section */}
      <div className="p-6 relative z-10 flex-1">
        {children}
      </div>
      
      {/* Shine effect */}
      <div className="absolute top-0 left-0 w-full h-px bg-gradient-to-r from-transparent via-white/10 to-transparent opacity-50" />
    </div>
  );
};