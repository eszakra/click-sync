export interface Segment {
  id: string;
  title: string;
  contentSnippet: string;
  startTime: number;
  endTime: number;
  duration: number;
  blobUrl?: string; // URL for the sliced audio blob
  isReady: boolean;
}

export interface ProcessingStatus {
  step: 'idle' | 'uploading' | 'analyzing' | 'slicing' | 'complete' | 'error';
  message: string;
}

export interface GeminiSegmentResponse {
  segments: {
    title: string;
    start_time: number;
    end_time: number;
  }[];
}