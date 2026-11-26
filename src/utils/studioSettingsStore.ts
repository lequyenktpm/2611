import type { PromptVideoStyle } from '../engine/aiPromptBuilder';
import type { StudioBgmPresetId } from '../engine/audioMixHelper';
import type {
  CreatorFormatCategory,
  LearningLanguageId,
  ReelCreationMode,
  ReelMode,
} from '../engine/englishReelsEngine';
import type {
  ExportAspectRatioId,
  ExportFpsOption,
  ExportQualityId,
  ExportResolutionId,
} from '../engine/mp4Config';
import type {
  CanvasThemeId,
  LayoutCompositionId,
  WatermarkOutroConfig,
} from '../engine/types';

export interface PersistedEduWatermarkOutro {
  watermarkEnabled: boolean;
  watermarkText: string;
  watermarkCorner: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  watermarkOpacity: number;
  outroSeconds: number;
  outroLine1: string;
  outroLine2: string;
}

export interface PersistedElementLayoutOverride {
  x: number;
  y: number;
  width?: number;
  height?: number;
  scale?: number;
}

export interface PersistedStudioSettings {
  updatedAt?: number;
  activeTab?: 'studio' | 'reels' | 'edu-studio';
  studio?: {
    aspectRatio?: ExportAspectRatioId;
    resolution?: ExportResolutionId;
    quality?: ExportQualityId;
    fps?: ExportFpsOption;
    theme?: CanvasThemeId;
    compositionId?: LayoutCompositionId;
    watermark?: WatermarkOutroConfig;
    step2CompositionMode?: 'manual' | 'ai-decide' | 'random' | 'custom';
    step2PromptStyle?: PromptVideoStyle;
    inlineProvider?: string;
    inlineVoice?: string;
    inlineSecondaryVoice?: string;
    inlineRate?: number;
    inlineWhisperSync?: boolean;
  };
  reels?: {
    reelCreationMode?: ReelCreationMode;
    creatorTopicHint?: string;
    creatorFormat?: CreatorFormatCategory;
    creatorLearningLang?: LearningLanguageId;
    creatorLevel?: string;
    creatorDurationMinutes?: number;
    creatorItemCount?: number;
    lessonTitle?: string;
    rawText?: string;
    includeQuizInPrompt?: 'auto' | 'always' | 'none';
    mode?: ReelMode;
    targetLang?: string;
    ttsProvider?: string;
    ttsVoice?: string;
    enableDualTts?: boolean;
    splitAudioByRole?: boolean;
    explanationTtsVoice?: string;
    ttsRate?: number;
    reelsAspectRatio?: ExportAspectRatioId;
    selectedTheme?: CanvasThemeId;
    selectedComposition?: LayoutCompositionId;
    bgmPreset?: StudioBgmPresetId;
    bgmVolume?: number;
    watermarkConfig?: WatermarkOutroConfig;
    mp4Resolution?: ExportResolutionId;
    mp4Quality?: ExportQualityId;
    mp4Fps?: ExportFpsOption;
    previewViewMode?: 'video' | 'cards';
    layoutOverridesByAspect?: Partial<
      Record<ExportAspectRatioId, Record<string, PersistedElementLayoutOverride>>
    >;
  };
  audioModal?: {
    tab?: 'tts' | 'transcribe';
    provider?: string;
    voice?: string;
    secondaryVoice?: string;
    rate?: number;
    ttsTitle?: string;
    autoSplitLanguages?: boolean;
    onlyTargetContentSpeech?: boolean;
    autoAlignWhisper?: boolean;
    ttsAlignMode?: 'fast-forced' | 'whisper';
    ttsWhisperModel?: string;
    sttService?: 'faster-whisper' | 'whisper' | 'gemini';
    whisperModel?: string;
    outputFormat?: 'srt' | 'vtt';
    sourceLang?: string;
    translateLang?: string;
    standaloneTargetLang?: string;
    standaloneBilingual?: boolean;
  };
  eduStudio?: {
    subTab?: 'merge' | 'karaoke' | 'align';
    selectedSavePath?: string;
    watermarkOutro?: PersistedEduWatermarkOutro;
    kmStyleId?: string;
    kmSubPosition?: 'Dưới' | 'Giữa' | 'Trên';
    kmSubSize?: 'Nhỏ' | 'Vừa' | 'Lớn';
    kmHighlightColor?: string;
    kmEffect?: string;
    kmMusicPreset?: 'lofi-calm' | 'soft-study' | 'none';
    kmSfxPreset?: 'soft-rain' | 'cafe-room' | 'none';
    kmMuteOriginal?: boolean;
    kmRemoveDialogue?: boolean;
    kmVoicePriority?: boolean;
    kmOriginalVol?: number;
    kmMusicVol?: number;
    kmSfxVol?: number;
    kmVoiceVol?: number;
    readingPaletteId?: string;
    readingIllustration?: string;
    readingBookFrame?: string;
    readingPointerStyle?: string;
    readingIntroEnabled?: boolean;
    readingIntroSeconds?: number;
    readingOutroSpeechEnabled?: boolean;
    readingBgmPreset?: StudioBgmPresetId;
    readingBgmVolume?: number;
    alignMode?: 'fast-forced' | 'whisper';
    alignLang?: string;
    alignModel?: string;
    readingProvider?: string;
    readingVoice?: string;
    readingTtsRate?: number;
    readingAspect?: ExportAspectRatioId;
    readingResolution?: ExportResolutionId;
    readingQuality?: ExportQualityId;
    readingFps?: ExportFpsOption;
  };
}

