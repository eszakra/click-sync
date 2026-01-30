/// <reference types="vite/client" />

// Type declarations for Electron API
declare global {
  interface Window {
    electron?: {
      invoke: (channel: string, ...args: any[]) => Promise<any>;
      on: (channel: string, func: (...args: any[]) => void) => () => void;
      removeAllListeners: (channel: string) => void;
      receive?: (channel: string, func: (...args: any[]) => void) => void;
      tray?: {
        updateProgress: (data: any) => void;
      };
      storage?: {
        get: (key: string) => Promise<string | null>;
        set: (key: string, value: string) => Promise<void>;
        remove: (key: string) => Promise<void>;
      };
      segmentOverlays?: {
        videoAssigned: (segmentIndex: number, segmentData: any) => Promise<any>;
        batchUpdate: (segments: any[]) => Promise<any>;
        getStatus: () => Promise<any>;
        clear: () => Promise<any>;
        reRender: (segmentIndex: number) => Promise<any>;
        onRenderStarted: (callback: (data: any) => void) => () => void;
        onRenderComplete: (callback: (data: any) => void) => () => void;
        onRenderError: (callback: (data: any) => void) => () => void;
      };
    };
    electronAPI?: {
      getAppVersion: () => Promise<string>;
      getAppPath: () => Promise<string>;
      isElectron: boolean;
      platform: string;
      minimize: () => void;
      maximize: () => void;
      close: () => void;
    };
  }
}

export {};
