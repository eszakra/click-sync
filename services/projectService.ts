
import { v4 as uuidv4 } from 'uuid';

export interface ProjectData {
    id: string;
    name: string;
    lastModified: number;
    scriptText: string;
    audioPath?: string;
    audioName?: string;
    scriptSummary?: string | null;
    procState?: any; // ProcessingState
    storyBlocks?: any[]; // StoryBlock[]
    smartTimeline?: any[]; // Timeline with video data
    timeline?: any[]; // Alias for backward compatibility
    storagePath?: string;
    logs?: string[];
}

// Check if window.electron (IPC) is available
const hasElectronAPI = typeof window !== 'undefined' && (window as any).electron;

// Fallback to localStorage if not in Electron
const storage = {
    async getItem(key: string): Promise<string | null> {
        if (hasElectronAPI) {
            try {
                return await (window as any).electron.storage.get(key);
            } catch (e) {
                console.error('Electron storage get failed:', e);
                return localStorage.getItem(key);
            }
        }
        return localStorage.getItem(key);
    },

    async setItem(key: string, value: string): Promise<void> {
        if (hasElectronAPI) {
            try {
                await (window as any).electron.storage.set(key, value);
            } catch (e) {
                console.error('Electron storage set failed:', e);
                localStorage.setItem(key, value);
            }
        } else {
            localStorage.setItem(key, value);
        }
    },

    async removeItem(key: string): Promise<void> {
        if (hasElectronAPI) {
            try {
                await (window as any).electron.storage.remove(key);
            } catch (e) {
                console.error('Electron storage remove failed:', e);
                localStorage.removeItem(key);
            }
        } else {
            localStorage.removeItem(key);
        }
    }
};

const STORAGE_KEY_RECENT = 'clicksync_recent_projects';
const STORAGE_KEY_CURRENT = 'clicksync_current_session';

export const projectService = {
    // Save the current active session (Auto-save) AND Full Project File
    saveSession: async (data: Partial<ProjectData>) => {
        try {
            // 1. Get current session to merge
            const current = await storage.getItem(STORAGE_KEY_CURRENT);
            const prev = current ? JSON.parse(current) : {};
            const session = { ...prev, ...data, lastModified: Date.now() };

            // 2. Save to "Current Session" (Scratchpad for app restart)
            await storage.setItem(STORAGE_KEY_CURRENT, JSON.stringify(session));

            // 3. Save to "Project File" (Permanent Storage)
            // This ensures that even if session is cleared, the project data exists on disk
            if (session.id) {
                const projectKey = `project_${session.id}`;
                await storage.setItem(projectKey, JSON.stringify(session));
                await projectService.updateRecentList(session);
            }
        } catch (e) {
            console.error("Failed to save session", e);
        }
    },

    // Load the last active session
    loadSession: async (): Promise<ProjectData | null> => {
        try {
            const current = await storage.getItem(STORAGE_KEY_CURRENT);
            return current ? JSON.parse(current) : null;
        } catch (e) {
            return null;
        }
    },

    // Get list of recent projects
    getRecentProjects: async (): Promise<ProjectData[]> => {
        try {
            const list = await storage.getItem(STORAGE_KEY_RECENT);
            return list ? JSON.parse(list) : [];
        } catch (e) {
            return [];
        }
    },

    // Update the recent projects list
    updateRecentList: async (project: ProjectData) => {
        try {
            const list = await projectService.getRecentProjects();
            const filtered = list.filter(p => p.id !== project.id);
            // Save metadata ONLY for the list (keep it light)
            filtered.unshift({
                id: project.id,
                name: project.name || "Untitled Project",
                lastModified: project.lastModified,
                scriptText: project.scriptText ? project.scriptText.substring(0, 100) : "",
                audioName: project.audioName,
                // Do NOT save storyBlocks here to keep list.json small
            });
            const trimmed = filtered.slice(0, 10);
            await storage.setItem(STORAGE_KEY_RECENT, JSON.stringify(trimmed));
        } catch (e) {
            console.error("Failed to update recent list", e);
        }
    },

    // Create a new project structure
    createNew: (): ProjectData => {
        return {
            id: uuidv4(),
            name: `New Project`,
            lastModified: Date.now(),
            scriptText: '',
            storyBlocks: []
        };
    },

    // Clear active session (on explicit close or new project)
    clearSession: async () => {
        await storage.removeItem(STORAGE_KEY_CURRENT);
    },

    // Load a specific project from the list into the active session
    openProject: async (project: ProjectData) => {
        // Try to load full data from project file first
        let fullProject = project;
        try {
            const projectKey = `project_${project.id}`;
            const storedData = await storage.getItem(projectKey);
            if (storedData) {
                fullProject = JSON.parse(storedData);
                console.log(`[ProjectService] Loaded full data for ${project.id}`);
            } else {
                console.warn(`[ProjectService] No full data found for ${project.id}, using metadata`);
            }
        } catch (e) {
            console.error("Failed to load project file", e);
        }

        await storage.setItem(STORAGE_KEY_CURRENT, JSON.stringify(fullProject));
        return fullProject;
    },

    // Rename a project
    renameProject: async (id: string, newName: string) => {
        try {
            const projectKey = `project_${id}`;
            const dataStr = await storage.getItem(projectKey);
            if (dataStr) {
                const data = JSON.parse(dataStr);
                const updated = { ...data, name: newName, lastModified: Date.now() };
                await storage.setItem(projectKey, JSON.stringify(updated));
                await projectService.updateRecentList(updated);

                // If this is the current session, update that too
                const current = await storage.getItem(STORAGE_KEY_CURRENT);
                if (current) {
                    const currentData = JSON.parse(current);
                    if (currentData.id === id) {
                        await storage.setItem(STORAGE_KEY_CURRENT, JSON.stringify({ ...currentData, name: newName }));
                    }
                }
            }
        } catch (e) {
            console.error("Failed to rename project", e);
        }
    },

    // Delete a project from recent list and disk
    deleteProject: async (projectId: string) => {
        try {
            const list = await projectService.getRecentProjects();
            const filtered = list.filter(p => p.id !== projectId);
            await storage.setItem(STORAGE_KEY_RECENT, JSON.stringify(filtered));

            // Remove the full project file
            await storage.removeItem(`project_${projectId}`);

            // If we're deleting the current session, clear it
            const current = await projectService.loadSession();
            if (current && current.id === projectId) {
                await projectService.clearSession();
            }
        } catch (e) {
            console.error("Failed to delete project", e);
        }
    }
};
