// projectManager.js - Manages project state isolation
// Each project has its own isolated state to prevent cross-contamination

import path from 'path';
import fs from 'fs';
import os from 'os';
import { EventEmitter } from 'events';

const PROJECTS_DIR = path.join(os.homedir(), 'ClickStudio', 'projects');

// Ensure projects directory exists
if (!fs.existsSync(PROJECTS_DIR)) {
    fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

/**
 * Project State
 * Contains all data for a single project
 */
class ProjectState {
    constructor(projectId, projectData = {}) {
        this.id = projectId;
        this.name = projectData.name || 'Untitled Project';
        this.createdAt = projectData.createdAt || Date.now();
        this.updatedAt = projectData.updatedAt || Date.now();
        
        // Timeline data
        this.timelineSegments = projectData.timelineSegments || [];
        this.skipRequests = new Map(); // segmentIndex -> boolean
        this.recentlyUsedVideos = []; // [{ url, segmentIndex }]
        
        // Editor state
        this.editorState = projectData.editorState || {
            currentTime: 0,
            selectedSegmentIndex: null,
            viewMode: 'timeline',
            isPlaying: false
        };
        
        // Export state
        this.exportState = projectData.exportState || {
            lastExportPath: null,
            lastExportTime: null
        };
        
        // Recovery state
        this.recoveryState = projectData.recoveryState || {
            lastSaveTime: null,
            isDirty: false
        };
    }
    
    /**
     * Get segment by index
     */
    getSegment(index) {
        return this.timelineSegments[index] || null;
    }
    
    /**
     * Update segment
     */
    updateSegment(index, updates) {
        if (this.timelineSegments[index]) {
            this.timelineSegments[index] = {
                ...this.timelineSegments[index],
                ...updates
            };
            this.updatedAt = Date.now();
            this.recoveryState.isDirty = true;
            return true;
        }
        return false;
    }
    
    /**
     * Set all segments
     */
    setSegments(segments) {
        this.timelineSegments = segments;
        this.updatedAt = Date.now();
        this.recoveryState.isDirty = true;
    }
    
    /**
     * Check if should skip segment
     */
    shouldSkipSegment(segmentIndex) {
        return this.skipRequests.has(segmentIndex) && this.skipRequests.get(segmentIndex) === true;
    }
    
    /**
     * Set skip request
     */
    setSkipRequest(segmentIndex, shouldSkip) {
        this.skipRequests.set(segmentIndex, shouldSkip);
        this.updatedAt = Date.now();
    }
    
    /**
     * Check if video was recently used
     */
    isVideoRecentlyUsed(url, currentSegmentIndex, gap = 6) {
        if (!url) return false;
        
        for (const entry of this.recentlyUsedVideos) {
            if (entry.url === url) {
                const distance = currentSegmentIndex - entry.segmentIndex;
                if (distance < gap && distance > 0) {
                    return true;
                }
            }
        }
        return false;
    }
    
    /**
     * Mark video as used
     */
    markVideoAsUsed(url, segmentIndex) {
        // Remove old entries for this URL
        this.recentlyUsedVideos = this.recentlyUsedVideos.filter(e => e.url !== url);
        // Add new entry
        this.recentlyUsedVideos.push({ url, segmentIndex });
        // Keep only last 20 entries
        if (this.recentlyUsedVideos.length > 20) {
            this.recentlyUsedVideos.shift();
        }
        this.updatedAt = Date.now();
    }
    
    /**
     * Save to disk
     */
    save() {
        try {
            const projectPath = path.join(PROJECTS_DIR, `${this.id}.json`);
            const data = {
                id: this.id,
                name: this.name,
                createdAt: this.createdAt,
                updatedAt: this.updatedAt,
                timelineSegments: this.timelineSegments,
                editorState: this.editorState,
                exportState: this.exportState,
                recoveryState: {
                    ...this.recoveryState,
                    lastSaveTime: Date.now(),
                    isDirty: false
                }
            };
            fs.writeFileSync(projectPath, JSON.stringify(data, null, 2));
            return true;
        } catch (e) {
            console.error('[ProjectManager] Failed to save project:', e);
            return false;
        }
    }
    
    /**
     * Load from disk
     */
    static load(projectId) {
        try {
            const projectPath = path.join(PROJECTS_DIR, `${projectId}.json`);
            if (!fs.existsSync(projectPath)) return null;
            
            const data = JSON.parse(fs.readFileSync(projectPath, 'utf8'));
            return new ProjectState(projectId, data);
        } catch (e) {
            console.error('[ProjectManager] Failed to load project:', e);
            return null;
        }
    }
    
    /**
     * Delete from disk
     */
    delete() {
        try {
            const projectPath = path.join(PROJECTS_DIR, `${this.id}.json`);
            if (fs.existsSync(projectPath)) {
                fs.unlinkSync(projectPath);
            }
            return true;
        } catch (e) {
            console.error('[ProjectManager] Failed to delete project:', e);
            return false;
        }
    }
}

/**
 * Project Manager
 * Manages multiple projects with isolated state
 */
class ProjectManager extends EventEmitter {
    constructor() {
        super();
        this.projects = new Map();
        this.currentProjectId = null;
        this.autoSaveInterval = null;
        
        // Start auto-save
        this.startAutoSave();
    }
    
    /**
     * Get current project
     */
    getCurrentProject() {
        if (!this.currentProjectId) return null;
        return this.projects.get(this.currentProjectId);
    }
    
    /**
     * Create new project
     */
    createProject(name = 'Untitled Project') {
        const id = `project_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        const project = new ProjectState(id, { name });
        this.projects.set(id, project);
        this.currentProjectId = id;
        this.emit('projectCreated', { id, project });
        return project;
    }
    
    /**
     * Load project
     */
    loadProject(projectId) {
        // Try to get from memory first
        let project = this.projects.get(projectId);
        
        if (!project) {
            // Load from disk
            project = ProjectState.load(projectId);
            if (project) {
                this.projects.set(projectId, project);
            }
        }
        
        if (project) {
            this.currentProjectId = projectId;
            this.emit('projectLoaded', { id: projectId, project });
        }
        
        return project;
    }
    
    /**
     * Switch to project
     */
    switchProject(projectId) {
        // Save current project first
        const current = this.getCurrentProject();
        if (current) {
            current.save();
        }
        
        // Load or switch to new project
        const project = this.loadProject(projectId);
        if (project) {
            this.emit('projectSwitched', { 
                from: current?.id || null, 
                to: projectId,
                project 
            });
            return project;
        }
        return null;
    }
    
    /**
     * Close current project
     */
    closeCurrentProject() {
        const current = this.getCurrentProject();
        if (current) {
            current.save();
            this.emit('projectClosed', { id: current.id });
        }
        this.currentProjectId = null;
    }
    
    /**
     * Get all projects
     */
    getAllProjects() {
        const projects = [];
        
        // Get from memory
        for (const [id, project] of this.projects) {
            projects.push({
                id,
                name: project.name,
                createdAt: project.createdAt,
                updatedAt: project.updatedAt,
                isCurrent: id === this.currentProjectId
            });
        }
        
        // Get from disk (projects not in memory)
        try {
            const files = fs.readdirSync(PROJECTS_DIR);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const id = file.replace('.json', '');
                    if (!this.projects.has(id)) {
                        const project = ProjectState.load(id);
                        if (project) {
                            projects.push({
                                id: project.id,
                                name: project.name,
                                createdAt: project.createdAt,
                                updatedAt: project.updatedAt,
                                isCurrent: false
                            });
                        }
                    }
                }
            }
        } catch (e) {
            console.error('[ProjectManager] Error reading projects:', e);
        }
        
        return projects.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    
    /**
     * Delete project
     */
    deleteProject(projectId) {
        const project = this.projects.get(projectId);
        if (project) {
            project.delete();
            this.projects.delete(projectId);
            if (this.currentProjectId === projectId) {
                this.currentProjectId = null;
            }
            this.emit('projectDeleted', { id: projectId });
            return true;
        }
        return false;
    }
    
    /**
     * Save recovery state for crash recovery
     */
    saveRecoveryState(projectId, state) {
        try {
            const recoveryPath = path.join(PROJECTS_DIR, `.recovery_${projectId}.json`);
            fs.writeFileSync(recoveryPath, JSON.stringify({
                projectId,
                timestamp: Date.now(),
                state
            }, null, 2));
        } catch (e) {
            console.error('[ProjectManager] Failed to save recovery state:', e);
        }
    }
    
    /**
     * Load recovery state
     */
    loadRecoveryState(projectId) {
        try {
            const recoveryPath = path.join(PROJECTS_DIR, `.recovery_${projectId}.json`);
            if (fs.existsSync(recoveryPath)) {
                const data = JSON.parse(fs.readFileSync(recoveryPath, 'utf8'));
                // Check if recovery is recent (within last 24 hours)
                if (Date.now() - data.timestamp < 24 * 60 * 60 * 1000) {
                    return data.state;
                }
            }
        } catch (e) {
            console.error('[ProjectManager] Failed to load recovery state:', e);
        }
        return null;
    }
    
    /**
     * Clear recovery state
     */
    clearRecoveryState(projectId) {
        try {
            const recoveryPath = path.join(PROJECTS_DIR, `.recovery_${projectId}.json`);
            if (fs.existsSync(recoveryPath)) {
                fs.unlinkSync(recoveryPath);
            }
        } catch (e) {
            console.error('[ProjectManager] Failed to clear recovery state:', e);
        }
    }
    
    /**
     * Start auto-save
     */
    startAutoSave() {
        if (this.autoSaveInterval) return;
        
        this.autoSaveInterval = setInterval(() => {
            const current = this.getCurrentProject();
            if (current && current.recoveryState.isDirty) {
                current.save();
                this.saveRecoveryState(current.id, current);
            }
        }, 30000); // Auto-save every 30 seconds
    }
    
    /**
     * Stop auto-save
     */
    stopAutoSave() {
        if (this.autoSaveInterval) {
            clearInterval(this.autoSaveInterval);
            this.autoSaveInterval = null;
        }
    }
}

// Singleton instance
const projectManager = new ProjectManager();

export default projectManager;
export { ProjectManager, ProjectState, PROJECTS_DIR };
