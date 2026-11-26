import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Clapperboard, Database, Film, Layers, RotateCcw, Sparkles, X } from 'lucide-react';
import { AudioSubtitleStudioModal } from './components/AudioSubtitleStudioModal';
import { AutomationPipelinePanel, PresetId } from './components/AutomationPipelinePanel';
import { BatchQueueModal } from './components/BatchQueueModal';
import { ComponentDatabaseModal } from './components/ComponentDatabaseModal';
import { EducationalStudioTab } from './components/EducationalStudioTab';
import { EnglishReelsTab } from './components/EnglishReelsTab';
import { GlobalOutputPanel, emitOutputUpdated } from './components/GlobalOutputPanel';
import { StagePreview } from './components/StagePreview';
import { TimelineAndInspector } from './components/TimelineAndInspector';
import {
  choreographFromTranscript,
  resyncProjectTimingToCues,
} from './engine/autoChoreographer';
import { syncCustomComponentsFromServer } from './engine/customComponentStore';
import { hydrateClientApiKeysFromServer } from './utils/apiKeysStore';
import {
  hydrateUserSettingsFromServer,
  loadPersistedSettings,
  PersistedStudioSettings,
  resetAllUserSettings,
  updatePersistedSettings,
  USER_SETTINGS_HYDRATED_EVENT,
  USER_SETTINGS_RESET_EVENT,
} from './utils/studioSettingsStore';
import {
  applyCustomComponentComposition,
  pickRandomComposition,
  recomposeProjectWithStyle,
} from './engine/illustrationLayouts';
import {
  DEFAULT_MP4_EXPORT_SETTINGS,
  Mp4ExportSettings,
  resolveMp4EncodingParams,
} from './engine/mp4Config';
import {
  ExportAbortedError,
  ExportVideoResult,
  exportProjectToVideo,
} from './engine/mp4Exporter';
import { cleanOutputTitleStem, TAB_OUTPUT_SUBFOLDERS } from './engine/outputNaming';
import {
  PRESET_3D_SHAPES_KARAOKE,
  PRESET_ED_PRONUNCIATION,
  PRESET_JP_EN_POLITE,
  PRESET_WATER_POLITE,
  PRESET_XUN52000_DARK,
} from './engine/demoPresets';
import { FlexibleSceneDocument, scenePlanToProject } from './engine/scenePlanAdapter';
import { adjustCuesTiming, cuesToBlockTranscript } from './engine/transcriptParser';
import { resyncCuesToAudioFile } from './engine/ttsSyncHelper';
import {
  BackgroundImageConfig,
  CanvasThemeId,
  CustomComponentPresetConfig,
  isDarkCanvasTheme,
  LayoutCompositionId,
  LessonProject,
  SceneElement,
  ScenePlanDocument,
  TranscriptCue,
  WatermarkOutroConfig,
  WordTiming,
} from './engine/types';