const STORAGE_KEY = 'kineticsub_user_settings_v1';
export const USER_SETTINGS_HYDRATED_EVENT = 'kineticsub:settings-hydrated';
export const USER_SETTINGS_RESET_EVENT = 'kineticsub:settings-reset';

function isPlainRecord(val: unknown): val is Record<string, unknown> {
  return Boolean(val) && typeof val === 'object' && !Array.isArray(val);
}

function deepMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): T {
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (isPlainRecord(v) && isPlainRecord(out[k]) && k !== 'layoutOverridesByAspect') {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadPersistedSettings(): PersistedStudioSettings {
  if (typeof window === 'undefined' || !window.localStorage) return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return isPlainRecord(parsed) ? (parsed as PersistedStudioSettings) : {};
  } catch {
    return {};
  }
}

let pendingSyncTimer: number | null = null;
let pendingPatchBuffer: PersistedStudioSettings | null = null;
let serverHydrationDone = false;
let sessionHadExplicitWrite = false;
let hydrationInFlight: Promise<PersistedStudioSettings> | null = null;

export function isUserSettingsHydrated(): boolean {
  return serverHydrationDone;
}

export function flushSettingsToServerNow() {
  if (typeof fetch === 'undefined' || !pendingPatchBuffer) return;
  const payload = pendingPatchBuffer;
  pendingPatchBuffer = null;
  if (pendingSyncTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(pendingSyncTimer);
    pendingSyncTimer = null;
  }
  void fetch('/api/settings/preferences', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({ settings: payload }),
  }).catch(() => undefined);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    flushSettingsToServerNow();
  });
  window.addEventListener('pagehide', () => {
    flushSettingsToServerNow();
  });
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        flushSettingsToServerNow();
      }
    });
  }
}

export function updatePersistedSettings(
  patch: Partial<PersistedStudioSettings>,
): PersistedStudioSettings {
  sessionHadExplicitWrite = true;
  const current = loadPersistedSettings();
  const next = deepMerge(current, {
    ...patch,
    updatedAt: Date.now(),
  });

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // ignore storage quota errors
    }
  }

  pendingPatchBuffer = deepMerge(pendingPatchBuffer || {}, {
    ...patch,
    updatedAt: next.updatedAt,
  });

  if (typeof window !== 'undefined') {
    if (pendingSyncTimer !== null) {
      window.clearTimeout(pendingSyncTimer);
    }
    pendingSyncTimer = window.setTimeout(() => {
      flushSettingsToServerNow();
    }, 150);
  } else {
    flushSettingsToServerNow();
  }

  return next;
}

export async function hydrateUserSettingsFromServer(): Promise<PersistedStudioSettings> {
  if (hydrationInFlight) return hydrationInFlight;

  hydrationInFlight = (async () => {
    const local = loadPersistedSettings();
    if (typeof fetch === 'undefined') {
      serverHydrationDone = true;
      return local;
    }

    try {
      const res = await fetch('/api/settings/preferences');
      if (!res.ok) {
        serverHydrationDone = true;
        return local;
      }
      const data = (await res.json()) as { settings?: PersistedStudioSettings };
      const server = isPlainRecord(data?.settings) ? data.settings : {};

      const hasServerData = Object.keys(server).some((k) => k !== 'updatedAt');
      const hasLocalData = Object.keys(local).some((k) => k !== 'updatedAt');

      if (!hasServerData && hasLocalData) {
        await fetch('/api/settings/preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: local, replaceAll: true }),
        }).catch(() => undefined);
        serverHydrationDone = true;
        return local;
      }

      if (!hasServerData) {
        serverHydrationDone = true;
        return local;
      }

      const serverTs = typeof server.updatedAt === 'number' ? server.updatedAt : 0;
      const localTs = typeof local.updatedAt === 'number' ? local.updatedAt : 0;
      // Only prefer local over server if local has strictly newer edits (or user interacted before hydration resolved).
      const preferLocal =
        hasLocalData && (sessionHadExplicitWrite || localTs > serverTs);
      const merged = preferLocal
        ? deepMerge(server, local)
        : deepMerge(local, server);

      if (typeof window !== 'undefined' && window.localStorage) {
        try {
          window.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        } catch {
          // ignore
        }
        window.dispatchEvent(
          new CustomEvent(USER_SETTINGS_HYDRATED_EVENT, { detail: merged }),
        );
      }

      if (preferLocal) {
        await fetch('/api/settings/preferences', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ settings: merged, replaceAll: true }),
        }).catch(() => undefined);
      }

      serverHydrationDone = true;
      return merged;
    } catch {
      serverHydrationDone = true;
      return local;
    } finally {
      hydrationInFlight = null;
    }
  })();

  return hydrationInFlight;
}

export async function resetAllUserSettings(): Promise<void> {
  if (pendingSyncTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(pendingSyncTimer);
    pendingSyncTimer = null;
  }
  pendingPatchBuffer = null;
  sessionHadExplicitWrite = false;
  serverHydrationDone = true;

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // ignore
    }
  }

  if (typeof fetch !== 'undefined') {
    await fetch('/api/settings/preferences/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }).catch(() => undefined);
  }

  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(USER_SETTINGS_RESET_EVENT));
  }
}
