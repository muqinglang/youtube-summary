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

/** What a section is made of. English keys keep the model's output stable across UI languages. */
export type SectionKind = 'concept' | 'example' | 'demo' | 'filler' | 'promo';

export interface OutlineEntry {
  title: string;
  start: number;
  /** 1 (skippable) to 5 (dense). Drives the "只看干货" playback filter. */
  density: number;
  kind: SectionKind;
}

/** Whether this video is worth someone's time, and how to spend it. */
export interface OutlineVerdict {
  topic: string;
  audience: string;
  /** What a viewer should already know; empty when none is needed. */
  prerequisites: string;
  advice: string;
}

export interface Outline {
  sections: OutlineEntry[];
  verdict?: OutlineVerdict;
}

/** Something the video assumes you know. English keys keep model output stable across languages. */
export type TermKind = 'concept' | 'person' | 'tool' | 'work' | 'term';

export interface GlossaryTerm {
  term: string;
  kind: TermKind;
  meaning: string;
  /** Where it first appears, so the list doubles as navigation. */
  start: number;
}
export interface Glossary {
  terms: GlossaryTerm[];
}

/** A line the viewer kept, with whatever they wanted to say about it. */
export interface Clip {
  id: string;
  start: number;
  text: string;
  translation: string;
  comment: string;
  createdAt: string;
  /** Absent on notes kept before the list could show every video at once. */
  videoId?: string;
  videoTitle?: string;
}

/** What a dictionary lists under a word, alongside how this video uses it. */
export interface WordSense {
  /** A short part-of-speech tag: n. / v. / adj. / adv. / phrase. */
  pos: string;
  /** The meaning in the language the viewer reads in. */
  gloss: string;
  /** The meaning in the word's own language. */
  definition: string;
  example: string;
  exampleTranslation: string;
}

/** What the viewer asked to have explained: a word, a whole subtitle line, or a marked term. */
export type ExplainMode = 'term' | 'word' | 'sentence';

/** One term explained on demand, from the cues around where the viewer selected it. */
export interface Explanation {
  term: string;
  kind: TermKind;
  /** Always present: what it means here, in this video, which a dictionary cannot tell you. */
  meaning: string;
  /** IPA, for a word the viewer tapped. Empty for a phrase, a name or a whole line. */
  phonetic?: string;
  senses?: WordSense[];
}

/** A question to hold in mind before watching, plus where the video answers it. */
export interface GuideQuestion {
  question: string;
  start: number;
  answer: string;
}
export interface Guide {
  questions: GuideQuestion[];
}

export interface Answer {
  text: string;
  citations: { start: number; label: string }[];
}

/** One earlier question in a conversation, with the answer that was shown for it. */
export interface ChatTurn {
  question: string;
  answer: string;
}

export type AiProvider =
  | 'openai'
  | 'deepseek'
  | 'anthropic'
  | 'opencode'
  | 'opencode-go'
  | 'custom';

/** One retrieved passage from another video in the account's library. */
export interface LibraryMatch {
  videoId: string;
  title: string;
  author: string;
  url: string;
  start: number;
  end: number;
  text: string;
  /** Cosine similarity; comparable within one result list, not across embedding models. */
  score: number;
}

/** Where jobs run: `byok` calls the provider from this browser, `hosted` calls our server. */
export type RunMode = 'byok' | 'hosted';

export interface Settings {
  mode: RunMode;
  /** Hosted service origin. Restricted to the manifest's allow-list, never a free-form URL. */
  serverUrl: string;
  /** Bearer session for the hosted service. Secret, and never handed to the panel. */
  sessionToken: string;
  accountEmail: string;
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

/** Credentials never leave the extension service worker for the panel. */
export type PublicSettings = Omit<Settings, 'apiKey' | 'sessionToken'> & {
  hasApiKey: boolean;
  hasSession: boolean;
};

export type DisplayMode = 'bilingual' | 'original' | 'translated';

export type PlayerCommand =
  | { action: 'seek'; time: number }
  | { action: 'togglePlay' }
  | { action: 'pause' }
  | { action: 'speed'; speed: number }
  | {
      action: 'overlay';
      original: string;
      translated: string;
      visible: boolean;
      /**
       * Which rows this mode uses at all. The overlay reserves their height from this rather
       * than from whether text happens to be present, so the block keeps a constant height
       * between cues and while a translation is still being fetched — otherwise the player
       * directly above it moves on almost every cue.
       */
      mode: DisplayMode;
      /** False when the viewer turned captions off, which collapses the block entirely. */
      enabled: boolean;
      /** When the cue is spoken, so one too long for its rows can be shown a piece at a time. */
      start: number;
      end: number;
    }
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
  | { task: 'guide'; video: VideoInfo; transcript: Transcript; language: string }
  | { task: 'glossary'; video: VideoInfo; transcript: Transcript; language: string }
  | {
      task: 'explain';
      video: VideoInfo;
      /** Only the cues around the selection: an explanation does not need the whole video. */
      transcript: Transcript;
      term: string;
      /** Absent means a marked glossary term, as before word and sentence lookup existed. */
      mode?: ExplainMode;
      language: string;
    }
  | { task: 'translate'; transcript: Transcript; language: string }
  | {
      task: 'ask';
      video: VideoInfo;
      transcript: Transcript;
      question: string;
      /** Earlier turns, oldest first, so a follow-up question can refer back to them. */
      history?: ChatTurn[];
      language: string;
    };

/** `notice` reports partial coverage: work that succeeded is returned with what was missed. */
export type AiResult =
  | { task: 'summarize'; summary: Summary; notice?: string }
  | { task: 'outline'; outline: Outline; notice?: string }
  | { task: 'guide'; guide: Guide; notice?: string }
  | { task: 'glossary'; glossary: Glossary; notice?: string }
  | { task: 'explain'; explanation: Explanation; notice?: string }
  | { task: 'translate'; translations: Record<string, string>; notice?: string }
  | { task: 'ask'; answer: Answer; notice?: string };

export interface AccountSummary {
  email: string;
  jobsToday: number;
  dailyJobLimit: number;
}

export type RuntimeRequest =
  | { type: 'learning:open' }
  | { type: 'tab:id' }
  | { type: 'settings:get' }
  | { type: 'settings:save'; settings: Partial<Settings> }
  | { type: 'settings:clearKey' }
  | { type: 'ai:test' }
  | { type: 'account:signIn' }
  | { type: 'account:signOut' }
  | { type: 'account:status' }
  | { type: 'library:search'; query: string; limit?: number }
  | { type: 'sync:get'; key: string }
  | { type: 'sync:put'; key: string; value: unknown; updatedAt: number }
  | { type: 'ai:run'; jobId: string; request: AiRequest }
  | { type: 'ai:cancel'; jobId: string }
  | { type: 'video:get'; tabId: number }
  | {
      type: 'transcript:get';
      tabId: number;
      trackId?: string;
      /** Lets the worker read the captions from the player's own URL if the page cannot. */
      videoId?: string;
    }
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