export default function App() {
  const [initialSavedSettings] = useState<PersistedStudioSettings>(() => loadPersistedSettings());
  const [activeTab, setActiveTab] = useState<'studio' | 'reels' | 'edu-studio'>(
    () => initialSavedSettings.activeTab || 'studio',
  );
  const [isConfirmingReset, setIsConfirmingReset] = useState(false);
  const [project, setProject] = useState<LessonProject>(() => {
    const s = initialSavedSettings.studio;
    if (!s) return PRESET_JP_EN_POLITE;
    const base: LessonProject = {
      ...PRESET_JP_EN_POLITE,
      aspectRatio: s.aspectRatio || PRESET_JP_EN_POLITE.aspectRatio || '9:16',
      theme: s.theme || PRESET_JP_EN_POLITE.theme,
      compositionId: s.compositionId || PRESET_JP_EN_POLITE.compositionId,
      watermark: s.watermark ?? PRESET_JP_EN_POLITE.watermark,
    };
    return s.compositionId || s.theme
      ? recomposeProjectWithStyle(base, base.compositionId || 'story-scenes', { theme: base.theme })
      : base;
  });
  const [currentTime, setCurrentTime] = useState<number>(4.8);
  const [isPlaying, setIsPlaying] = useState<boolean>(false);
  const [selectedElementId, setSelectedElementId] = useState<string | null>(null);
  const [isBatchModalOpen, setIsBatchModalOpen] = useState<boolean>(false);
  const [isComponentDbOpen, setIsComponentDbOpen] = useState<boolean>(false);
  const [isAudioSubStudioOpen, setIsAudioSubStudioOpen] = useState<boolean>(false);
  const [isAdvancedOpen, setIsAdvancedOpen] = useState<boolean>(false);

  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [audioFileName, setAudioFileName] = useState<string | undefined>(undefined);
  const [audioDurationSec, setAudioDurationSec] = useState<number | null>(null);
  const [isExportingVideo, setIsExportingVideo] = useState<boolean>(false);
  const [exportProgress, setExportProgress] = useState<number>(0);
  const [exportStageLabel, setExportStageLabel] = useState<string>('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastExportSummary, setLastExportSummary] = useState<{
    fileName: string;
    savedPath?: string;
    outputCount: number;
    outputDir?: string;
  } | null>(null);
  const [mp4Settings, setMp4Settings] = useState<Mp4ExportSettings>(() => ({
    ...DEFAULT_MP4_EXPORT_SETTINGS,
    ...(initialSavedSettings.studio?.aspectRatio
      ? { aspectRatio: initialSavedSettings.studio.aspectRatio }
      : {}),
    ...(initialSavedSettings.studio?.resolution
      ? { resolution: initialSavedSettings.studio.resolution }
      : {}),
    ...(initialSavedSettings.studio?.quality
      ? { quality: initialSavedSettings.studio.quality }
      : {}),
    ...(initialSavedSettings.studio?.fps ? { fps: initialSavedSettings.studio.fps } : {}),
  }));
  const resolvedExport = resolveMp4EncodingParams(mp4Settings);
  const [customCompositionConfig, setCustomCompositionConfig] = useState<CustomComponentPresetConfig>({
    variant: 'css-sticky-note',
    sceneIcon: 'sparkles',
    title: '',
    subtitle: '',
    speechText: '',
    labels: [],
    highlightWord: '',
    accentColor: '#4F46E5',
    showStrip: true,
    showToneMeter: false,
    showSentenceCard: true,
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastFrameTsRef = useRef<number | null>(null);
  const exportAbortControllerRef = useRef<AbortController | null>(null);

  // Sync playback loop
  useEffect(() => {
    if (!isPlaying) {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      lastFrameTsRef.current = null;
      if (audioRef.current && !audioRef.current.paused) {
        audioRef.current.pause();
      }
      return;
    }

    if (audioRef.current && audioUrl) {
      audioRef.current.currentTime = currentTime;
      audioRef.current.play().catch(() => {
        // Ignore autoplay restrictions
      });
    }

    const tick = (now: number) => {
      if (audioRef.current && audioUrl && !audioRef.current.paused) {
        const nextT = audioRef.current.currentTime;
        if (nextT >= project.duration) {
          setCurrentTime(0);
          setIsPlaying(false);
          return;
        }
        setCurrentTime(nextT);
      } else {
        if (lastFrameTsRef.current === null) {
          lastFrameTsRef.current = now;
        }
        const dt = (now - lastFrameTsRef.current) / 1000;
        lastFrameTsRef.current = now;
        setCurrentTime((prev) => {
          const next = prev + dt;
          if (next >= project.duration) {
            setIsPlaying(false);
            return 0;
          }
          return next;
        });
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isPlaying, project.duration, audioUrl]);

  useEffect(() => {
    void syncCustomComponentsFromServer();
    void hydrateClientApiKeysFromServer();
    void hydrateUserSettingsFromServer();
  }, []);

  useEffect(() => {
    const onHydrated = (ev: Event) => {
      const s = (ev as CustomEvent<PersistedStudioSettings>).detail;
      if (!s) return;
      if (s.activeTab) setActiveTab(s.activeTab);
      if (s.studio) {
        setMp4Settings((prev) => ({
          ...prev,
          ...(s.studio?.aspectRatio ? { aspectRatio: s.studio.aspectRatio } : {}),
          ...(s.studio?.resolution ? { resolution: s.studio.resolution } : {}),
          ...(s.studio?.quality ? { quality: s.studio.quality } : {}),
          ...(s.studio?.fps ? { fps: s.studio.fps } : {}),
        }));
        setProject((prev) => {
          const nextTheme = s.studio?.theme || prev.theme;
          const nextComp = s.studio?.compositionId || prev.compositionId;
          const nextAspect = s.studio?.aspectRatio || prev.aspectRatio;
          const nextWm = s.studio?.watermark ?? prev.watermark;
          const patched: LessonProject = {
            ...prev,
            aspectRatio: nextAspect,
            theme: nextTheme,
            compositionId: nextComp,
            watermark: nextWm,
          };
          return nextTheme !== prev.theme || nextComp !== prev.compositionId
            ? recomposeProjectWithStyle(patched, nextComp || 'story-scenes', { theme: nextTheme })
            : patched;
        });
      }
    };
    const onReset = () => {
      setActiveTab('studio');
      setMp4Settings(DEFAULT_MP4_EXPORT_SETTINGS);
      setProject(PRESET_JP_EN_POLITE);
      setCurrentTime(4.8);
      setSelectedElementId(null);
      setIsConfirmingReset(false);
    };
    window.addEventListener(USER_SETTINGS_HYDRATED_EVENT, onHydrated);
    window.addEventListener(USER_SETTINGS_RESET_EVENT, onReset);
    return () => {
      window.removeEventListener(USER_SETTINGS_HYDRATED_EVENT, onHydrated);
      window.removeEventListener(USER_SETTINGS_RESET_EVENT, onReset);
    };
  }, []);

  const hasMountedPersistRef = useRef(false);
  useEffect(() => {
    if (!hasMountedPersistRef.current) {
      hasMountedPersistRef.current = true;
      return;
    }
    updatePersistedSettings({
      activeTab,
      studio: {
        aspectRatio: mp4Settings.aspectRatio ?? '9:16',
        resolution: mp4Settings.resolution,
        quality: mp4Settings.quality,
        fps: mp4Settings.fps,
        theme: project.theme,
        compositionId: project.compositionId,
        watermark: project.watermark,
      },
    });
  }, [
    activeTab,
    mp4Settings.aspectRatio,
    mp4Settings.resolution,
    mp4Settings.quality,
    mp4Settings.fps,
    project.theme,
    project.compositionId,
    project.watermark,
  ]);

  useEffect(() => {
    return () => {
      if (audioUrl) URL.revokeObjectURL(audioUrl);
    };
  }, [audioUrl]);

  const handleSelectPreset = useCallback((presetId: PresetId) => {
    setIsPlaying(false);
    const next =
      presetId === 'jp-en'
        ? PRESET_JP_EN_POLITE
        : presetId === 'water'
          ? PRESET_WATER_POLITE
          : presetId === 'ed'
            ? PRESET_ED_PRONUNCIATION
            : presetId === 'xun'
              ? PRESET_XUN52000_DARK
              : PRESET_3D_SHAPES_KARAOKE;
    setProject((prev) => ({
      ...next,
      aspectRatio: prev.aspectRatio ?? mp4Settings.aspectRatio ?? '9:16',
      backgroundImage: prev.backgroundImage,
      watermark: prev.watermark,
    }));
    setCurrentTime(
      presetId === 'jp-en'
        ? 4.8
        : presetId === 'water'
          ? 3.1
          : presetId === 'ed'
            ? 3.8
            : presetId === 'xun'
              ? 2.8
              : 1.65,
    );
    setSelectedElementId(null);
  }, []);

  const handleUploadAudio = useCallback((file: File) => {
    setIsPlaying(false);
    const nextUrl = URL.createObjectURL(file);
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return nextUrl;
    });
    setAudioFile(file);
    setAudioFileName(file.name);
    setAudioDurationSec(null);
    setProject((prev) => ({ ...prev, audioFileName: file.name }));
  }, []);

  const handleClearAudio = useCallback(() => {
    setIsPlaying(false);
    setAudioUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setAudioFile(null);
    setAudioFileName(undefined);
    setAudioDurationSec(null);
    setProject((prev) => ({ ...prev, audioFileName: undefined }));
  }, []);

  const handleApplyTranscript = useCallback(
    (cues: TranscriptCue[], title: string) => {
      setIsPlaying(false);
      setProject((prev) => {
        const built = choreographFromTranscript(cues, {
          title,
          theme: isDarkCanvasTheme(prev.theme) ? 'pastel-sunrise' : prev.theme,
          compositionId: prev.compositionId,
          audioFileName,
        });
        const nextDur = audioDurationSec
          ? Number(Math.max(built.duration, audioDurationSec).toFixed(2))
          : built.duration;
        return {
          ...built,
          aspectRatio: prev.aspectRatio ?? mp4Settings.aspectRatio ?? '9:16',
          duration: nextDur,
          backgroundImage: prev.backgroundImage,
          watermark: prev.watermark,
        };
      });
      const firstCue = cues[0];
      const previewTime = firstCue
        ? Number((firstCue.start + Math.min(0.5, (firstCue.end - firstCue.start) * 0.45)).toFixed(2))
        : 0.4;
      setCurrentTime(previewTime);
      setSelectedElementId(null);
    },
    [audioFileName, audioDurationSec],
  );

  const handleApplyScenePlan = useCallback(
    (
      words: WordTiming[],
      plan: ScenePlanDocument,
      title: string,
      cuesOverride?: TranscriptCue[],
    ): LessonProject => {
      setIsPlaying(false);
      const flexPlan = plan as FlexibleSceneDocument;
      const built = scenePlanToProject(words, flexPlan, {
        title,
        theme: flexPlan.theme,
        compositionId: flexPlan.compositionId ?? project.compositionId,
        audioFileName,
        cuesOverride,
      });
      const next: LessonProject = {
        ...built,
        aspectRatio: project.aspectRatio ?? mp4Settings.aspectRatio ?? '9:16',
        duration: audioDurationSec
          ? Number(Math.max(built.duration, audioDurationSec).toFixed(2))
          : built.duration,
        backgroundImage: project.backgroundImage,
        watermark: project.watermark,
      };
      setProject(next);
      const firstVisual = next.elements.find((e) => e.type !== 'karaoke-card');
      const firstWord = words[0];
      setCurrentTime(
        Math.min(
          next.duration,
          Number(((firstVisual?.startTime ?? firstWord?.start ?? 0) + 0.6).toFixed(2)),
        ),
      );
      setSelectedElementId(null);
      return next;
    },
    [audioFileName, audioDurationSec, project.backgroundImage, project.compositionId, project.watermark],
  );

  const handleSeek = useCallback(
    (time: number) => {
      const clamped = Math.max(0, Math.min(project.duration, time));
      setCurrentTime(clamped);
      if (audioRef.current && audioUrl) {
        audioRef.current.currentTime = clamped;
      }
    },
    [project.duration, audioUrl],
  );

  const handleChangeComposition = useCallback(
    (compositionId: LayoutCompositionId) => {
      setIsPlaying(false);
      setSelectedElementId(null);
      if (compositionId === 'custom') {
        setProject((prev) =>
          applyCustomComponentComposition(prev, customCompositionConfig, {
            scope: 'all',
            activeTimeSec: currentTime,
          }),
        );
        return;
      }
      setProject((prev) => recomposeProjectWithStyle(prev, compositionId));
    },
    [customCompositionConfig, currentTime],
  );

  const handleApplyCustomComposition = useCallback(
    (config: CustomComponentPresetConfig, scope: 'all' | 'active-cue' = 'all') => {
      setIsPlaying(false);
      setSelectedElementId(null);
      setCustomCompositionConfig(config);
      setProject((prev) =>
        applyCustomComponentComposition(prev, config, {
          scope,
          activeTimeSec: currentTime,
        }),
      );
    },
    [currentTime],
  );

  const handleApplyGeneratedAudioAndCues = useCallback(
    (nextAudioFile: File | null, cues: TranscriptCue[], title?: string) => {
      setIsPlaying(false);
      if (nextAudioFile) {
        const nextUrl = URL.createObjectURL(nextAudioFile);
        setAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return nextUrl;
        });
        setAudioFile(nextAudioFile);
        setAudioFileName(nextAudioFile.name);
        setAudioDurationSec(null);
      }
      setProject((prev) => {
        const nextCues = cues.length > 0 ? cues : prev.cues;
        const built = choreographFromTranscript(nextCues, {
          title: title?.trim() || prev.title,
          theme: prev.theme,
          compositionId: prev.compositionId,
          audioFileName: nextAudioFile?.name ?? audioFileName,
        });
        return {
          ...built,
          aspectRatio: prev.aspectRatio ?? mp4Settings.aspectRatio ?? '9:16',
          backgroundImage: prev.backgroundImage,
          watermark: prev.watermark,
        };
      });
      const nextCuesForTime = cues.length > 0 ? cues : project.cues;
      const firstCue = nextCuesForTime[0];
      const previewTime = firstCue
        ? Number((firstCue.start + Math.min(0.5, (firstCue.end - firstCue.start) * 0.45)).toFixed(2))
        : 0.4;
      setCurrentTime(previewTime);
      setSelectedElementId(null);
    },
    [project.cues, audioFileName],
  );

  const handleReceiveFromReelsTab = useCallback(
    (incomingProject: LessonProject, incomingAudioFile: File | null) => {
      setIsPlaying(false);
      if (incomingAudioFile) {
        const nextUrl = URL.createObjectURL(incomingAudioFile);
        setAudioUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return nextUrl;
        });
        setAudioFile(incomingAudioFile);
        setAudioFileName(incomingAudioFile.name);
        setAudioDurationSec(null);
      } else {
        handleClearAudio();
      }
      const nextAspect = incomingProject.aspectRatio || '9:16';
      setMp4Settings((prev) =>
        prev.aspectRatio === nextAspect ? prev : { ...prev, aspectRatio: nextAspect },
      );
      setProject(incomingProject);
      const firstCue = incomingProject.cues[0];
      setCurrentTime(
        firstCue
          ? Number((firstCue.start + Math.min(0.45, (firstCue.end - firstCue.start) * 0.35)).toFixed(2))
          : 0.4,
      );
      setSelectedElementId(null);
      setActiveTab('studio');
    },
    [handleClearAudio],
  );

  const handleChangeMp4Settings = useCallback((next: Mp4ExportSettings) => {
    setMp4Settings(next);
    if (next.aspectRatio) {
      const nextAspect = next.aspectRatio;
      setProject((prev) =>
        prev.aspectRatio === nextAspect ? prev : { ...prev, aspectRatio: nextAspect },
      );
    }
  }, []);

  const handleChangeBackgroundImage = useCallback((bg?: BackgroundImageConfig) => {
    setProject((prev) => ({
      ...prev,
      backgroundImage: bg,
    }));
  }, []);

  const handleAdjustProjectTiming = useCallback(
    (adjust: {
      offsetMs?: number;
      speedFactor?: number;
      targetDurationSec?: number;
      resyncVisuals?: boolean;
    }) => {
      setIsPlaying(false);
      setProject((prev) => {
        const nextCues = adjustCuesTiming(prev.cues, {
          offsetMs: adjust.offsetMs,
          speedFactor: adjust.speedFactor,
          targetDurationSec: adjust.targetDurationSec,
        });
        return resyncProjectTimingToCues(prev, nextCues, {
          resyncVisuals: adjust.resyncVisuals ?? true,
          audioDurationSec: audioDurationSec ?? undefined,
        });
      });
    },
    [audioDurationSec],
  );

  const handleResyncCuesToAudio = useCallback(
    async (
      mode: 'fast-forced' | 'whisper',
      options?: { resyncVisuals?: boolean; onProgress?: (pct: number, label: string) => void },
    ) => {
      if (!audioFile) {
        throw new Error('Chưa có file Audio để đồng bộ lại.');
      }
      setIsPlaying(false);
      const res = await resyncCuesToAudioFile({
        audioFile,
        cues: project.cues,
        alignMode: mode,
        onProgress: options?.onProgress,
      });
      setProject((prev) =>
        resyncProjectTimingToCues(prev, res.cues, {
          resyncVisuals: options?.resyncVisuals ?? true,
          audioDurationSec: audioDurationSec ?? undefined,
        }),
      );
      return {
        cueCount: res.cues.length,
        backendUsed: res.backendUsed,
        blockTranscript: res.blockTranscript,
        srt: res.srt,
      };
    },
    [audioFile, project.cues, audioDurationSec],
  );

  const handleChangeWatermark = useCallback((wm: WatermarkOutroConfig) => {
    setProject((prev) => {
      const cuesMax = prev.cues.reduce((mx, c) => Math.max(mx, c.end), 0);
      const elMax = prev.elements.reduce((mx, el) => Math.max(mx, el.endTime), 0);
      const prevHasOutro = Boolean(
        prev.watermark &&
          prev.watermark.outroSeconds > 0 &&
          (prev.watermark.outroLine1.trim() || prev.watermark.outroLine2.trim()),
      );
      const prevOutroSec = prevHasOutro ? Number(prev.watermark?.outroSeconds || 0) : 0;
      const baseDur = Math.max(3, cuesMax, elMax, Number((prev.duration - prevOutroSec).toFixed(2)));
      const nextHasOutro = Boolean(
        wm.outroSeconds > 0 && (wm.outroLine1.trim() || wm.outroLine2.trim()),
      );
      const nextOutroSec = nextHasOutro ? Math.max(0, Number(wm.outroSeconds || 0)) : 0;
      const nextDuration = Number((baseDur + nextOutroSec).toFixed(2));
      return {
        ...prev,
        duration: nextDuration,
        watermark: wm,
      };
    });
  }, []);

  const handleRandomizeComposition = useCallback(() => {
    setIsPlaying(false);
    setSelectedElementId(null);
    setProject((prev) => {
      const transcriptText = prev.cues.map((c) => c.text).join(' ');
      const pick = pickRandomComposition(prev.compositionId, prev.theme, Math.random, {
        transcriptText,
        allowDarkThemes: true,
      });
      return recomposeProjectWithStyle(prev, pick.compositionId, { theme: pick.theme });
    });
  }, []);

  const handleUpdateElement = useCallback((id: string, patch: Partial<SceneElement>) => {
    setProject((prev) => ({
      ...prev,
      elements: prev.elements.map((el) => (el.id === id ? { ...el, ...patch } : el)),
    }));
  }, []);

  const handleMoveElement = useCallback((id: string, x: number, y: number) => {
    setProject((prev) => ({
      ...prev,
      elements: prev.elements.map((el) =>
        el.id === id ? { ...el, layout: { ...el.layout, x, y, manualPosition: true } } : el,
      ),
    }));
  }, []);

  const handleDeleteElement = useCallback(
    (id: string) => {
      setProject((prev) => ({
        ...prev,
        elements: prev.elements.filter((el) => el.id !== id),
      }));
      if (selectedElementId === id) {
        setSelectedElementId(null);
      }
    },
    [selectedElementId],
  );

  const handleAddElement = useCallback(
    (type: 'sentence-card' | 'topic-pill' | 'shape-3d') => {
      const start = Number(Math.max(0, currentTime).toFixed(2));
      const end = Number(Math.min(project.duration, start + 3.0).toFixed(2));
      const id = `custom-${type}-${Date.now()}`;

      let newEl: SceneElement;
      if (type === 'shape-3d') {
        newEl = {
          id,
          type: 'shape-3d',
          label: 'Khối 3D mới',
          startTime: start,
          endTime: Math.max(start + 0.8, end),
          enterAnimation: 'pop-up',
          exitAnimation: 'shrink',
          layout: { x: 540, y: 760, width: 760, height: 220, scale: 1, zIndex: 24 },
          props: {
            kind: 'shape-3d',
            shapeType: 'card_3d',
            fill: '#14B8A6',
            shadow: true,
            highlight: true,
            depth: 12,
            cornerRadius: 28,
            textContent: 'Key Point',
            textColor: '#FFFFFF',
            textSize: 'headline',
            textWeight: 'bold',
          },
        };
      } else if (type === 'sentence-card') {
        newEl = {
          id,
          type: 'sentence-card',
          label: 'Thẻ câu mới',
          startTime: start,
          endTime: Math.max(start + 0.8, end),
          enterAnimation: 'pop-up',
          exitAnimation: 'shrink',
          layout: { x: 540, y: 1005, width: 780, scale: 1, zIndex: 22 },
          props: {
            kind: 'sentence-card',
            text: 'Could I have some water?',
            badge: 'check',
            emphasisWord: 'Could I',
            emphasisColor: '#16A34A',
          },
        };
      } else {
        newEl = {
          id,
          type: 'topic-pill',
          label: 'Nhãn mới',
          startTime: start,
          endTime: Math.max(start + 0.8, end),
          enterAnimation: 'pop-up',
          exitAnimation: 'fade-out',
          layout: { x: 540, y: 345, width: 340, scale: 1, zIndex: 14 },
          props: {
            kind: 'topic-pill',
            text: 'Tip #1',
            bgColor: '#DCFCE7',
            textColor: '#15803D',
          },
        };
      }

      setProject((prev) => ({ ...prev, elements: [...prev.elements, newEl] }));
      setSelectedElementId(id);
    },
    [currentTime, project.duration],
  );

  const handleCancelExportVideo = useCallback(() => {
    exportAbortControllerRef.current?.abort();
  }, []);

  const handleOpenOutputFolder = useCallback(async () => {
    try {
      const res = await fetch('/api/output/open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = (await res.json().catch(() => ({}))) as { opened?: boolean; path?: string };
      if (!data.opened) {
        setActiveTab('edu-studio');
      }
    } catch {
      setActiveTab('edu-studio');
    }
  }, []);

  const handleExportVideo = useCallback(
    async (projectOverride?: LessonProject): Promise<ExportVideoResult | null> => {
      if (isExportingVideo) return null;
      const targetProject = projectOverride ?? project;
      const controller = new AbortController();
      exportAbortControllerRef.current = controller;

      setIsPlaying(false);
      setIsExportingVideo(true);
      setExportProgress(0);
      setExportStageLabel('Đang chuẩn bị render MP4...');
      setExportError(null);

      try {
        const cleanFileBase = cleanOutputTitleStem(
          targetProject.title || targetProject.id,
          'Studio Video',
        );
        const result = await exportProjectToVideo(
          targetProject,
          audioFile,
          ({ progress, stageLabel }) => {
            setExportProgress(progress);
            setExportStageLabel(stageLabel);
          },
          mp4Settings,
            {
            signal: controller.signal,
            customFileBase: cleanFileBase,
            alsoSaveToServerOutput: true,
            savePath: TAB_OUTPUT_SUBFOLDERS.studio,
            sourceTab: `Studio ${targetProject.aspectRatio || mp4Settings.aspectRatio || '9:16'}`,
          },
        );
        emitOutputUpdated({
          sourceTab: `Studio ${targetProject.aspectRatio || mp4Settings.aspectRatio || '9:16'}`,
        });
        try {
          const outRes = await fetch('/api/output/files');
          const outData = (await outRes.json().catch(() => ({}))) as {
            outputDir?: string;
            files?: Array<unknown>;
          };
          setLastExportSummary({
            fileName: result.fileName,
            savedPath: result.savedPath,
            outputCount: Array.isArray(outData.files) ? outData.files.length : 1,
            outputDir: outData.outputDir,
          });
        } catch {
          setLastExportSummary({
            fileName: result.fileName,
            savedPath: result.savedPath,
            outputCount: 1,
          });
        }
        return result;
      } catch (err) {
        if (err instanceof ExportAbortedError || controller.signal.aborted) {
          setExportError('Đã hủy quá trình render video.');
          return null;
        }
        const msg = err instanceof Error ? err.message : 'Không thể render file video.';
        setExportError(msg);
        return null;
      } finally {
        exportAbortControllerRef.current = null;
        setIsExportingVideo(false);
        setExportProgress(0);
        setExportStageLabel('');
      }
    },
    [isExportingVideo, project, audioFile, mp4Settings],
  );

  const handleApplyAndRenderVideo = useCallback(
    async (
      words: WordTiming[],
      plan: ScenePlanDocument,
      title: string,
      cuesOverride?: TranscriptCue[],
    ): Promise<ExportVideoResult | null> => {
      const nextProject = handleApplyScenePlan(words, plan, title, cuesOverride);
      return handleExportVideo(nextProject);
    },
    [handleApplyScenePlan, handleExportVideo],
  );

  return (
    <div className="min-h-screen flex flex-col bg-[#F6F7F9] text-slate-900">
      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onLoadedMetadata={(e) => {
            const dur = e.currentTarget.duration;
            if (Number.isFinite(dur) && dur > 0.5) {
              setAudioDurationSec(dur);
              setProject((prev) => ({
                ...prev,
                duration: Number(Math.max(prev.duration, dur).toFixed(2)),
              }));
            }
          }}
        />
      )}

      {/* Modern Studio Navigation Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-slate-200/90 px-4 lg:px-6 py-2.5 shadow-xs">
        <div className="max-w-[1400px] mx-auto flex flex-wrap items-center justify-between gap-3">
          <a
            href="#studio"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('studio');
            }}
            className="flex items-center gap-2.5 shrink-0 group"
          >
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-600 via-violet-600 to-fuchsia-600 text-white flex items-center justify-center shadow-sm group-hover:shadow transition-shadow">
              <Clapperboard className="w-4 h-4" />
            </div>
            <div className="leading-tight">
              <div className="text-base font-bold tracking-tight text-slate-900 font-display">
                KineticSub Studio
              </div>
              <div className="text-[10px] font-medium text-slate-500">
                Video Học Ngoại Ngữ 9:16 &amp; 16:9
              </div>
            </div>
          </a>

          <nav
            aria-label="Menu chính"
            className="flex items-center gap-1.5 bg-slate-100/90 p-1 rounded-2xl border border-slate-200/80 overflow-x-auto max-w-full"
          >
            <button
              type="button"
              onClick={() => setActiveTab('studio')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-xl transition-all whitespace-nowrap shrink-0 ${
                activeTab === 'studio'
                  ? 'bg-white text-indigo-700 shadow-sm ring-1 ring-slate-200/80'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              <Clapperboard className={`w-3.5 h-3.5 ${activeTab === 'studio' ? 'text-indigo-600' : 'text-slate-400'}`} />
              <span>Dựng Video ({project.aspectRatio || mp4Settings.aspectRatio || '9:16'})</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('reels')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-xl transition-all whitespace-nowrap shrink-0 ${
                activeTab === 'reels'
                  ? 'bg-white text-violet-700 shadow-sm ring-1 ring-slate-200/80'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              <Sparkles className={`w-3.5 h-3.5 ${activeTab === 'reels' ? 'text-violet-600' : 'text-slate-400'}`} />
              <span>Video Ngoại Ngữ AI</span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('edu-studio')}
              className={`inline-flex items-center gap-2 px-3.5 py-2 text-xs font-semibold rounded-xl transition-all whitespace-nowrap shrink-0 ${
                activeTab === 'edu-studio'
                  ? 'bg-white text-emerald-700 shadow-sm ring-1 ring-slate-200/80'
                  : 'text-slate-600 hover:text-slate-900 hover:bg-white/60'
              }`}
            >
              <Film className={`w-3.5 h-3.5 ${activeTab === 'edu-studio' ? 'text-emerald-600' : 'text-slate-400'}`} />
              <span>Hậu Kỳ &amp; File Xuất</span>
            </button>
          </nav>

          <div className="flex items-center gap-2 shrink-0">
            {isConfirmingReset ? (
              <div className="inline-flex items-center gap-1 bg-rose-50 border border-rose-200 rounded-xl px-2 py-1">
                <button
                  type="button"
                  onClick={() => void resetAllUserSettings()}
                  className="px-2 py-1 text-[11px] font-semibold text-white bg-rose-600 rounded-lg hover:bg-rose-700 whitespace-nowrap shrink-0"
                >
                  Xác nhận Reset
                </button>
                <button
                  type="button"
                  onClick={() => setIsConfirmingReset(false)}
                  className="px-2 py-1 text-[11px] font-medium text-slate-600 hover:text-slate-900 whitespace-nowrap shrink-0"
                >
                  Hủy
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsConfirmingReset(true)}
                title="Khôi phục tất cả cài đặt các tab về mặc định"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-xl hover:border-rose-300 hover:text-rose-700 hover:bg-rose-50/40 transition-all shadow-xs whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Mặc định</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setIsComponentDbOpen(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold text-slate-700 bg-white border border-slate-200 rounded-xl hover:border-indigo-300 hover:bg-indigo-50/50 hover:text-indigo-700 transition-all shadow-xs whitespace-nowrap shrink-0"
            >
              <Database className="w-3.5 h-3.5 text-indigo-600" />
              <span>Kho Component</span>
            </button>

            <button
              type="button"
              onClick={() => setIsBatchModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-gradient-to-r from-indigo-600 to-violet-600 rounded-xl hover:from-indigo-700 hover:to-violet-700 transition-all shadow-sm whitespace-nowrap shrink-0"
            >
              <Layers className="w-3.5 h-3.5" />
              <span>Chạy Batch Hàng Loạt</span>
            </button>
          </div>
        </div>
      </header>

      {activeTab === 'reels' ? (
        <main className="flex-1 w-full">
          <EnglishReelsTab onSendToStudio={handleReceiveFromReelsTab} />
        </main>
      ) : activeTab === 'edu-studio' ? (
        <main className="flex-1 w-full">
          <EducationalStudioTab
            onSendAudioCuesToStudio={(incomingAudio, incomingCues, incomingTitle) => {
              handleApplyGeneratedAudioAndCues(incomingAudio, incomingCues, incomingTitle);
              setActiveTab('studio');
            }}
          />
        </main>
      ) : (
        /* Main Automated AI-First Workspace */
        <main id="studio" className="flex-1 max-w-[1400px] w-full mx-auto p-4 lg:p-6 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-bold text-slate-900 tracking-tight text-balance">
                {project.title}
              </h1>
              <p className="text-xs text-slate-500 mt-0.5">{project.subtitle}</p>
            </div>
            <div className="flex items-center gap-2 text-xs text-slate-600 tabular-nums">
              <span>{project.elements.length} lớp tự động</span>
              <span aria-hidden="true">·</span>
              <span>{project.duration.toFixed(1)}s</span>
              <span aria-hidden="true">·</span>
              <span>
                {resolvedExport.width}×{resolvedExport.height} @ {resolvedExport.fps}fps
              </span>
            </div>
          </div>

          {/* Clean 2-Column AI Pipeline + Live 9:16 Preview */}
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
            <div className="lg:col-span-7 min-h-0">
              <AutomationPipelinePanel
                project={project}
                audioUrl={audioUrl}
                audioFile={audioFile}
                audioFileName={audioFileName}
                audioDurationSec={audioDurationSec}
                currentTime={currentTime}
                mp4Settings={mp4Settings}
                customCompositionConfig={customCompositionConfig}
                isExportingVideo={isExportingVideo}
                exportProgress={exportProgress}
                exportStageLabel={exportStageLabel}
                exportError={exportError}
                onChangeMp4Settings={handleChangeMp4Settings}
                onChangeComposition={handleChangeComposition}
                onRandomizeComposition={handleRandomizeComposition}
                onChangeCustomComposition={setCustomCompositionConfig}
                onApplyCustomComposition={handleApplyCustomComposition}
                onSelectPreset={handleSelectPreset}
                onUploadAudio={handleUploadAudio}
                onClearAudio={handleClearAudio}
                onApplyTranscript={handleApplyTranscript}
                onApplyAudioAndCues={handleApplyGeneratedAudioAndCues}
                onResyncCuesToAudio={handleResyncCuesToAudio}
                onAdjustTiming={handleAdjustProjectTiming}
                onApplyScenePlan={handleApplyScenePlan}
                onApplyAndRenderVideo={handleApplyAndRenderVideo}
                onSeek={handleSeek}
                onOpenAdvancedEditor={() => setIsAdvancedOpen(true)}
                onOpenAudioSubtitleStudio={() => setIsAudioSubStudioOpen(true)}
                onCancelExportVideo={handleCancelExportVideo}
              />
            </div>

            <div className="lg:col-span-5 min-h-0">
              <StagePreview
                project={project}
                currentTime={currentTime}
                isPlaying={isPlaying}
                mp4Settings={mp4Settings}
                customCompositionConfig={customCompositionConfig}
                isExportingVideo={isExportingVideo}
                exportProgress={exportProgress}
                exportStageLabel={exportStageLabel}
                lastExportSummary={lastExportSummary}
                selectedElementId={isAdvancedOpen ? selectedElementId : null}
                onChangeMp4Settings={handleChangeMp4Settings}
                onChangeComposition={handleChangeComposition}
                onRandomizeComposition={handleRandomizeComposition}
                onChangeCustomComposition={setCustomCompositionConfig}
                onApplyCustomComposition={handleApplyCustomComposition}
                onTogglePlay={() => setIsPlaying((p) => !p)}
                onRestart={() => {
                  handleSeek(0);
                  setIsPlaying(true);
                }}
                onSeek={handleSeek}
                onChangeTheme={(theme: CanvasThemeId) =>
                  setProject((prev) => {
                    const isDark = isDarkCanvasTheme(theme);
                    return {
                      ...prev,
                      theme,
                      elements: prev.elements.map((el) => {
                        if (el.props.kind !== 'karaoke-card') return el;
                        return {
                          ...el,
                          props: {
                            ...el.props,
                            variant: isDark ? 'dark-bar' : 'white-card',
                            activeColor: isDark ? '#FACC15' : '#2563EB',
                            inactiveColor: isDark ? '#CBD5E1' : '#9CA3AF',
                            spokenColor: isDark ? '#FFFFFF' : '#111827',
                          },
                        };
                      }),
                    };
                  })
                }
                onChangeBackgroundImage={handleChangeBackgroundImage}
                onChangeWatermark={handleChangeWatermark}
                onSelectElement={setSelectedElementId}
                onMoveElement={handleMoveElement}
                onExportVideo={() => void handleExportVideo()}
                onCancelExportVideo={handleCancelExportVideo}
                onOpenOutputFolder={() => void handleOpenOutputFolder()}
              />
            </div>
          </div>

          {/* Concise 3-Input Architecture Guide */}
          <section
            id="python-guide"
            className="bg-white border border-slate-200 rounded-xl p-6 grid grid-cols-1 md:grid-cols-3 gap-6"
          >
            <div>
              <p className="text-xs font-semibold text-indigo-600 mb-1">01. Không cần thiết kế tay</p>
              <h3 className="text-sm font-semibold text-slate-900 mb-1.5">
                Chỉ nhập Audio &amp; Transcript
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                Hỗ trợ file ghi âm, sinh TTS miễn phí đa ngôn ngữ hoặc bóc phụ đề từ video. Karaoke từng từ được đồng bộ tự động.
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-indigo-600 mb-1">02. Prompt là xương sống</p>
              <h3 className="text-sm font-semibold text-slate-900 mb-1.5">
                Gửi ChatGPT / Gemini sinh JSON
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                Dùng Prompt dựng sẵn với Kho Component vector tùy chỉnh để AI tự chọn hình minh họa, khối 3D và gắn mốc hiện/ẩn không chồng đè.
              </p>
            </div>
            <div>
              <p className="text-xs font-semibold text-indigo-600 mb-1">03. Render tự động 9:16 &amp; 16:9</p>
              <h3 className="text-sm font-semibold text-slate-900 mb-1.5">
                Render &amp; lưu MP4 trực tiếp
              </h3>
              <p className="text-xs text-slate-600 leading-relaxed">
                Chọn khung hình (9:16 / 16:9), độ phân giải (540p–2K), ảnh nền, chất lượng &amp; FPS để render file{' '}
                <code>.mp4</code> có tiếng ngay trên trình duyệt, hoặc ghép &amp; mix âm thanh nâng cao tại Edu Studio 1.19.
              </p>
            </div>
          </section>
        </main>
      )}

      {/* Global Output Panel visible across ALL tabs at the bottom */}
      <GlobalOutputPanel activeTab={activeTab} />

      {/* Optional Advanced Editor Modal (Hidden by default so user doesn't have to design) */}
      {isAdvancedOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="advanced-editor-title"
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/45 backdrop-blur-[2px] p-4"
        >
          <div className="bg-white border border-slate-200 rounded-2xl shadow-xl w-full max-w-2xl h-[82vh] flex flex-col overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <div>
                <h2 id="advanced-editor-title" className="text-sm font-semibold text-slate-900">
                  Tinh chỉnh nâng cao (Tùy chọn)
                </h2>
                <p className="text-xs text-slate-500">
                  Chỉ dùng khi bạn muốn sửa tay thời gian hoặc vị trí của thẻ do AI tạo
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsAdvancedOpen(false)}
                aria-label="Đóng chỉnh sửa nâng cao"
                className="p-2 text-slate-400 hover:text-slate-700 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 p-4 bg-slate-50">
              <TimelineAndInspector
                project={project}
                currentTime={currentTime}
                selectedElementId={selectedElementId}
                onSelectElement={setSelectedElementId}
                onUpdateElement={handleUpdateElement}
                onDeleteElement={handleDeleteElement}
                onAddElement={handleAddElement}
                onSeek={handleSeek}
              />
            </div>
          </div>
        </div>
      )}

      <BatchQueueModal
        isOpen={isBatchModalOpen}
        mp4Settings={mp4Settings}
        onChangeMp4Settings={handleChangeMp4Settings}
        onClose={() => setIsBatchModalOpen(false)}
      />

      <ComponentDatabaseModal
        isOpen={isComponentDbOpen}
        onClose={() => setIsComponentDbOpen(false)}
      />

      <AudioSubtitleStudioModal
        isOpen={isAudioSubStudioOpen}
        initialTranscriptText={cuesToBlockTranscript(project.cues)}
        onClose={() => setIsAudioSubStudioOpen(false)}
        onApplyAudioAndCues={handleApplyGeneratedAudioAndCues}
      />
    </div>
  );
}
