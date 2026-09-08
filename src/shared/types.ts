export interface Cue {
  id: string;
  start: number;
  end: number;
  text: string;
}

export interface CaptionTrack {
  id: string;
  language: string;
  name: string;
  automatic: boolean;
}

export interface VideoInfo {
  id: string;
  title: string;
  author: string;
  url: string;
  duration: number;
  currentTime: number;
  paused: boolean;
  tracks: CaptionTrack[];
  chapters?: VideoChapter[];
}

export interface VideoChapter {
  title: string;
  start: number;
}

export interface LearningPreferences {
  overlayEnabled: boolean;
  busy: boolean;
}

export interface Transcript {
  videoId: string;
  language: string;
  source: 'youtube' | 'import';
  coverage: 'complete' | 'unknown';
  cues: Cue[];
}

export interface SummarySection {
  title: string;
  start: number;
  points: string[];
}

export interface MindMapNode {
  title: string;
  start?: number;
  children?: MindMapNode[];
}

export interface Summary {
  title: string;
  overview: string;
  sections: SummarySection[];
  takeaways: string[];
  /** Legacy field. The exported and displayed map is derived from the summary content instead. */
  mindmap?: MindMapNode;
}

export interface OutlineEntry {
  title: string;
  start: number;
}

export interface Outline {
  sections: OutlineEntry[];
}

export interface Answer {
  text: string;
  citations: { start: number; label: string }[];
}

export type AiProvider = 'openai' | 'deepseek' | 'anthropic' | 'custom';

export interface Settings {
  provider: AiProvider;
  baseUrl: string;
  model: string;
  apiKey: string;
  rememberKey: boolean;
  translationEngine: 'auto' | 'google' | 'ai';
  autoTranslate: boolean;
  targetLanguage: string;
  prompt: string;
  temperature: number;
}

/** API keys never leave the extension service worker for the panel. */
export type PublicSettings = Omit<Settings, 'apiKey'> & { hasApiKey: boolean };

export type PlayerCommand =
  | { action: 'seek'; time: number }
  | { action: 'togglePlay' }
  | { action: 'pause' }
  | { action: 'speed'; speed: number }
  | { action: 'overlay'; original: string; translated: string; visible: boolean }
  | { action: 'close' };

export interface JobProgress {
  jobId: string;
  completed: number;
  total: number;
  label: string;
}

export type AiRequest =
  | {
      task: 'summarize';
      video: VideoInfo;
      transcript: Transcript;
      prompt: string;
      language: string;
    }
  | { task: 'outline'; video: VideoInfo; transcript: Transcript; language: string }
  | { task: 'translate'; transcript: Transcript; language: string }
  | { task: 'ask'; video: VideoInfo; transcript: Transcript; question: string; language: string };

/** `notice` reports partial coverage: work that succeeded is returned with what was missed. */
export type AiResult =
  | { task: 'summarize'; summary: Summary; notice?: string }
  | { task: 'outline'; outline: Outline; notice?: string }
  | { task: 'translate'; translations: Record<string, string>; notice?: string }
  | { task: 'ask'; answer: Answer; notice?: string };

export type RuntimeRequest =
  | { type: 'learning:open' }
  | { type: 'tab:id' }
  | { type: 'settings:get' }
  | { type: 'settings:save'; settings: Partial<Settings> }
  | { type: 'settings:clearKey' }
  | { type: 'ai:test' }
  | { type: 'ai:run'; jobId: string; request: AiRequest }
  | { type: 'ai:cancel'; jobId: string }
  | { type: 'video:get'; tabId: number }
  | { type: 'transcript:get'; tabId: number; trackId?: string }
  | { type: 'player:command'; tabId: number; command: PlayerCommand }
  | { type: 'export:print'; video: VideoInfo; summary: Summary; prompt: string };

export type RuntimeEvent =
  | { type: 'video:update'; tabId: number; video: VideoInfo }
  | { type: 'ai:progress'; progress: JobProgress };

export type Reply<T> = { ok: true; data: T } | { ok: false; error: string };

export interface ExportDocument {
  video: VideoInfo;
  summary: Summary;
  prompt: string;
  createdAt: string;
}
