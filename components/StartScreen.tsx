import React, { useState, useEffect, useRef } from 'react';
import { PlusIcon, TrashIcon, FilmIcon, ClockIcon, PencilIcon, Cog6ToothIcon, ArrowUpTrayIcon, DocumentTextIcon, ChevronRightIcon } from '@heroicons/react/24/solid';
import { AnimatePresence, motion } from 'framer-motion';
import { ProjectData, projectService } from '../services/projectService';
import TitleBar from './TitleBar';

interface StartScreenProps {
    recents: ProjectData[];
    onNewProject: (name: string, audioFile: File, scriptText: string) => void;
    onOpenProject: (proj: ProjectData) => void;
    onDeleteProject: (id: string) => void;
    onResumeSession?: (project?: ProjectData | null) => void;
    resumeProject?: ProjectData | null;
    onRename?: (id: string, newName: string) => void;
    onOpenSettings: () => void;
}

export const StartScreen: React.FC<StartScreenProps> = ({
    recents,
    onNewProject,
    onOpenProject,
    onDeleteProject,
    onResumeSession,
    resumeProject,
    onRename,
    onOpenSettings
}) => {
    const [deleteConfirm, setDeleteConfirm] = React.useState<{ show: boolean; project: ProjectData | null }>({ show: false, project: null });
    const [showResumeParams, setShowResumeParams] = React.useState(false);

    // NEW PROJECT WIZARD STATE
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [wizardStep, setWizardStep] = useState(1); // 1: Name, 2: Audio, 3: Script
    const [newProjectName, setNewProjectName] = useState("");
    const [audioFile, setAudioFile] = useState<File | null>(null);
    const [scriptText, setScriptText] = useState("");
    const fileInputRef = useRef<HTMLInputElement>(null);

    const resetWizard = () => {
        setWizardStep(1);
        setNewProjectName("");
        setAudioFile(null);
        setAudioFilePath('');
        setAudioFileName('');
        setAudioFileSize(0);
        setScriptText("");
        setShowCreateModal(false);
    };

    const handleCreateConfirm = () => {
        if (!newProjectName || !scriptText) return;
        // Need either audioFile OR audioFilePath (native)
        if (!audioFile && !audioFilePath) return;
        
        // If we have a native path, attach it to the file object
        let fileToPass = audioFile;
        if (audioFilePath && fileToPass) {
            (fileToPass as any).nativePath = audioFilePath;
        } else if (audioFilePath && !audioFile) {
            // Create file object with native path
            fileToPass = new File([], audioFileName, { type: 'audio/mpeg' });
            (fileToPass as any).nativePath = audioFilePath;
        }
        
        if (!fileToPass) return;
        
        onNewProject(newProjectName.trim(), fileToPass, scriptText);
        resetWizard();
    };

    // RENAME STATE
    const [renameTarget, setRenameTarget] = useState<ProjectData | null>(null);
    const [renameInput, setRenameInput] = useState("");

    useEffect(() => {
        if (resumeProject) {
            setShowResumeParams(true);
        }
    }, [resumeProject]);

    const formatDate = (ts: number) => {
        const d = new Date(ts);
        const now = Date.now();
        const diff = (now - ts) / 1000;
        if (diff < 60) return 'Just now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return d.toLocaleDateString();
    };

    const handleDelete = async () => {
        if (deleteConfirm.project) {
            onDeleteProject(deleteConfirm.project.id);
            setDeleteConfirm({ show: false, project: null });
        }
    };

    // State for native file selection (path-based like pro editors)
    const [audioFilePath, setAudioFilePath] = useState<string>('');
    const [audioFileName, setAudioFileName] = useState<string>('');
    const [audioFileSize, setAudioFileSize] = useState<number>(0);

    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        // Fallback for web file input (if Electron dialog fails)
        if (e.target.files && e.target.files[0]) {
            setAudioFile(e.target.files[0]);
        }
    };

    // Use native Electron dialog - like pro editors, references original file
    const handleNativeFileSelect = async () => {
        if ((window as any).electron) {
            try {
                const result = await (window as any).electron.invoke('dialog:open-audio');
                if (result) {
                    // Store the path directly - no copying needed!
                    setAudioFilePath(result.path);
                    setAudioFileName(result.name);
                    setAudioFileSize(result.size);
                    
                    // Create a minimal File object for compatibility with existing code
                    // We'll use the path for actual operations
                    const dummyFile = new File([], result.name, { type: 'audio/mpeg' });
                    (dummyFile as any).nativePath = result.path; // Attach real path
                    setAudioFile(dummyFile);
                    
                    console.log('[StartScreen] Audio selected via native dialog:', result.path);
                }
            } catch (err) {
                console.error('[StartScreen] Native dialog failed:', err);
                // Fallback to web input
                fileInputRef.current?.click();
            }
        } else {
            // Web fallback
            fileInputRef.current?.click();
        }
    };

    return (
        <div className="min-h-screen bg-[#050505] flex text-white font-sans selection:bg-[#FF0055] selection:text-white overflow-hidden">
            <TitleBar />

            {/* Resume Session Modal */}
            <AnimatePresence>
                {showResumeParams && resumeProject && onResumeSession && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
                    >
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0, y: 20 }}
                            animate={{ scale: 1, opacity: 1, y: 0 }}
                            exit={{ scale: 0.9, opacity: 0 }}
                            className="bg-[#111] border border-[#00FF88]/30 rounded-2xl p-8 max-w-md w-full mx-4 shadow-[0_0_30px_rgba(0,255,136,0.1)] relative overflow-hidden"
                        >
                            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-[#00FF88] to-transparent" />

                            <h3 className="text-xl font-bold text-white mb-2">Restore Session?</h3>
                            <p className="text-gray-400 text-sm mb-6">
                                Would you like to resume working on "<span className="text-white font-semibold">{resumeProject.name}</span>"?
                            </p>

                            <div className="flex gap-3">
                                <button
                                    onClick={() => setShowResumeParams(false)}
                                    className="flex-1 px-4 py-2.5 bg-white/5 hover:bg-white/10 rounded-lg text-white transition-colors font-medium border border-white/5"
                                >
                                    No, Start Fresh
                                </button>
                                <button
                                    onClick={() => {
                                        onResumeSession(resumeProject);
                                        setShowResumeParams(false);
                                    }}
                                    className="flex-1 px-4 py-2.5 bg-[#00FF88] hover:bg-[#00FF88]/90 rounded-lg text-black transition-colors font-bold shadow-[0_0_15px_rgba(0,255,136,0.4)]"
                                >
                                    Yes, Resume Work
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* Custom Delete Confirmation Modal */}
            <AnimatePresence>
                {deleteConfirm.show && (
                    <motion.div
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
                        onClick={() => setDeleteConfirm({ show: false, project: null })}
                    >
                        <motion.div
                            initial={{ scale: 0.9, opacity: 0 }}
                            animate={{ scale: 1, opacity: 1 }}
                            exit={{ scale: 0.9, opacity: 0 }}
                            onClick={(e) => e.stopPropagation()}
                            className="bg-[#111] border border-white/10 rounded-2xl p-8 max-w-md w-full mx-4 shadow-2xl"
                        >
                            <h3 className="text-xl font-bold text-white mb-2">Delete Project?</h3>
                            <p className="text-gray-400 text-sm mb-6">
                                Are you sure you want to delete "<span className="text-white font-semibold">{deleteConfirm.project?.name}</span>"?
                                This action cannot be undone.
                            </p>
                            <div className="flex gap-3">
                                <button
                                    onClick={() => setDeleteConfirm({ show: false, project: null })}
                                    className="flex-1 px-4 py-2.5 bg-white/5 hover:bg-white/10 rounded-lg text-white transition-colors font-medium"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleDelete}
                                    className="flex-1 px-4 py-2.5 bg-[#FF0055] hover:bg-[#FF1F69] rounded-lg text-white transition-colors font-medium shadow-[0_0_15px_rgba(255,0,85,0.3)]"
                                >
                                    Delete
                                </button>
                            </div>
                        </motion.div>
                    </motion.div>
                )}
            </AnimatePresence>

            {/* LEFT SIDEBAR */}
            <div className="w-64 bg-[#09090b] border-r border-white/5 flex flex-col p-6 gap-8 z-20 shadow-2xl mt-8">
                {/* Logo Area */}
                <div className="flex flex-col gap-1 mb-4">
                    <h1 className="text-2xl font-extrabold tracking-tighter text-white">
                        ClickSync<span className="text-[#FF0055]">.</span>
                    </h1>
                    <span className="px-2 py-0.5 rounded bg-white/5 text-[10px] uppercase font-bold text-gray-400 tracking-widest border border-white/5 w-fit">
                        Unified Studio
                    </span>
                </div>

                {/* Primary Actions */}
                <div className="space-y-3">
                    <button
                        onClick={() => setShowCreateModal(true)}
                        className="w-full flex items-center gap-3 px-4 py-3 bg-[#FF0055] hover:bg-[#FF1F69] rounded-lg transition-all shadow-[0_0_15px_rgba(255,0,85,0.3)] hover:shadow-[0_0_20px_rgba(255,0,85,0.5)] active:scale-95 group"
                    >
                        <PlusIcon className="w-5 h-5" />
                        <span className="font-bold text-sm tracking-wide">New Project</span>
                    </button>
                </div>

                <div className="flex-1" />

                <button
                    onClick={onOpenSettings}
                    className="flex items-center gap-3 px-4 py-3 bg-white/5 hover:bg-white/10 rounded-lg transition-colors text-gray-400 hover:text-white group"
                >
                    <Cog6ToothIcon className="w-5 h-5 group-hover:rotate-90 transition-transform duration-500" />
                    <span className="font-bold text-sm tracking-wide">Settings</span>
                </button>
            </div>

            {/* MAIN CONTENT AREA */}
            <div className="flex-1 relative flex flex-col mt-8">
                <div className="absolute inset-0 bg-gradient-to-br from-[#050505] via-[#09090b] to-[#111] z-0" />

                {/* Hero Header */}
                <div className="relative z-10 p-12 pb-6">
                    <h1 className="text-3xl font-light text-gray-300 mb-2">Welcome Back, Creator</h1>
                    <p className="text-gray-500 text-sm">Ready to synchronize some magic?</p>
                </div>

                {/* Recent Projects List */}
                <div className="relative z-10 px-12 flex-1 overflow-y-auto">
                    <div className="flex items-center justify-between mb-4 border-b border-white/5 pb-2">
                        <h2 className="text-sm font-bold text-gray-400 uppercase tracking-widest">Recent</h2>
                    </div>

                    {recents.length === 0 ? (
                                        <div className="text-center py-20">
                                            <div className="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-4">
                                                <ClockIcon className="w-10 h-10 text-gray-600" />
                                            </div>
                                            <p className="text-gray-500 font-medium">No recent projects</p>
                                            <p className="text-gray-600 text-sm mt-1">Create a new project to get started</p>
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-20">
                                            {recents.map(proj => {
                                                // Use smartTimeline for segment info (it stores the processed segments)
                                                const segments = (proj as any).smartTimeline?.segments || [];
                                                const segmentCount = segments.length;
                                                const approvedCount = segments.filter((s: any) => s.status === 'approved').length;
                                                const hasProgress = segmentCount > 0;
                                                
                                                return (
                                                    <motion.div
                                                        layoutId={proj.id}
                                                        key={proj.id}
                                                        className="group bg-[#0C0C0E] border border-white/[0.06] hover:border-[#FF0055]/30 rounded-xl overflow-hidden cursor-pointer relative shadow-lg hover:shadow-[#FF0055]/10 transition-all duration-300"
                                                    >
                                                        {/* Action Buttons */}
                                                        <div className="absolute top-2 right-2 z-10 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); setRenameTarget(proj); setRenameInput(proj.name); }}
                                                                className="w-7 h-7 bg-black/60 hover:bg-[#2997FF] backdrop-blur-sm rounded-md flex items-center justify-center transition-all hover:scale-105"
                                                            >
                                                                <PencilIcon className="w-3 h-3 text-white/80" />
                                                            </button>
                                                            <button
                                                                onClick={(e) => { e.stopPropagation(); setDeleteConfirm({ show: true, project: proj }); }}
                                                                className="w-7 h-7 bg-black/60 hover:bg-[#FF0055] backdrop-blur-sm rounded-md flex items-center justify-center transition-all hover:scale-105"
                                                            >
                                                                <TrashIcon className="w-3 h-3 text-white/80" />
                                                            </button>
                                                        </div>

                                                        <div onClick={() => onOpenProject(proj)} className="h-full w-full">
                                                            {/* Thumbnail Area */}
                                                            <div className="aspect-video bg-gradient-to-br from-white/[0.03] to-transparent flex items-center justify-center group-hover:from-[#FF0055]/10 transition-all relative">
                                                                <FilmIcon className="w-10 h-10 text-white/10 group-hover:text-[#FF0055]/30 transition-colors" />
                                                                {hasProgress && (
                                                                    <div className="absolute bottom-2 left-2 right-2">
                                                                        <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                                                                            <div 
                                                                                className="h-full bg-[#FF0055] rounded-full transition-all" 
                                                                                style={{ width: `${(approvedCount / segmentCount) * 100}%` }}
                                                                            />
                                                                        </div>
                                                                    </div>
                                                                )}
                                                            </div>
                                                            
                                                            {/* Info Area */}
                                                            <div className="p-3 border-t border-white/[0.04]">
                                                                <h3 className="text-sm font-semibold text-white truncate group-hover:text-[#FF0055] transition-colors">{proj.name}</h3>
                                                                <div className="flex items-center justify-between mt-1.5">
                                                                    <span className="text-[10px] text-gray-500">{formatDate(proj.lastModified)}</span>
                                                                    {hasProgress && (
                                                                        <span className="text-[10px] text-gray-500">
                                                                            {approvedCount}/{segmentCount} done
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            </div>
                                                        </div>
                                                    </motion.div>
                                                );
                                            })}
                                        </div>
                                    )}
                </div>

                {/* CREATE PROJECT WIZARD MODAL */}
                <AnimatePresence>
                    {showCreateModal && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm"
                            onClick={resetWizard}
                        >
                            <motion.div
                                initial={{ scale: 0.95, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.95, opacity: 0 }}
                                onClick={(e) => e.stopPropagation()}
                                className="relative bg-[#0A0A0A] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden flex flex-col"
                            >
                                {/* Header with Step Indicator */}
                                <div className="p-6 border-b border-white/5">
                                    <div className="flex justify-between items-center mb-4">
                                        <h3 className="text-xl font-bold text-white">New Project</h3>
                                        <button onClick={resetWizard} className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-white/5 text-gray-500 hover:text-white transition-colors">
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                                        </button>
                                    </div>
                                    {/* Step Progress */}
                                    <div className="flex items-center gap-2">
                                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${wizardStep === 1 ? 'bg-[#FF0055] text-white' : wizardStep > 1 ? 'bg-[#FF0055]/20 text-[#FF0055]' : 'bg-white/5 text-gray-500'}`}>
                                            <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${wizardStep > 1 ? 'bg-[#FF0055] text-white' : ''}`}>
                                                {wizardStep > 1 ? '✓' : '1'}
                                            </span>
                                            Name
                                        </div>
                                        <div className={`w-8 h-0.5 ${wizardStep > 1 ? 'bg-[#FF0055]/50' : 'bg-white/10'}`} />
                                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${wizardStep === 2 ? 'bg-[#FF0055] text-white' : wizardStep > 2 ? 'bg-[#FF0055]/20 text-[#FF0055]' : 'bg-white/5 text-gray-500'}`}>
                                            <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] ${wizardStep > 2 ? 'bg-[#FF0055] text-white' : ''}`}>
                                                {wizardStep > 2 ? '✓' : '2'}
                                            </span>
                                            Audio
                                        </div>
                                        <div className={`w-8 h-0.5 ${wizardStep > 2 ? 'bg-[#FF0055]/50' : 'bg-white/10'}`} />
                                        <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${wizardStep === 3 ? 'bg-[#FF0055] text-white' : 'bg-white/5 text-gray-500'}`}>
                                            <span>3</span>
                                            Script
                                        </div>
                                    </div>
                                </div>

                                {/* Steps */}
                                <div className="p-8 min-h-[320px] flex flex-col">
                                    {wizardStep === 1 && (
                                        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col gap-4">
                                            <div>
                                                <label className="block text-sm font-medium text-gray-400 mb-2">What should we call this project?</label>
                                                <input
                                                    type="text"
                                                    placeholder="e.g., Q4 Product Launch"
                                                    value={newProjectName}
                                                    onChange={(e) => setNewProjectName(e.target.value)}
                                                    className="w-full bg-white/5 border border-white/10 rounded-xl p-4 text-lg text-white placeholder:text-gray-600 focus:border-[#FF0055] focus:ring-1 focus:ring-[#FF0055]/30 outline-none transition-all"
                                                    autoFocus
                                                    onKeyDown={(e) => { if (e.key === 'Enter' && newProjectName) setWizardStep(2); }}
                                                />
                                            </div>
                                            <p className="text-xs text-gray-500">Press Enter to continue</p>
                                        </motion.div>
                                    )}

                                    {wizardStep === 2 && (
                                        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col gap-4">
                                            <label className="block text-sm font-medium text-gray-400">Upload your voiceover audio</label>
                                            <div
                                                className={`relative border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer transition-all group ${(audioFilePath || audioFile) ? 'border-[#FF0055]/40 bg-[#FF0055]/5' : 'border-white/10 hover:border-[#FF0055]/50 hover:bg-white/[0.02]'}`}
                                                onClick={handleNativeFileSelect}
                                            >
                                                <input
                                                    type="file"
                                                    accept="audio/*"
                                                    className="hidden"
                                                    ref={fileInputRef}
                                                    onChange={handleFileSelect}
                                                />
                                                {(audioFilePath || audioFile) ? (
                                                    <div className="text-center">
                                                        <div className="w-14 h-14 rounded-full bg-[#FF0055]/20 flex items-center justify-center mx-auto mb-3">
                                                            <svg className="w-6 h-6 text-[#FF0055]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                                        </div>
                                                        <p className="text-white font-semibold mb-1">{audioFileName || audioFile?.name}</p>
                                                        <p className="text-xs text-gray-500">
                                                            {((audioFileSize || audioFile?.size || 0) / 1024 / 1024).toFixed(2)} MB
                                                        </p>
                                                        <button className="mt-3 text-xs text-[#FF0055] hover:underline">Change file</button>
                                                    </div>
                                                ) : (
                                                    <div className="text-center">
                                                        <div className="w-14 h-14 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-3 group-hover:scale-105 group-hover:bg-[#FF0055]/10 transition-all">
                                                            <ArrowUpTrayIcon className="w-6 h-6 text-gray-400 group-hover:text-[#FF0055] transition-colors" />
                                                        </div>
                                                        <p className="text-white font-medium mb-1">Click to browse files</p>
                                                        <p className="text-xs text-gray-500">MP3, WAV, AAC, M4A, OGG, FLAC</p>
                                                    </div>
                                                )}
                                            </div>
                                        </motion.div>
                                    )}

                                    {wizardStep === 3 && (
                                        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="flex-1 flex flex-col gap-3">
                                            <div className="flex items-center justify-between">
                                                <label className="block text-sm font-medium text-gray-400">Paste your script</label>
                                                <span className="text-xs text-gray-600">{scriptText.length > 0 ? `${scriptText.split(/\s+/).filter(Boolean).length} words` : ''}</span>
                                            </div>
                                            <textarea
                                                placeholder="Paste your script text here. This will be used to align with the audio and find matching B-roll footage..."
                                                value={scriptText}
                                                onChange={(e) => setScriptText(e.target.value)}
                                                className="w-full flex-1 bg-white/5 border border-white/10 rounded-xl p-4 text-sm text-gray-300 placeholder:text-gray-600 focus:border-[#FF0055] focus:ring-1 focus:ring-[#FF0055]/30 outline-none transition-all resize-none leading-relaxed"
                                                autoFocus
                                            />
                                        </motion.div>
                                    )}
                                </div>

                                {/* Footer Actions */}
                                <div className="p-6 border-t border-white/5 flex justify-between items-center bg-black/20">
                                    <button 
                                        onClick={() => wizardStep > 1 ? setWizardStep(prev => prev - 1) : resetWizard()} 
                                        className="flex items-center gap-2 px-4 py-2.5 text-sm text-gray-400 hover:text-white hover:bg-white/5 rounded-lg transition-all"
                                    >
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
                                        {wizardStep > 1 ? 'Back' : 'Cancel'}
                                    </button>

                                    {wizardStep < 3 ? (
                                        <button
                                            onClick={() => {
                                                if (wizardStep === 1 && newProjectName) setWizardStep(2);
                                                if (wizardStep === 2 && (audioFile || audioFilePath)) setWizardStep(3);
                                            }}
                                            disabled={
                                                (wizardStep === 1 && !newProjectName) ||
                                                (wizardStep === 2 && !audioFile && !audioFilePath)
                                            }
                                            className="flex items-center gap-2 px-6 py-2.5 bg-white/10 hover:bg-white/15 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg font-semibold transition-all"
                                        >
                                            Continue
                                            <ChevronRightIcon className="w-4 h-4" />
                                        </button>
                                    ) : (
                                        <button
                                            onClick={handleCreateConfirm}
                                            disabled={!scriptText}
                                            className="flex items-center gap-2 px-6 py-2.5 bg-[#FF0055] hover:bg-[#FF1F69] disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-lg font-bold shadow-[0_0_20px_rgba(255,0,85,0.35)] hover:shadow-[0_0_25px_rgba(255,0,85,0.5)] transition-all"
                                        >
                                            Create Project
                                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                                        </button>
                                    )}
                                </div>
                            </motion.div>
                        </div>
                    )}
                </AnimatePresence>

                {/* Rename Modal (Simplified) */}
                <AnimatePresence>
                    {renameTarget && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center p-6 bg-black/80 backdrop-blur-sm"
                            onClick={() => setRenameTarget(null)}>
                            {/* ... Content same as before but minimal ... */}
                            <motion.div initial={{ scale: 0.9 }} animate={{ scale: 1 }} className="bg-[#0A0A0A] p-6 rounded-xl border border-white/10 w-full max-w-sm" onClick={e => e.stopPropagation()}>
                                <h3 className="text-white font-bold mb-4">Rename Project</h3>
                                <input value={renameInput} onChange={e => setRenameInput(e.target.value)} className="w-full bg-white/5 p-3 rounded-lg text-white mb-4 border border-white/10 outline-none focus:border-[#2997FF]" autoFocus />
                                <div className="flex justify-end gap-2">
                                    <button onClick={() => setRenameTarget(null)} className="px-4 py-2 text-gray-400 text-sm">Cancel</button>
                                    <button onClick={() => { if (onRename && renameInput) { onRename(renameTarget.id, renameInput); setRenameTarget(null); } }} className="px-4 py-2 bg-[#2997FF] text-white rounded-lg text-sm font-bold">Save</button>
                                </div>
                            </motion.div>
                        </div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
};
