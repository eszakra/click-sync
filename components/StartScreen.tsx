import React, { useState, useEffect } from 'react';
import { PlusIcon, TrashIcon, FilmIcon, ClockIcon, PencilIcon } from '@heroicons/react/24/solid';
import { AnimatePresence, motion } from 'framer-motion';
import { ProjectData, projectService } from '../services/projectService';

interface StartScreenProps {
    recents: ProjectData[];
    onNewProject: (name?: string) => void; // Updated signature
    onOpenProject: (proj: ProjectData) => void;
    onDeleteProject: (id: string) => void;
    onResumeSession?: () => void;
    resumeProject?: ProjectData | null;
    onRename?: (id: string, newName: string) => void;
}

export const StartScreen: React.FC<StartScreenProps> = ({
    recents,
    onNewProject,
    onOpenProject,
    onDeleteProject,
    onResumeSession,
    resumeProject,
    onRename
}) => {
    const [deleteConfirm, setDeleteConfirm] = React.useState<{ show: boolean; project: ProjectData | null }>({ show: false, project: null });
    const [showResumeParams, setShowResumeParams] = React.useState(false);

    // NEW PROJECT STATE
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [newProjectName, setNewProjectName] = useState("");

    const handleCreateConfirm = () => {
        onNewProject(newProjectName.trim() || undefined);
        setShowCreateModal(false);
        setNewProjectName("");
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

    return (
        <div className="min-h-screen bg-[#050505] flex text-white font-sans selection:bg-[#FF0055] selection:text-white overflow-hidden">

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
            <div className="w-64 bg-[#09090b] border-r border-white/5 flex flex-col p-6 gap-8 z-20 shadow-2xl">
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

                <div className="text-[10px] text-gray-600 font-mono">
                    v1.0.0 Unified Studio
                </div>
            </div>

            {/* MAIN CONTENT AREA */}
            <div className="flex-1 relative flex flex-col">
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
                        <div className="text-center py-20 opacity-30">
                            <ClockIcon className="w-16 h-16 text-gray-500 mx-auto mb-4" />
                            <p className="text-gray-400">No recent projects found.</p>
                        </div>
                    ) : (
                        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 pb-20">
                            {recents.map(proj => (
                                <motion.div
                                    layoutId={proj.id}
                                    key={proj.id}
                                    className="group aspect-[4/3] bg-[#09090b] border border-white/5 hover:border-[#FF0055]/30 rounded-xl overflow-hidden cursor-pointer relative shadow-lg hover:shadow-[#FF0055]/10 hover:-translate-y-1 transition-all duration-300"
                                >
                                    {/* Rename Button (Pencil) */}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            // Trigger Rename Logic
                                            setRenameTarget(proj);
                                            setRenameInput(proj.name);
                                        }}
                                        className="absolute top-3 right-12 z-10 w-7 h-7 bg-black/40 hover:bg-[#2997FF]/90 backdrop-blur-sm rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:scale-110"
                                        title="Rename project"
                                    >
                                        <PencilIcon className="w-3.5 h-3.5 text-white/70" />
                                    </button>

                                    {/* Delete Button - Subtle dark theme */}
                                    <button
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setDeleteConfirm({ show: true, project: proj });
                                        }}
                                        className="absolute top-3 right-3 z-10 w-7 h-7 bg-black/40 hover:bg-[#FF0055]/90 backdrop-blur-sm rounded-lg flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:scale-110"
                                        title="Delete project"
                                    >
                                        <TrashIcon className="w-3.5 h-3.5 text-white/70" />
                                    </button>

                                    <div onClick={() => onOpenProject(proj)} className="h-full w-full">
                                        {/* Thumbnail - Full height, only icon centered */}
                                        <div className="h-full w-full bg-gradient-to-br from-white/5 to-white/[0.02] flex items-center justify-center group-hover:from-[#FF0055]/10 group-hover:to-[#FF0055]/5 transition-all">
                                            <FilmIcon className="w-12 h-12 text-white/20 group-hover:text-[#FF0055]/40 transition-colors" />
                                        </div>
                                        {/* Info - Overlayed at the bottom */}
                                        <div className="absolute bottom-0 left-0 right-0 p-4 flex flex-col justify-center bg-gradient-to-t from-[#111]/90 to-transparent">
                                            <h3 className="text-sm font-bold text-white truncate group-hover:text-[#FF0055] transition-colors">{proj.name}</h3>
                                            <p className="text-[10px] text-gray-500 flex items-center gap-2 mt-1">
                                                <span>{formatDate(proj.lastModified)}</span>
                                                {proj.audioName && <span className="w-1 h-1 rounded-full bg-gray-600" />}
                                                {proj.audioName && <span className="truncate max-w-[100px]">{proj.audioName}</span>}
                                            </p>
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    )}
                </div>

                {/* RENAME MODAL */}
                <AnimatePresence>
                    {renameTarget && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                                onClick={() => setRenameTarget(null)}
                            />
                            <motion.div
                                initial={{ scale: 0.95, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.95, opacity: 0 }}
                                className="relative bg-[#0A0A0A] border border-white/10 p-6 rounded-2xl w-full max-w-sm shadow-2xl"
                            >
                                <h3 className="text-lg font-bold text-white mb-4">Rename Project</h3>
                                <input
                                    type="text"
                                    value={renameInput}
                                    onChange={(e) => setRenameInput(e.target.value)}
                                    className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white mb-4 focus:border-[#2997FF] outline-none"
                                    autoFocus
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            if (renameInput.trim()) {
                                                projectService.renameProject(renameTarget.id, renameInput.trim()).then(() => {
                                                    setRenameTarget(null);
                                                    if (onRename) onRename(renameTarget.id, renameInput.trim());
                                                });
                                            }
                                        }
                                    }}
                                />
                                <div className="flex justify-end gap-3">
                                    <button
                                        onClick={() => setRenameTarget(null)}
                                        className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={() => {
                                            if (renameInput.trim()) {
                                                if (onRename) {
                                                    onRename(renameTarget.id, renameInput.trim());
                                                    setRenameTarget(null);
                                                }
                                            }
                                        }}
                                        className="px-4 py-2 text-sm bg-[#2997FF] hover:bg-[#2997FF]/80 text-white rounded-lg font-bold"
                                    >
                                        Save
                                    </button>
                                </div>
                            </motion.div>
                        </div>
                    )}
                </AnimatePresence>

                {/* CREATE PROJECT MODAL */}
                <AnimatePresence>
                    {showCreateModal && (
                        <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="absolute inset-0 bg-black/80 backdrop-blur-sm"
                                onClick={() => setShowCreateModal(false)}
                            />
                            <motion.div
                                initial={{ scale: 0.95, opacity: 0 }}
                                animate={{ scale: 1, opacity: 1 }}
                                exit={{ scale: 0.95, opacity: 0 }}
                                className="relative bg-[#0A0A0A] border border-white/10 p-6 rounded-2xl w-full max-w-sm shadow-2xl"
                            >
                                <h3 className="text-lg font-bold text-white mb-4">New Project</h3>
                                <div className="mb-4">
                                    <label className="block text-xs font-bold text-gray-500 uppercase tracking-widest mb-2">Project Name</label>
                                    <input
                                        type="text"
                                        placeholder="New Project"
                                        value={newProjectName}
                                        onChange={(e) => setNewProjectName(e.target.value)}
                                        className="w-full bg-white/5 border border-white/10 rounded-lg p-3 text-white focus:border-[#FF0055] outline-none transition-colors placeholder-gray-600"
                                        autoFocus
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter') handleCreateConfirm();
                                        }}
                                    />
                                </div>
                                <div className="flex justify-end gap-3">
                                    <button
                                        onClick={() => setShowCreateModal(false)}
                                        className="px-4 py-2 text-sm text-gray-400 hover:text-white"
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        onClick={handleCreateConfirm}
                                        className="px-4 py-2 text-sm bg-[#FF0055] hover:bg-[#FF1F69] text-white rounded-lg font-bold shadow-[0_0_15px_rgba(255,0,85,0.3)]"
                                    >
                                        Create Project
                                    </button>
                                </div>
                            </motion.div>
                        </div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
};
