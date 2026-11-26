import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  CheckCircle2,
  Copy,
  Download,
  Eye,
  FileAudio,
  Film,
  FolderOpen,
  FolderPlus,
  Globe,
  Layers,
  Link2,
  Loader2,
  Music,
  Pause,
  Play,
  Sparkles,
  Square,
  Upload,
  Volume2,
  Wand2,
} from 'lucide-react';
import { PasteButton } from './PasteButton';
import {
  buildEduKaraokeAss,
  buildEstimatedReadingWords,
  computeReadingTimelineMetrics,
  EduKaraokePosition,
  EduKaraokeSize,
  EduWatermarkCorner,
  EduWatermarkOutroConfig,
  KARAOKE_EFFECT_PRESETS,
  READING_BOOK_FRAMES,
  READING_BOOK_PALETTES,
  READING_POINTER_STYLES,
  ReadingBookFrameId,
  ReadingBookPalette,
  ReadingIllustrationStyle,
  ReadingPointerStyleId,
  renderReadingAlongFrame,
} from '../engine/eduStudioEffects';
import {
  ASPECT_RATIO_OPTIONS,
  DEFAULT_MP4_EXPORT_SETTINGS,
  ExportAspectRatioId,
  ExportFpsOption,
  ExportQualityId,
  ExportResolutionId,
  resolveMp4EncodingParams,
} from '../engine/mp4Config';
import { ExportAbortedError, exportProjectToServerDisk } from '../engine/mp4Exporter';
import {
  cleanDownloadFileName,
  cleanOutputTitleStem,
  TAB_OUTPUT_SUBFOLDERS,
} from '../engine/outputNaming';
import {
  cleanReadingWorksheetInput,
  buildReadingWebAiPrompt,
  parseReadingWebAiResponse,
} from '../engine/readingPromptBuilder';
import {
  concatAudioFilesWithGaps,
  mixVoiceWithBgmPreset,
  shiftReadingWordsForIntro,
  STUDIO_BGM_PRESETS,
  StudioBgmPresetId,
} from '../engine/audioMixHelper';
import { parseTranscriptAuto } from '../engine/transcriptParser';
import {
  alignAudioWithProgressJob,
  fetchTtsVoicesCatalog,
  synthesizeAudioAndSyncCues,
  synthesizeAudioWithProgressJob,
  TtsProviderItem,
} from '../engine/ttsSyncHelper';
import { LessonProject, TranscriptCue, WordTiming } from '../engine/types';
import { buildApiKeyHeaders, useClientApiKeys } from '../utils/apiKeysStore';
import {
  loadPersistedSettings,
  PersistedStudioSettings,
  updatePersistedSettings,
  USER_SETTINGS_HYDRATED_EVENT,
  USER_SETTINGS_RESET_EVENT,
} from '../utils/studioSettingsStore';
import { ApiKeyInlineControl } from './ApiKeyInlineControl';
import { emitOutputUpdated } from './GlobalOutputPanel';

interface EducationalStudioTabProps {
  onSendAudioCuesToStudio?: (audioFile: File | null, cues: TranscriptCue[], title?: string) => void;
}

const CHUNK_SIZE = 4 * 1024 * 1024;

async function parseApiJson<T = Record<string, any>>(
  res: Response,
  fallbackError: string,
): Promise<T> {
  const raw = await res.text();
  const trimmed = raw.trim();
  if (!trimmed) {
    if (!res.ok) throw new Error(`${fallbackError} (HTTP ${res.status})`);
    return {} as T;
  }
  if (trimmed.startsWith('<')) {
    if (res.status === 413) {
      throw new Error('File tải lên vượt quá giới hạn dung lượng (tối đa 250MB).');
    }
    throw new Error(
      `Server trả về HTML (HTTP ${res.status}) thay vì JSON — kiểm tra server Node.js hoặc dung lượng file tải lên.`,
    );
  }
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    throw new Error(
      res.ok ? `${fallbackError}: JSON không hợp lệ.` : `${fallbackError} (HTTP ${res.status})`,
    );
  }
}

async function uploadStudioFileChunked(
  jobId: string,
  role: string,
  file: File,
  signal?: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < file.size; offset += CHUNK_SIZE) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const slice = file.slice(offset, offset + CHUNK_SIZE);
    const appendQuery = offset > 0 ? '?append=1' : '';
    const res = await fetch(`/api/studio/job/${jobId}/file${appendQuery}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-role': role,
        'x-filename': encodeURIComponent(file.name),
      },
      body: slice,
      signal,
    });
    if (!res.ok) {
      const err = await parseApiJson<{ error?: string }>(res, `Upload ${role} thất bại`).catch(() => ({
        error: undefined,
      }));
      throw new Error(err.error || `Upload ${role} thất bại (HTTP ${res.status})`);
    }
  }
}

function getPreviewVideoCssFilter(effect: string): string {
  switch (effect) {
    case 'Warm film + fade':
      return 'contrast(1.06) saturate(1.15) sepia(0.14)';
    case 'Cool tech + fade':
      return 'contrast(1.06) saturate(1.08) hue-rotate(-8deg)';
    case 'Soft vignette + fade':
      return 'contrast(1.04) saturate(0.92)';
    default:
      return 'none';
  }
}

interface VideoSnapshotStripProps {
  videoUrl: string | null;
  videoFilterCss?: string;
  watermarkOutro: EduWatermarkOutroConfig;
  subtitleSampleText?: string;
  highlightColor?: string;
  subtitlePosition?: EduKaraokePosition;
  onSeek?: (timeSec: number) => void;
}

const VideoSnapshotStrip: React.FC<VideoSnapshotStripProps> = ({
  videoUrl,
  videoFilterCss = 'none',
  watermarkOutro,
  subtitleSampleText,
  highlightColor = '#FACC15',
  subtitlePosition = 'Dưới',
  onSeek,
}) => {
  const [snapshots, setSnapshots] = useState<Array<{ label: string; timeSec: number; dataUrl: string }>>([]);
  const [isCapturing, setIsCapturing] = useState(false);

  useEffect(() => {
    if (!videoUrl) {
      setSnapshots([]);
      setIsCapturing(false);
      return;
    }

    let cancelled = false;
    setIsCapturing(true);
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = videoUrl;

    const captureFrames = async () => {
      try {
        await new Promise<void>((resolve, reject) => {
          const onLoaded = () => {
            cleanup();
            resolve();
          };
          const onErr = () => {
            cleanup();
            reject(new Error('Không đọc được metadata video'));
          };
          const timer = window.setTimeout(() => {
            cleanup();
            resolve();
          }, 4000);
          const cleanup = () => {
            window.clearTimeout(timer);
            video.removeEventListener('loadeddata', onLoaded);
            video.removeEventListener('loadedmetadata', onLoaded);
            video.removeEventListener('error', onErr);
          };
          video.addEventListener('loadeddata', onLoaded);
          video.addEventListener('loadedmetadata', onLoaded);
          video.addEventListener('error', onErr);
        });

        if (cancelled) return;
        const dur = Number.isFinite(video.duration) && video.duration > 0.2 ? video.duration : 3;
        const vw = video.videoWidth || 640;
        const vh = video.videoHeight || 360;
        const maxW = 320;
        const cw = maxW;
        const ch = Math.max(120, Math.round((maxW * vh) / vw));

        const targets = [
          { label: 'Đầu · 12%', timeSec: Math.max(0.05, dur * 0.12) },
          { label: 'Giữa · 50%', timeSec: Math.max(0.1, dur * 0.5) },
          { label: 'Cuối · 85%', timeSec: Math.max(0.15, dur * 0.85) },
        ];

        const canvas = document.createElement('canvas');
        canvas.width = cw;
        canvas.height = ch;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const nextSnaps: Array<{ label: string; timeSec: number; dataUrl: string }> = [];

        for (let i = 0; i < targets.length; i++) {
          if (cancelled) return;
          const target = targets[i];
          await new Promise<void>((resolve) => {
            let done = false;
            const finish = () => {
              if (done) return;
              done = true;
              window.clearTimeout(timeoutId);
              video.removeEventListener('seeked', finish);
              resolve();
            };
            const timeoutId = window.setTimeout(finish, 1800);
            video.addEventListener('seeked', finish);
            try {
              video.currentTime = Math.min(Math.max(0, dur - 0.05), target.timeSec);
            } catch {
              finish();
            }
          });

          if (cancelled) return;
          ctx.clearRect(0, 0, cw, ch);
          ctx.save();
          ctx.filter = videoFilterCss !== 'none' ? videoFilterCss : 'none';
          ctx.drawImage(video, 0, 0, cw, ch);
          ctx.restore();

          if (subtitleSampleText?.trim()) {
            const subText = subtitleSampleText.trim().slice(0, 48);
            ctx.save();
            ctx.font = 'bold 12px sans-serif';
            const tw = Math.min(cw - 24, ctx.measureText(subText).width + 18);
            const sy =
              subtitlePosition === 'Trên' ? 14 : subtitlePosition === 'Giữa' ? ch / 2 - 12 : ch - 34;
            ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
            ctx.fillRect((cw - tw) / 2, sy, tw, 22);
            ctx.fillStyle = highlightColor;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(subText, cw / 2, sy + 11, cw - 28);
            ctx.restore();
          }

          if (watermarkOutro.watermarkEnabled && watermarkOutro.watermarkText.trim()) {
            ctx.save();
            ctx.globalAlpha = watermarkOutro.watermarkOpacity;
            ctx.font = 'bold 10px sans-serif';
            const wm = watermarkOutro.watermarkText.trim();
            const wmW = Math.min(cw - 16, ctx.measureText(wm).width + 12);
            const pad = 8;
            const wx = watermarkOutro.watermarkCorner.includes('left') ? pad : cw - wmW - pad;
            const wy = watermarkOutro.watermarkCorner.includes('top') ? pad : ch - 20 - pad;
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(wx, wy, wmW, 18);
            ctx.fillStyle = '#FFFFFF';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(wm, wx + 6, wy + 9, cw - 20);
            ctx.restore();
          }

          if (i === targets.length - 1 && watermarkOutro.outroSeconds > 0 && watermarkOutro.outroLine1.trim()) {
            ctx.save();
            ctx.fillStyle = 'rgba(79, 70, 229, 0.85)';
            ctx.fillRect(8, 8, Math.min(cw - 16, 130), 16);
            ctx.fillStyle = '#FFFFFF';
            ctx.font = 'bold 9px sans-serif';
            ctx.textBaseline = 'middle';
            ctx.fillText(`+ Outro ${watermarkOutro.outroSeconds}s`, 14, 16);
            ctx.restore();
          }

          nextSnaps.push({
            label: target.label,
            timeSec: target.timeSec,
            dataUrl: canvas.toDataURL('image/jpeg', 0.8),
          });
        }

        if (!cancelled) {
          setSnapshots(nextSnaps);
        }
      } catch {
        if (!cancelled) setSnapshots([]);
      } finally {
        if (!cancelled) setIsCapturing(false);
        video.src = '';
      }
    };

    void captureFrames();
    return () => {
      cancelled = true;
      video.src = '';
    };
  }, [
    videoUrl,
    videoFilterCss,
    watermarkOutro.watermarkEnabled,
    watermarkOutro.watermarkText,
    watermarkOutro.watermarkCorner,
    watermarkOutro.watermarkOpacity,
    watermarkOutro.outroSeconds,
    watermarkOutro.outroLine1,
    subtitleSampleText,
    highlightColor,
    subtitlePosition,
  ]);

  if (!videoUrl) return null;

  return (
    <div className="pt-2 border-t border-slate-800 space-y-1.5">
      <div className="flex items-center justify-between text-[10px] text-slate-400">
        <span>Ảnh xem trước nhanh 3 mốc (bấm ảnh để tua nhanh)</span>
        {isCapturing && <span className="text-indigo-300">Đang chụp khung hình...</span>}
      </div>
      {snapshots.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {snapshots.map((snap) => (
            <button
              key={snap.label}
              type="button"
              onClick={() => onSeek?.(snap.timeSec)}
              className="group relative rounded-md overflow-hidden border border-slate-700 hover:border-indigo-400 bg-slate-950 text-left"
            >
              <img
                src={snap.dataUrl}
                alt={snap.label}
                className="w-full h-16 object-cover group-hover:opacity-90"
              />
              <div className="px-1.5 py-0.5 bg-slate-950/90 text-[10px] text-slate-300 font-mono flex items-center justify-between">
                <span>{snap.label}</span>
                <span>{snap.timeSec.toFixed(1)}s</span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

interface WatermarkOutroSectionProps {
  config: EduWatermarkOutroConfig;
  onChange: (next: EduWatermarkOutroConfig) => void;
  title?: string;
}

const WatermarkOutroSection: React.FC<WatermarkOutroSectionProps> = ({
  config,
  onChange,
  title = 'Watermark & Outro (Tùy chọn)',
}) => (
  <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="text-xs font-bold text-slate-800">{title}</div>
      <label className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 cursor-pointer">
        <input
          type="checkbox"
          checked={config.watermarkEnabled}
          onChange={(e) => onChange({ ...config, watermarkEnabled: e.target.checked })}
          className="rounded border-slate-300 text-indigo-600"
        />
        <span>Bật Watermark xuyên suốt video</span>
      </label>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">Nội dung Watermark</label>
        <input
          type="text"
          disabled={!config.watermarkEnabled}
          value={config.watermarkText}
          onChange={(e) => onChange({ ...config, watermarkText: e.target.value })}
          placeholder="@EnglishChannel"
          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg disabled:opacity-50"
        />
      </div>
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">Góc đặt</label>
        <select
          disabled={!config.watermarkEnabled}
          value={config.watermarkCorner}
          onChange={(e) =>
            onChange({ ...config, watermarkCorner: e.target.value as EduWatermarkCorner })
          }
          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg disabled:opacity-50"
        >
          <option value="bottom-right">Dưới phải</option>
          <option value="bottom-left">Dưới trái</option>
          <option value="top-right">Trên phải</option>
          <option value="top-left">Trên trái</option>
        </select>
      </div>
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">
          Độ mờ / Opacity ({Math.round(config.watermarkOpacity * 100)}%)
        </label>
        <input
          type="range"
          disabled={!config.watermarkEnabled}
          min={0.15}
          max={1}
          step={0.05}
          value={config.watermarkOpacity}
          onChange={(e) => onChange({ ...config, watermarkOpacity: Number(e.target.value) })}
          className="w-full accent-indigo-600 mt-1.5 disabled:opacity-50"
        />
      </div>
    </div>

    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1 border-t border-slate-200/70">
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">Outro dòng 1</label>
        <input
          type="text"
          value={config.outroLine1}
          onChange={(e) => onChange({ ...config, outroLine1: e.target.value })}
          placeholder="Thanks for watching!"
          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
        />
      </div>
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">Outro dòng 2</label>
        <input
          type="text"
          value={config.outroLine2}
          onChange={(e) => onChange({ ...config, outroLine2: e.target.value })}
          placeholder="See you next time"
          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
        />
      </div>
      <div>
        <label className="block text-[11px] text-slate-600 mb-1">
          Thời lượng Outro ({config.outroSeconds}s)
        </label>
        <input
          type="range"
          min={0}
          max={6}
          step={0.5}
          value={config.outroSeconds}
          onChange={(e) => onChange({ ...config, outroSeconds: Number(e.target.value) })}
          className="w-full accent-indigo-600 mt-1.5"
        />
      </div>
    </div>
  </div>
);

export const EducationalStudioTab: React.FC<EducationalStudioTabProps> = ({
  onSendAudioCuesToStudio,
}) => {
  const [initialEduSaved] = useState(() => loadPersistedSettings().eduStudio);
  const [subTab, setSubTab] = useState<'merge' | 'karaoke' | 'align'>(
    () => initialEduSaved?.subTab || 'merge',
  );

  // ── Shared Watermark & Outro (Tùy chọn) across all Edu Studio 1.19 tabs ────
  const [watermarkOutro, setWatermarkOutro] = useState<EduWatermarkOutroConfig>(() => ({
    watermarkEnabled: true,
    watermarkText: 'YOUR CHANNEL',
    watermarkCorner: 'bottom-right',
    watermarkOpacity: 0.65,
    outroSeconds: 3,
    outroLine1: 'Thanks for watching!',
    outroLine2: 'See you next time',
    ...(initialEduSaved?.watermarkOutro || {}),
  }));

  // ── Shared Output Folder Config ────────────────────────────────────────────
  const [outputFolders, setOutputFolders] = useState<string[]>([]);
  const [selectedSavePath, setSelectedSavePath] = useState<string>(
    () => initialEduSaved?.selectedSavePath || '',
  );
  const [localDirHandle, setLocalDirHandle] = useState<any>(null);
  const [localDirName, setLocalDirName] = useState<string | null>(null);
  const [folderStatusMsg, setFolderStatusMsg] = useState<string | null>(null);

  const supportsLocalFolderPicker =
    typeof window !== 'undefined' && typeof (window as any).showDirectoryPicker === 'function';

  const refreshOutputFolders = useCallback(async () => {
    try {
      const foldersRes = await fetch('/api/output/folders').catch(() => null);
      if (foldersRes && foldersRes.ok) {
        const fData = (await foldersRes.json()) as { folders?: string[] };
        if (Array.isArray(fData.folders)) {
          setOutputFolders(fData.folders);
        }
      }
    } catch {
      // ignore offline
    }
  }, []);

  useEffect(() => {
    void refreshOutputFolders();
  }, [refreshOutputFolders]);

  const handlePickLocalOutputFolder = async () => {
    if (!supportsLocalFolderPicker) return;
    try {
      const handle = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      setLocalDirHandle(handle);
      setLocalDirName(handle?.name || 'Thư mục máy tính');
      setFolderStatusMsg(
        `Đã chọn thư mục lưu bổ sung trên máy: "${handle?.name}". Khi render xong file sẽ tự động lưu thêm vào thư mục này.`,
      );
    } catch {
      // cancelled
    }
  };

  const saveServerFileToLocalDir = useCallback(
    async (relativePath: string, fileName: string) => {
      if (!localDirHandle) return false;
      try {
        const resp = await fetch(`/api/output/download?path=${encodeURIComponent(relativePath)}`);
        if (!resp.ok) return false;
        const blob = await resp.blob();
        const fileHandle = await localDirHandle.getFileHandle(fileName, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
      } catch {
        return false;
      }
    },
    [localDirHandle],
  );

  const renderOutputFolderControl = () => (
    <div className="p-3 rounded-xl bg-emerald-50/60 border border-emerald-200/80 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="text-[11px] font-bold text-emerald-950 inline-flex items-center gap-1.5">
          <FolderPlus className="w-3.5 h-3.5 text-emerald-700" />
          <span>Thư mục Output lưu file</span>
        </label>
        {supportsLocalFolderPicker && (
          <button
            type="button"
            onClick={() => void handlePickLocalOutputFolder()}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-emerald-800 bg-white border border-emerald-300 rounded-md hover:bg-emerald-50"
          >
            <FolderOpen className="w-3 h-3" />
            <span>
              {localDirName ? `Thư mục máy: ${localDirName}` : 'Chọn thêm thư mục trên máy...'}
            </span>
          </button>
        )}
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <select
          aria-label="Chọn thư mục Output có sẵn"
          value={outputFolders.includes(selectedSavePath) ? selectedSavePath : '__custom__'}
          onChange={(e) => {
            if (e.target.value !== '__custom__') {
              setSelectedSavePath(e.target.value);
            }
          }}
          className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-mono"
        >
          <option value="">Tự động theo module (Edu Merge / Edu Karaoke / Reading Along)</option>
          {outputFolders.map((folder) => (
            <option key={folder} value={folder}>
              output/{folder}
            </option>
          ))}
          {!outputFolders.includes(selectedSavePath) && selectedSavePath !== '' && (
            <option value="__custom__">Thư mục mới: output/{selectedSavePath}</option>
          )}
        </select>
        <input
          type="text"
          value={selectedSavePath}
          onChange={(e) => setSelectedSavePath(e.target.value)}
          placeholder="Để trống = tự vào thư mục con của module trong output/"
          className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-mono"
        />
      </div>
    </div>
  );

  // ── Sub-tab 1: Merge Video + Audio (Single & Batch Pairing) + Watermark/Outro ──
  const [mergeMode, setMergeMode] = useState<'single' | 'batch'>('single');
  const [mergeVideoFile, setMergeVideoFile] = useState<File | null>(null);
  const [mergeAudioFile, setMergeAudioFile] = useState<File | null>(null);
  const [batchVideos, setBatchVideos] = useState<File[]>([]);
  const [batchAudios, setBatchAudios] = useState<File[]>([]);
  const [mergeVideoUrl, setMergeVideoUrl] = useState<string | null>(null);
  const [mergeAudioUrl, setMergeAudioUrl] = useState<string | null>(null);
  const mergePreviewVideoRef = useRef<HTMLVideoElement>(null);
  const mergePreviewAudioRef = useRef<HTMLAudioElement>(null);
  const [showMergeOutroPreview, setShowMergeOutroPreview] = useState(false);
  const [durationMode, setDurationMode] = useState<'loop-video' | 'shortest'>('shortest');
  const [mergeOutputName, setMergeOutputName] = useState('');
  const [isMerging, setIsMerging] = useState(false);
  const [mergeProgress, setMergeProgress] = useState(0);
  const [mergeStatus, setMergeStatus] = useState<string>('');
  const [mergeError, setMergeError] = useState<string | null>(null);
  const mergeAbortRef = useRef<AbortController | null>(null);
  const activeMergeJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!mergeVideoFile) {
      setMergeVideoUrl(null);
      return;
    }
    const url = URL.createObjectURL(mergeVideoFile);
    setMergeVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [mergeVideoFile]);

  useEffect(() => {
    if (!mergeAudioFile) {
      setMergeAudioUrl(null);
      return;
    }
    const url = URL.createObjectURL(mergeAudioFile);
    setMergeAudioUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [mergeAudioFile]);

  const batchMatchedPairs = useMemo(() => {
    const audioMap = new Map<string, File>();
    for (const a of batchAudios) {
      const stem = a.name.replace(/\.[^.]+$/, '').toLowerCase();
      if (!audioMap.has(stem)) audioMap.set(stem, a);
    }
    const matched: Array<{ video: File; audio: File; stem: string }> = [];
    const missing: string[] = [];
    for (const v of batchVideos) {
      const stem = v.name.replace(/\.[^.]+$/, '').toLowerCase();
      const match = audioMap.get(stem);
      if (match) {
        matched.push({ video: v, audio: match, stem: v.name.replace(/\.[^.]+$/, '') });
      } else {
        missing.push(v.name);
      }
    }
    return { matched, missing };
  }, [batchVideos, batchAudios]);

  const handleCancelMerge = () => {
    mergeAbortRef.current?.abort();
    if (activeMergeJobIdRef.current) {
      void fetch(`/api/studio/job/${activeMergeJobIdRef.current}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
  };

  const runSingleMergeJob = async (
    video: File,
    audio: File,
    outStem: string,
    controller: AbortController,
    progressPrefix = '',
  ) => {
    const startRes = await fetch('/api/studio/job/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    });
    const startData = await parseApiJson<{ jobId?: string; error?: string }>(
      startRes,
      'Không khởi tạo được job ghép video',
    );
    if (!startRes.ok || !startData.jobId) {
      throw new Error(startData.error || 'Không khởi tạo được job ghép video.');
    }
    const jobId = startData.jobId;
    activeMergeJobIdRef.current = jobId;

    setMergeProgress(5);
    setMergeStatus(`${progressPrefix}Đang tải Video (${video.name})...`);
    await uploadStudioFileChunked(jobId, 'video', video, controller.signal);

    setMergeProgress(18);
    setMergeStatus(`${progressPrefix}Đang tải Audio (${audio.name})...`);
    await uploadStudioFileChunked(jobId, 'audio', audio, controller.signal);

    const outroText = [watermarkOutro.outroLine1.trim(), watermarkOutro.outroLine2.trim()]
      .filter(Boolean)
      .join('\n');

    setMergeProgress(25);
    setMergeStatus(`${progressPrefix}FFmpeg đang ghép Video + Audio + Watermark/Outro...`);

    const pollTimer = window.setInterval(async () => {
      try {
        const stRes = await fetch(`/api/studio/job/${jobId}/status`, { signal: controller.signal });
        if (!stRes.ok) return;
        const stData = (await stRes.json()) as { progress?: number; stageLabel?: string };
        if (typeof stData.progress === 'number' && stData.progress > 0) {
          setMergeProgress(Math.min(99, Math.max(25, stData.progress)));
        }
        if (stData.stageLabel) {
          setMergeStatus(`${progressPrefix}${stData.stageLabel}`);
        }
      } catch {
        // ignore poll glitch
      }
    }, 450);

    try {
      const finishRes = await fetch(`/api/studio/job/${jobId}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          durationMode,
          watermarkEnabled: watermarkOutro.watermarkEnabled,
          watermarkText: watermarkOutro.watermarkText,
          watermarkCorner: watermarkOutro.watermarkCorner,
          watermarkOpacity: watermarkOutro.watermarkOpacity,
          outroText,
          outroDuration: watermarkOutro.outroSeconds,
          outputName: cleanOutputTitleStem(outStem, 'Edu Merged Video'),
          savePath: selectedSavePath.trim() || TAB_OUTPUT_SUBFOLDERS.merge,
        }),
      });
      const data = await parseApiJson<{
        ok?: boolean;
        fileName?: string;
        relativePath?: string;
        savedPath?: string;
        error?: string;
      }>(finishRes, 'Ghép video thất bại');
      if (!finishRes.ok) {
        throw new Error(data.error || 'Ghép video thất bại.');
      }
      setMergeProgress(100);
      let copiedLocal = false;
      if (data.relativePath && data.fileName && localDirHandle) {
        copiedLocal = await saveServerFileToLocalDir(data.relativePath, data.fileName);
      }
      return { ...data, copiedLocal };
    } finally {
      window.clearInterval(pollTimer);
    }
  };

  const handleRunMerge = async () => {
    if (isMerging) return;
    if (mergeMode === 'single' && (!mergeVideoFile || !mergeAudioFile)) return;
    if (mergeMode === 'batch' && batchMatchedPairs.matched.length === 0) return;

    setMergeError(null);
    setMergeProgress(2);
    setIsMerging(true);
    const controller = new AbortController();
    mergeAbortRef.current = controller;

    try {
      if (mergeMode === 'single' && mergeVideoFile && mergeAudioFile) {
        const resolvedName = cleanOutputTitleStem(
          mergeOutputName.trim() || mergeVideoFile.name.replace(/\.[^.]+$/, ''),
          'Edu Merged Video',
        );
        const data = await runSingleMergeJob(mergeVideoFile, mergeAudioFile, resolvedName, controller);
        setMergeStatus(
          `Hoàn tất! Đã lưu ${data.fileName} (${data.savedPath})${data.copiedLocal ? ` · Đã lưu thêm vào "${localDirName}"` : ''}`,
        );
        emitOutputUpdated({ relativePath: data.relativePath, sourceTab: 'Edu Merge' });
      } else {
        const pairs = batchMatchedPairs.matched;
        let lastRel: string | undefined;
        for (let i = 0; i < pairs.length; i++) {
          if (controller.signal.aborted) break;
          const p = pairs[i];
          const res = await runSingleMergeJob(
            p.video,
            p.audio,
            p.stem,
            controller,
            `[${i + 1}/${pairs.length}] `,
          );
          if (res.relativePath) lastRel = res.relativePath;
        }
        emitOutputUpdated({ relativePath: lastRel, sourceTab: 'Edu Merge' });
        setMergeStatus(
          `Hoàn tất Batch! Đã ghép ${pairs.length} cặp video+audio vào thư mục Output${localDirHandle ? ` và "${localDirName}"` : ''}.`,
        );
      }
      await refreshOutputFolders();
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        setMergeStatus('Đã hủy tác vụ ghép video.');
      } else {
        setMergeError(err instanceof Error ? err.message : 'Lỗi FFmpeg ghép video.');
        setMergeStatus('');
      }
    } finally {
      activeMergeJobIdRef.current = null;
      mergeAbortRef.current = null;
      setIsMerging(false);
    }
  };

  // ── Sub-tab 2: Add Karaoke Sub (.ass) + Mix Audio/SFX/Voice + Watermark/Outro ──
  const [kmVideoFile, setKmVideoFile] = useState<File | null>(null);
  const [kmVideoUrl, setKmVideoUrl] = useState<string | null>(null);
  const [kmPreviewTimeSec, setKmPreviewTimeSec] = useState(0);
  const [kmMusicFile, setKmMusicFile] = useState<File | null>(null);
  const [kmSfxFile, setKmSfxFile] = useState<File | null>(null);
  const [kmMusicPreset, setKmMusicPreset] = useState<'lofi-calm' | 'soft-study' | 'none'>(
    () => initialEduSaved?.kmMusicPreset || 'lofi-calm',
  );
  const [kmSfxPreset, setKmSfxPreset] = useState<'soft-rain' | 'cafe-room' | 'none'>(
    () => initialEduSaved?.kmSfxPreset || 'soft-rain',
  );
  const [kmVoiceFile, setKmVoiceFile] = useState<File | null>(null);
  const [kmVoiceUrl, setKmVoiceUrl] = useState<string | null>(null);
  const [kmSrtInput, setKmSrtInput] = useState(
    `1\n00:00:00,200 --> 00:00:03,400\nWelcome to Educational Audio Video Studio.\n\n2\n00:00:03,600 --> 00:00:07,000\nLet us practice speaking naturally every day.`,
  );
  const [kmAssContent, setKmAssContent] = useState('');
  const [kmStyleId, setKmStyleId] = useState<string>(
    () => initialEduSaved?.kmStyleId || KARAOKE_EFFECT_PRESETS[0].id,
  );
  const [kmSubPosition, setKmSubPosition] = useState<EduKaraokePosition>(
    () => (initialEduSaved?.kmSubPosition as EduKaraokePosition) || 'Dưới',
  );
  const [kmSubSize, setKmSubSize] = useState<EduKaraokeSize>(
    () => (initialEduSaved?.kmSubSize as EduKaraokeSize) || 'Vừa',
  );
  const [kmHighlightColor, setKmHighlightColor] = useState(
    () => initialEduSaved?.kmHighlightColor || KARAOKE_EFFECT_PRESETS[0].activeColor,
  );
  const [kmEffect, setKmEffect] = useState(() => initialEduSaved?.kmEffect || 'Fade cinematic');
  const [kmMuteOriginal, setKmMuteOriginal] = useState(() => Boolean(initialEduSaved?.kmMuteOriginal));
  const [kmRemoveDialogue, setKmRemoveDialogue] = useState(() => Boolean(initialEduSaved?.kmRemoveDialogue));
  const [kmVoicePriority, setKmVoicePriority] = useState(() =>
    typeof initialEduSaved?.kmVoicePriority === 'boolean' ? initialEduSaved.kmVoicePriority : true,
  );
  const [kmOriginalVol, setKmOriginalVol] = useState(() =>
    typeof initialEduSaved?.kmOriginalVol === 'number' ? initialEduSaved.kmOriginalVol : 0.45,
  );
  const [kmMusicVol, setKmMusicVol] = useState(() =>
    typeof initialEduSaved?.kmMusicVol === 'number' ? initialEduSaved.kmMusicVol : 0.2,
  );
  const [kmSfxVol, setKmSfxVol] = useState(() =>
    typeof initialEduSaved?.kmSfxVol === 'number' ? initialEduSaved.kmSfxVol : 0.1,
  );
  const [kmVoiceVol, setKmVoiceVol] = useState(() =>
    typeof initialEduSaved?.kmVoiceVol === 'number' ? initialEduSaved.kmVoiceVol : 1.0,
  );
  const [kmVoiceStart, setKmVoiceStart] = useState(0);
  const [kmOutputName, setKmOutputName] = useState('');
  const [isRenderingKm, setIsRenderingKm] = useState(false);
  const [kmProgress, setKmProgress] = useState(0);
  const [kmStatus, setKmStatus] = useState('');
  const [kmError, setKmError] = useState<string | null>(null);
  const kmVideoRef = useRef<HTMLVideoElement>(null);
  const kmVoiceRef = useRef<HTMLAudioElement>(null);
  const kmAbortRef = useRef<AbortController | null>(null);
  const activeKmJobIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!kmVideoFile) {
      setKmVideoUrl(null);
      return;
    }
    const url = URL.createObjectURL(kmVideoFile);
    setKmVideoUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [kmVideoFile]);

  useEffect(() => {
    if (!kmVoiceFile) {
      setKmVoiceUrl(null);
      return;
    }
    const url = URL.createObjectURL(kmVoiceFile);
    setKmVoiceUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [kmVoiceFile]);

  const kmEffectSpec = useMemo(
    () => KARAOKE_EFFECT_PRESETS.find((e) => e.id === kmStyleId) ?? KARAOKE_EFFECT_PRESETS[0],
    [kmStyleId],
  );

  const kmParsedPreviewCues = useMemo(() => parseTranscriptAuto(kmSrtInput), [kmSrtInput]);
  const kmActiveCue = useMemo(
    () =>
      kmParsedPreviewCues.find((c) => kmPreviewTimeSec >= c.start && kmPreviewTimeSec <= c.end) ??
      kmParsedPreviewCues[0] ??
      null,
    [kmParsedPreviewCues, kmPreviewTimeSec],
  );

  const handleGenerateAss = () => {
    const ass = buildEduKaraokeAss(kmSrtInput, {
      effectId: kmStyleId,
      activeColorOverride: kmHighlightColor,
      position: kmSubPosition,
      size: kmSubSize,
    });
    setKmAssContent(ass);
  };

  const handleCancelKaraokeMix = () => {
    kmAbortRef.current?.abort();
    if (activeKmJobIdRef.current) {
      void fetch(`/api/studio/job/${activeKmJobIdRef.current}`, { method: 'DELETE' }).catch(
        () => undefined,
      );
    }
  };

  const handleRunKaraokeMix = async () => {
    if (!kmVideoFile || isRenderingKm) return;
    setKmError(null);
    setIsRenderingKm(true);
    setKmProgress(3);
    setKmStatus('Đang tạo job Karaoke & Audio Mix...');
    const controller = new AbortController();
    kmAbortRef.current = controller;
    let pollTimer: number | null = null;

    try {
      const startRes = await fetch('/api/studio/job/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
      });
      const startData = await parseApiJson<{ jobId?: string; error?: string }>(
        startRes,
        'Không tạo được Studio job',
      );
      if (!startRes.ok || !startData.jobId) {
        throw new Error(startData.error || 'Không tạo được Studio job.');
      }
      const jobId = startData.jobId;
      activeKmJobIdRef.current = jobId;

      setKmProgress(8);
      setKmStatus(`Đang tải Video nền (${kmVideoFile.name})...`);
      await uploadStudioFileChunked(jobId, 'video', kmVideoFile, controller.signal);

      if (kmMusicFile) {
        setKmProgress(14);
        setKmStatus(`Đang tải Nhạc nền (${kmMusicFile.name})...`);
        await uploadStudioFileChunked(jobId, 'music', kmMusicFile, controller.signal);
      }
      if (kmSfxFile) {
        setKmProgress(18);
        setKmStatus(`Đang tải Ambient SFX (${kmSfxFile.name})...`);
        await uploadStudioFileChunked(jobId, 'sfx', kmSfxFile, controller.signal);
      }
      if (kmVoiceFile) {
        setKmProgress(22);
        setKmStatus(`Đang tải Voiceover (${kmVoiceFile.name})...`);
        await uploadStudioFileChunked(jobId, 'voice', kmVoiceFile, controller.signal);
      }

      const finalAss =
        kmAssContent.trim() ||
        (kmSrtInput.trim()
          ? buildEduKaraokeAss(kmSrtInput, {
              effectId: kmStyleId,
              activeColorOverride: kmHighlightColor,
              position: kmSubPosition,
              size: kmSubSize,
            })
          : '');

      const resolvedKmName = cleanOutputTitleStem(
        kmOutputName.trim() || kmVideoFile.name.replace(/\.[^.]+$/, ''),
        'Edu Karaoke Video',
      );
      const outroText = [watermarkOutro.outroLine1.trim(), watermarkOutro.outroLine2.trim()]
        .filter(Boolean)
        .join('\n');

      setKmProgress(25);
      setKmStatus('FFmpeg đang hòa âm Ducking, đốt Karaoke (.ass) & Watermark/Outro...');
      pollTimer = window.setInterval(async () => {
        try {
          const stRes = await fetch(`/api/studio/job/${jobId}/status`, { signal: controller.signal });
          if (!stRes.ok) return;
          const stData = (await stRes.json()) as { progress?: number; stageLabel?: string };
          if (typeof stData.progress === 'number' && stData.progress > 0) {
            setKmProgress(Math.min(99, Math.max(25, stData.progress)));
          }
          if (stData.stageLabel) {
            setKmStatus(stData.stageLabel);
          }
        } catch {
          // ignore poll glitch
        }
      }, 450);

      const mixRes = await fetch(`/api/studio/job/${jobId}/karaoke-mix`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          assContent: finalAss,
          videoEffect: kmEffect,
          outroSeconds: watermarkOutro.outroSeconds,
          outroText,
          watermarkEnabled: watermarkOutro.watermarkEnabled,
          watermarkText: watermarkOutro.watermarkText,
          watermarkCorner: watermarkOutro.watermarkCorner,
          watermarkOpacity: watermarkOutro.watermarkOpacity,
          muteOriginal: kmMuteOriginal,
          removeDialogue: kmRemoveDialogue,
          originalVolume: kmOriginalVol,
          musicVolume: kmMusicVol,
          sfxVolume: kmSfxVol,
          voiceVolume: kmVoiceVol,
          voiceStart: kmVoiceStart,
          voicePriority: kmVoicePriority,
          musicPreset: kmMusicFile ? 'none' : kmMusicPreset,
          sfxPreset: kmSfxFile ? 'none' : kmSfxPreset,
          outputName: resolvedKmName,
          savePath: selectedSavePath.trim() || TAB_OUTPUT_SUBFOLDERS.karaoke,
        }),
      });
      const data = await parseApiJson<{
        ok?: boolean;
        fileName?: string;
        relativePath?: string;
        savedPath?: string;
        error?: string;
      }>(mixRes, 'Lỗi render Karaoke & Mix');
      if (!mixRes.ok) {
        throw new Error(data.error || 'Lỗi render Karaoke & Mix.');
      }
      setKmProgress(100);
      let extraLocalMsg = '';
      if (data.relativePath && data.fileName && localDirHandle) {
        const copied = await saveServerFileToLocalDir(data.relativePath, data.fileName);
        if (copied) {
          extraLocalMsg = ` · Đã lưu thêm vào "${localDirName}"`;
        }
      }
      setKmStatus(`Hoàn tất! Đã lưu ${data.fileName} (${data.savedPath})${extraLocalMsg}`);
      emitOutputUpdated({ relativePath: data.relativePath, sourceTab: 'Edu Karaoke' });
      await refreshOutputFolders();
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === 'AbortError')) {
        setKmStatus('Đã hủy tác vụ Karaoke & Mix.');
      } else {
        setKmError(err instanceof Error ? err.message : 'Lỗi FFmpeg Karaoke & Mix.');
        setKmStatus('');
      }
    } finally {
      if (pollTimer !== null) window.clearInterval(pollTimer);
      activeKmJobIdRef.current = null;
      kmAbortRef.current = null;
      setIsRenderingKm(false);
    }
  };

  // ── Sub-tab 3: Reading Along Studio (Book + Pointer Hand + Whisper + MP4 Export) ──
  const [showKmOutroPreview, setShowKmOutroPreview] = useState(false);
  const { keys: clientKeys } = useClientApiKeys();
  const [readingTitle, setReadingTitle] = useState('A Simple Morning Routine');
  const [readingTopic, setReadingTopic] = useState('Daily life · A1');
  const [readingPaletteId, setReadingPaletteId] =
    useState<ReadingBookPalette['id']>(
      () => (initialEduSaved?.readingPaletteId as ReadingBookPalette['id']) || 'Sunny Yellow',
    );
  const [readingIllustration, setReadingIllustration] =
    useState<ReadingIllustrationStyle>(
      () => (initialEduSaved?.readingIllustration as ReadingIllustrationStyle) || '2.5D',
    );
  const [readingBookFrame, setReadingBookFrame] =
    useState<ReadingBookFrameId>(
      () => (initialEduSaved?.readingBookFrame as ReadingBookFrameId) || 'classic-page',
    );
  const [readingPointerStyle, setReadingPointerStyle] =
    useState<ReadingPointerStyleId>(
      () => (initialEduSaved?.readingPointerStyle as ReadingPointerStyleId) || 'hand-classic',
    );
  const [readingText, setReadingText] = useState(
    `Tom wakes up early every morning.\nHe opens the window and makes his bed.\nThen he drinks a glass of water and eats breakfast.\nHe checks the time, takes his bag, and leaves home.\nA good morning helps him start the day with energy.`,
  );
  const [readingIntroEnabled, setReadingIntroEnabled] = useState(() =>
    typeof initialEduSaved?.readingIntroEnabled === 'boolean' ? initialEduSaved.readingIntroEnabled : true,
  );
  const [readingIntroText, setReadingIntroText] = useState(
    "Today's reading lesson: A Simple Morning Routine. Listen carefully and read along word by word.",
  );
  const [isReadingIntroCustom, setIsReadingIntroCustom] = useState(false);
  const [readingIntroSeconds, setReadingIntroSeconds] = useState(() =>
    typeof initialEduSaved?.readingIntroSeconds === 'number' ? initialEduSaved.readingIntroSeconds : 3.4,
  );
  const [readingOutroSpeechEnabled, setReadingOutroSpeechEnabled] = useState(() =>
    typeof initialEduSaved?.readingOutroSpeechEnabled === 'boolean' ? initialEduSaved.readingOutroSpeechEnabled : true,
  );
  const [readingBgmPreset, setReadingBgmPreset] = useState<StudioBgmPresetId>(
    () => initialEduSaved?.readingBgmPreset || 'lofi-calm',
  );
  const [readingBgmVolume, setReadingBgmVolume] = useState(() =>
    typeof initialEduSaved?.readingBgmVolume === 'number' ? initialEduSaved.readingBgmVolume : 0.18,
  );
  const [isCustomAlignAudio, setIsCustomAlignAudio] = useState(false);
  const [synthesizedReadingSig, setSynthesizedReadingSig] = useState('');
  const [alignFile, setAlignFile] = useState<File | null>(null);
  const [alignAudioUrl, setAlignAudioUrl] = useState<string | null>(null);
  const [alignAudioDur, setAlignAudioDur] = useState<number>(14);
  const [alignMode, setAlignMode] = useState<'fast-forced' | 'whisper'>(
    () => initialEduSaved?.alignMode || 'fast-forced',
  );
  const [alignLang, setAlignLang] = useState(() => initialEduSaved?.alignLang || 'auto');
  const [alignModel, setAlignModel] = useState(() => initialEduSaved?.alignModel || 'Xenova/whisper-small');
  const [readingTtsRate, setReadingTtsRate] = useState(() =>
    typeof initialEduSaved?.readingTtsRate === 'number' ? initialEduSaved.readingTtsRate : 1.0,
  );
  const [ttsVoices, setTtsVoices] = useState<TtsProviderItem[]>([]);
  const [readingProvider, setReadingProvider] = useState<string>(
    () => initialEduSaved?.readingProvider || 'auto',
  );
  const [hasReadingGeminiKey, setHasReadingGeminiKey] = useState(false);
  const [hasReadingElevenLabsKey, setHasReadingElevenLabsKey] = useState(false);
  const [readingVoice, setReadingVoice] = useState(
    () => initialEduSaved?.readingVoice || 'en-US-JennyNeural',
  );
  const [isGeneratingReadingTts, setIsGeneratingReadingTts] = useState(false);
  const [readingTtsProgress, setReadingTtsProgress] = useState(0);
  const [readingTtsStageLabel, setReadingTtsStageLabel] = useState('');
  const [isAligning, setIsAligning] = useState(false);
  const [alignError, setAlignError] = useState<string | null>(null);
  const [readingAspect, setReadingAspect] = useState<ExportAspectRatioId>(
    () => initialEduSaved?.readingAspect || '9:16',
  );
  const [readingResolution, setReadingResolution] = useState<ExportResolutionId>(
    () => initialEduSaved?.readingResolution || '720p',
  );
  const [readingQuality, setReadingQuality] = useState<ExportQualityId>(
    () => initialEduSaved?.readingQuality || 'high',
  );
  const [readingFps, setReadingFps] = useState<ExportFpsOption>(
    () => initialEduSaved?.readingFps || 30,
  );

  useEffect(() => {
    const onHydrated = (ev: Event) => {
      const s = (ev as CustomEvent<PersistedStudioSettings>).detail?.eduStudio;
      if (!s) return;
      if (s.subTab) setSubTab(s.subTab);
      if (s.selectedSavePath !== undefined) setSelectedSavePath(s.selectedSavePath);
      if (s.watermarkOutro) setWatermarkOutro(s.watermarkOutro);
      if (s.kmStyleId) setKmStyleId(s.kmStyleId);
      if (s.kmSubPosition) setKmSubPosition(s.kmSubPosition);
      if (s.kmSubSize) setKmSubSize(s.kmSubSize);
      if (s.kmHighlightColor) setKmHighlightColor(s.kmHighlightColor);
      if (s.kmEffect) setKmEffect(s.kmEffect);
      if (s.kmMusicPreset) setKmMusicPreset(s.kmMusicPreset);
      if (s.kmSfxPreset) setKmSfxPreset(s.kmSfxPreset);
      if (typeof s.kmMuteOriginal === 'boolean') setKmMuteOriginal(s.kmMuteOriginal);
      if (typeof s.kmRemoveDialogue === 'boolean') setKmRemoveDialogue(s.kmRemoveDialogue);
      if (typeof s.kmVoicePriority === 'boolean') setKmVoicePriority(s.kmVoicePriority);
      if (typeof s.kmOriginalVol === 'number') setKmOriginalVol(s.kmOriginalVol);
      if (typeof s.kmMusicVol === 'number') setKmMusicVol(s.kmMusicVol);
      if (typeof s.kmSfxVol === 'number') setKmSfxVol(s.kmSfxVol);
      if (typeof s.kmVoiceVol === 'number') setKmVoiceVol(s.kmVoiceVol);
      if (s.readingPaletteId) setReadingPaletteId(s.readingPaletteId as ReadingBookPalette['id']);
      if (s.readingIllustration) setReadingIllustration(s.readingIllustration as ReadingIllustrationStyle);
      if (s.readingBookFrame) setReadingBookFrame(s.readingBookFrame as ReadingBookFrameId);
      if (s.readingPointerStyle) setReadingPointerStyle(s.readingPointerStyle as ReadingPointerStyleId);
      if (typeof s.readingIntroEnabled === 'boolean') setReadingIntroEnabled(s.readingIntroEnabled);
      if (typeof s.readingIntroSeconds === 'number') setReadingIntroSeconds(s.readingIntroSeconds);
      if (typeof s.readingOutroSpeechEnabled === 'boolean') setReadingOutroSpeechEnabled(s.readingOutroSpeechEnabled);
      if (s.readingBgmPreset) setReadingBgmPreset(s.readingBgmPreset);
      if (typeof s.readingBgmVolume === 'number') setReadingBgmVolume(s.readingBgmVolume);
      if (s.alignMode) setAlignMode(s.alignMode);
      if (s.alignLang) setAlignLang(s.alignLang);
      if (s.alignModel) setAlignModel(s.alignModel);
      if (s.readingProvider) setReadingProvider(s.readingProvider);
      if (s.readingVoice) setReadingVoice(s.readingVoice);
      if (typeof s.readingTtsRate === 'number') setReadingTtsRate(s.readingTtsRate);
      if (s.readingAspect) setReadingAspect(s.readingAspect);
      if (s.readingResolution) setReadingResolution(s.readingResolution);
      if (s.readingQuality) setReadingQuality(s.readingQuality);
      if (s.readingFps) setReadingFps(s.readingFps);
    };
    const onReset = () => {
      setSubTab('merge');
      setSelectedSavePath('');
      setWatermarkOutro({
        watermarkEnabled: true,
        watermarkText: 'YOUR CHANNEL',
        watermarkCorner: 'bottom-right',
        watermarkOpacity: 0.65,
        outroSeconds: 3,
        outroLine1: 'Thanks for watching!',
        outroLine2: 'See you next time',
      });
      setKmStyleId(KARAOKE_EFFECT_PRESETS[0].id);
      setKmSubPosition('Dưới');
      setKmSubSize('Vừa');
      setKmHighlightColor(KARAOKE_EFFECT_PRESETS[0].activeColor);
      setKmEffect('Fade cinematic');
      setKmMusicPreset('lofi-calm');
      setKmSfxPreset('soft-rain');
      setKmMuteOriginal(false);
      setKmRemoveDialogue(false);
      setKmVoicePriority(true);
      setKmOriginalVol(0.45);
      setKmMusicVol(0.2);
      setKmSfxVol(0.1);
      setKmVoiceVol(1.0);
      setReadingPaletteId('Sunny Yellow');
      setReadingIllustration('2.5D');
      setReadingBookFrame('classic-page');
      setReadingPointerStyle('hand-classic');
      setReadingIntroEnabled(true);
      setReadingIntroSeconds(3.4);
      setReadingOutroSpeechEnabled(true);
      setReadingBgmPreset('lofi-calm');
      setReadingBgmVolume(0.18);
      setAlignMode('fast-forced');
      setAlignLang('auto');
      setAlignModel('Xenova/whisper-small');
      setReadingProvider('auto');
      setReadingVoice('en-US-JennyNeural');
      setReadingTtsRate(1.0);
      setReadingAspect('9:16');
      setReadingResolution('720p');
      setReadingQuality('high');
      setReadingFps(30);
    };
    window.addEventListener(USER_SETTINGS_HYDRATED_EVENT, onHydrated);
    window.addEventListener(USER_SETTINGS_RESET_EVENT, onReset);
    return () => {
      window.removeEventListener(USER_SETTINGS_HYDRATED_EVENT, onHydrated);
      window.removeEventListener(USER_SETTINGS_RESET_EVENT, onReset);
    };
  }, []);

  useEffect(() => {
    updatePersistedSettings({
      eduStudio: {
        subTab,
        selectedSavePath,
        watermarkOutro,
        kmStyleId,
        kmSubPosition,
        kmSubSize,
        kmHighlightColor,
        kmEffect,
        kmMusicPreset,
        kmSfxPreset,
        kmMuteOriginal,
        kmRemoveDialogue,
        kmVoicePriority,
        kmOriginalVol,
        kmMusicVol,
        kmSfxVol,
        kmVoiceVol,
        readingPaletteId,
        readingIllustration,
        readingBookFrame,
        readingPointerStyle,
        readingIntroEnabled,
        readingIntroSeconds,
        readingOutroSpeechEnabled,
        readingBgmPreset,
        readingBgmVolume,
        alignMode,
        alignLang,
        alignModel,
        readingProvider,
        readingVoice,
        readingTtsRate,
        readingAspect,
        readingResolution,
        readingQuality,
        readingFps,
      },
    });
  }, [
    subTab,
    selectedSavePath,
    watermarkOutro,
    kmStyleId,
    kmSubPosition,
    kmSubSize,
    kmHighlightColor,
    kmEffect,
    kmMusicPreset,
    kmSfxPreset,
    kmMuteOriginal,
    kmRemoveDialogue,
    kmVoicePriority,
    kmOriginalVol,
    kmMusicVol,
    kmSfxVol,
    kmVoiceVol,
    readingPaletteId,
    readingIllustration,
    readingBookFrame,
    readingPointerStyle,
    readingIntroEnabled,
    readingIntroSeconds,
    readingOutroSpeechEnabled,
    readingBgmPreset,
    readingBgmVolume,
    alignMode,
    alignLang,
    alignModel,
    readingProvider,
    readingVoice,
    readingTtsRate,
    readingAspect,
    readingResolution,
    readingQuality,
    readingFps,
  ]);
  const [readingUrl, setReadingUrl] = useState('');
  const [readingUrlSubLinks, setReadingUrlSubLinks] = useState<Array<{ title: string; url: string }>>([]);
  const [scrapedWebSource, setScrapedWebSource] = useState<{
    url: string;
    title: string;
    rawText: string;
  } | null>(null);
  const [readingWebPromptMode, setReadingWebPromptMode] = useState<'web-url' | 'topic'>('web-url');
  const [isWebPromptOpen, setIsWebPromptOpen] = useState<boolean>(false);
  const [copiedReadingPrompt, setCopiedReadingPrompt] = useState<boolean>(false);
  const [pastedReadingAiResponse, setPastedReadingAiResponse] = useState<string>('');
  const [pastedReadingAiError, setPastedReadingAiError] = useState<string | null>(null);
  const [readingAiTopic, setReadingAiTopic] = useState('Morning habits for better focus');
  const [readingAiLevel, setReadingAiLevel] = useState<'A1' | 'A2' | 'B1' | 'B2' | 'C1'>('B1');
  const [readingAiLength, setReadingAiLength] = useState<number>(110);
  const [isScrapingOrGeneratingReading, setIsScrapingOrGeneratingReading] = useState(false);
  const [readingAiProgress, setReadingAiProgress] = useState(0);
  const [readingAiStageLabel, setReadingAiStageLabel] = useState('');
  const [alignCurrentSec, setAlignCurrentSec] = useState(0);
  const [isPlayingReadingPreview, setIsPlayingReadingPreview] = useState(false);
  const [isExportingReadingMp4, setIsExportingReadingMp4] = useState(false);
  const [readingExportProgress, setReadingExportProgress] = useState(0);
  const [readingExportStatus, setReadingExportStatus] = useState('');
  const readingAbortRef = useRef<AbortController | null>(null);

  const [alignResult, setAlignResult] = useState<{
    language?: string;
    modelUsed: string;
    backendUsed: string;
    durationSec: number;
    text: string;
    words: WordTiming[];
    cues: TranscriptCue[];
    srt: string;
  } | null>(null);
  const alignAudioRef = useRef<HTMLAudioElement>(null);
  const readingCanvasRef = useRef<HTMLCanvasElement>(null);

  const refreshReadingVoices = useCallback(() => {
    void fetchTtsVoicesCatalog()
      .then((res) => {
        setTtsVoices(res.providers);
        setHasReadingGeminiKey(res.hasGeminiKey);
        setHasReadingElevenLabsKey(res.hasElevenLabsKey);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refreshReadingVoices();
  }, [refreshReadingVoices]);

  const effectiveReadingGeminiKey = hasReadingGeminiKey || Boolean(clientKeys.geminiApiKey);
  const effectiveReadingElevenLabsKey =
    hasReadingElevenLabsKey || Boolean(clientKeys.elevenlabsApiKey);

  const allReadingVoices = useMemo(() => {
    if (readingProvider === 'auto') {
      return ttsVoices
        .filter(
          (p) =>
            (p.id !== 'gemini' || effectiveReadingGeminiKey) &&
            (p.id !== 'elevenlabs' || effectiveReadingElevenLabsKey),
        )
        .flatMap((p) => p.voices);
    }
    return ttsVoices.find((p) => p.id === readingProvider)?.voices ?? [];
  }, [ttsVoices, readingProvider, effectiveReadingGeminiKey, effectiveReadingElevenLabsKey]);

  useEffect(() => {
    if (allReadingVoices.length > 0 && !allReadingVoices.some((v) => v.id === readingVoice)) {
      setReadingVoice(allReadingVoices[0].id);
    }
  }, [allReadingVoices, readingVoice]);

  useEffect(() => {
    return () => {
      if (alignAudioUrl) URL.revokeObjectURL(alignAudioUrl);
    };
  }, [alignAudioUrl]);

  useEffect(() => {
    if (!isReadingIntroCustom) {
      const cleanTitle = readingTitle.trim() || 'English Reading Practice';
      setReadingIntroText(
        `Today's reading lesson: ${cleanTitle}. Listen carefully and read along word by word.`,
      );
    }
  }, [readingTitle, isReadingIntroCustom]);

  const outroSpeechText = useMemo(
    () => [watermarkOutro.outroLine1.trim(), watermarkOutro.outroLine2.trim()].filter(Boolean).join('. '),
    [watermarkOutro.outroLine1, watermarkOutro.outroLine2],
  );

  const currentReadingSig = useMemo(
    () =>
      JSON.stringify({
        readingTitle: readingTitle.trim(),
        readingText: readingText.trim(),
        readingProvider,
        readingVoice,
        readingTtsRate,
        readingIntroEnabled,
        readingIntroText: readingIntroEnabled ? readingIntroText.trim() : '',
        readingOutroSpeechEnabled,
        outroSpeechText:
          readingOutroSpeechEnabled && watermarkOutro.outroSeconds > 0 ? outroSpeechText : '',
        outroSeconds: watermarkOutro.outroSeconds,
        readingBgmPreset,
        readingBgmVolume: Number(readingBgmVolume.toFixed(2)),
      }),
    [
      readingTitle,
      readingText,
      readingProvider,
      readingVoice,
      readingTtsRate,
      readingIntroEnabled,
      readingIntroText,
      readingOutroSpeechEnabled,
      outroSpeechText,
      watermarkOutro.outroSeconds,
      readingBgmPreset,
      readingBgmVolume,
    ],
  );

  const activeIntroSec =
    readingIntroEnabled && readingIntroText.trim().length > 0 ? readingIntroSeconds : 0;

  const effectiveReadingWords = useMemo(() => {
    if (alignResult && alignResult.words.length > 0) return alignResult.words;
    const estTotal = alignAudioUrl
      ? Math.max(4, alignAudioDur - activeIntroSec)
      : Math.max(6, readingText.split(/\s+/).filter(Boolean).length * 0.42);
    return shiftReadingWordsForIntro(
      buildEstimatedReadingWords(readingText, estTotal),
      activeIntroSec,
    );
  }, [alignResult, readingText, alignAudioDur, alignAudioUrl, activeIntroSec]);

  const effectiveReadingContentDuration = useMemo(() => {
    const lastWordEnd =
      effectiveReadingWords.length > 0
        ? effectiveReadingWords[effectiveReadingWords.length - 1].end
        : activeIntroSec + 8;
    if (alignResult?.durationSec && alignResult.durationSec > activeIntroSec + 0.5) {
      return Math.max(activeIntroSec + 1.5, alignResult.durationSec, lastWordEnd + 0.3);
    }
    const audioBound = alignAudioUrl ? alignAudioDur : 0;
    return Math.max(activeIntroSec + 2, audioBound, lastWordEnd + 0.35);
  }, [effectiveReadingWords, alignResult, alignAudioDur, alignAudioUrl, activeIntroSec]);

  const readingTimeline = useMemo(
    () =>
      computeReadingTimelineMetrics({
        words: effectiveReadingWords,
        contentDuration: effectiveReadingContentDuration,
        introEnabled: readingIntroEnabled && readingIntroText.trim().length > 0,
        introSeconds: activeIntroSec,
        outroSeconds: watermarkOutro.outroSeconds,
        outroText: [watermarkOutro.outroLine1.trim(), watermarkOutro.outroLine2.trim()]
          .filter(Boolean)
          .join('\n'),
      }),
    [
      effectiveReadingWords,
      effectiveReadingContentDuration,
      readingIntroEnabled,
      readingIntroText,
      activeIntroSec,
      watermarkOutro,
    ],
  );

  const readingWebAiPrompt = useMemo(
    () =>
      buildReadingWebAiPrompt({
        mode: readingWebPromptMode,
        url: readingUrl || scrapedWebSource?.url,
        sourceTitle: scrapedWebSource?.title,
        sourceText: scrapedWebSource?.rawText,
        topic: readingAiTopic,
        level: readingAiLevel,
        wordCount: readingAiLength,
      }),
    [
      readingWebPromptMode,
      readingUrl,
      scrapedWebSource,
      readingAiTopic,
      readingAiLevel,
      readingAiLength,
    ],
  );

  const resolvedReadingDims = useMemo(
    () =>
      resolveMp4EncodingParams({
        ...DEFAULT_MP4_EXPORT_SETTINGS,
        aspectRatio: readingAspect,
        resolution: readingResolution,
        quality: readingQuality,
        fps: readingFps,
      }),
    [readingAspect, readingResolution, readingQuality, readingFps],
  );

  const previewCanvasDims = useMemo(() => {
    switch (readingAspect) {
      case '16:9':
        return { w: 960, h: 540, cls: 'aspect-video max-w-full' };
      case '1:1':
        return { w: 720, h: 720, cls: 'aspect-square max-h-[340px]' };
      case '4:5':
        return { w: 640, h: 800, cls: 'aspect-[4/5] max-h-[340px]' };
      default:
        return { w: 540, h: 960, cls: 'aspect-[9/16] max-h-[340px]' };
    }
  }, [readingAspect]);

  // Draw live Book + Pointer Hand + Intro/Outro Canvas Preview
  useEffect(() => {
    const canvas = readingCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    renderReadingAlongFrame(ctx, {
      width: canvas.width,
      height: canvas.height,
      title: readingTitle,
      topicBadge: readingTopic,
      text: readingText,
      words: effectiveReadingWords,
      currentTime: alignCurrentSec,
      contentDuration: readingTimeline.contentEnd,
      totalDuration: readingTimeline.effectiveTotalDuration,
      introEnabled: readingIntroEnabled && readingIntroText.trim().length > 0,
      introSeconds: activeIntroSec,
      introTitle: 'HÔM NAY HỌC GÌ? · TODAY GOAL',
      introSubtitle: readingIntroText.trim() || readingTitle,
      paletteId: readingPaletteId,
      illustrationStyle: readingIllustration,
      bookFrame: readingBookFrame,
      pointerStyle: readingPointerStyle,
      watermarkOutro,
    });
  }, [
    readingTitle,
    readingTopic,
    readingText,
    effectiveReadingWords,
    alignCurrentSec,
    readingTimeline.contentEnd,
    readingTimeline.effectiveTotalDuration,
    readingIntroEnabled,
    readingIntroText,
    activeIntroSec,
    readingPaletteId,
    readingIllustration,
    readingBookFrame,
    readingPointerStyle,
    watermarkOutro,
    previewCanvasDims.w,
    previewCanvasDims.h,
    subTab,
  ]);

  // Playback timer when previewing without audio or continuing into Outro after audio ends
  useEffect(() => {
    if (!isPlayingReadingPreview) return;
    let rafId = 0;
    let lastTs = performance.now();
    const totalLimit = readingTimeline.effectiveTotalDuration;
    const tick = (now: number) => {
      const dt = Math.min(0.1, (now - lastTs) / 1000);
      lastTs = now;
      if (
        alignAudioRef.current &&
        alignAudioUrl &&
        !alignAudioRef.current.paused &&
        !alignAudioRef.current.ended
      ) {
        setAlignCurrentSec(alignAudioRef.current.currentTime);
      } else {
        setAlignCurrentSec((prev) => {
          const next = prev + dt;
          if (next >= totalLimit) {
            setIsPlayingReadingPreview(false);
            return 0;
          }
          return next;
        });
      }
      rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafId);
  }, [isPlayingReadingPreview, alignAudioUrl, readingTimeline.effectiveTotalDuration]);

  interface GeneratedReadingBundle {
    audioFile: File;
    title: string;
    text: string;
    words: WordTiming[];
    contentEnd: number;
    totalDuration: number;
    introEnabled: boolean;
    introSeconds: number;
    introSubtitle: string;
    watermarkOutro: EduWatermarkOutroConfig;
  }

  const decodeBase64AudioClip = (
    base64: string,
    fileName: string,
    mimeType = 'audio/mpeg',
  ): File => {
    const bin = atob(base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return new File([bytes], fileName, { type: mimeType });
  };

  const handleGenerateReadingTts = async (): Promise<GeneratedReadingBundle | null> => {
    if (isGeneratingReadingTts || !readingText.trim()) return null;
    setAlignError(null);
    setIsGeneratingReadingTts(true);
    setReadingTtsProgress(4);
    setReadingTtsStageLabel('Đang làm sạch văn bản & tổng hợp giọng đọc...');
    try {
      // Strip worksheet scaffolding lines before reading aloud so audio & text match 1:1
      const cleanedInput = cleanReadingWorksheetInput(readingText, readingTitle);
      const cleanTitle = cleanedInput.title || readingTitle;
      const cleanBody = cleanedInput.bodyText || readingText.trim();
      if (cleanBody !== readingText.trim()) {
        setReadingText(cleanBody);
      }
      if (cleanTitle && cleanTitle !== readingTitle) {
        setReadingTitle(cleanTitle);
      }

      const cleanReadingTitle = cleanOutputTitleStem(cleanTitle, 'Reading Along');
      const voiceObj = allReadingVoices.find((v) => v.id === readingVoice);
      const baseLang = voiceObj?.lang || 'en-US';
      const activeIntroText = readingIntroEnabled
        ? (!isReadingIntroCustom
            ? `Today's reading lesson: ${cleanTitle}. Listen carefully and read along word by word.`
            : readingIntroText.trim())
        : '';

      const res = await synthesizeAudioAndSyncCues({
        rawScript: cleanBody,
        title: cleanTitle,
        provider: readingProvider,
        voice: readingVoice,
        lang: baseLang,
        rate: readingTtsRate,
        alignWithWhisper: true,
        whisperModel: alignModel,
        onProgress: (pct, label) => {
          setReadingTtsProgress(Math.round(pct * 0.7));
          setReadingTtsStageLabel(label);
        },
      });

      const bodyWords = res.cues.flatMap((c) => c.words);
      const partsToConcat: Array<{ file: File; pauseAfterSec?: number; role: 'intro' | 'body' | 'outro' }> = [];

      const hasVietnameseChars = (s: string) =>
        /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i.test(s);

      if (activeIntroText) {
        setReadingTtsProgress(74);
        setReadingTtsStageLabel('Đang tạo giọng Intro "Hôm nay học gì?"...');
        const useViVoice =
          hasVietnameseChars(activeIntroText) &&
          (readingProvider === 'auto' || readingProvider === 'edge');
        const introRes = await synthesizeAudioWithProgressJob({
          provider: readingProvider,
          voice: useViVoice ? 'vi-VN-HoaiMyNeural' : readingVoice,
          lang: useViVoice ? 'vi-VN' : baseLang,
          rate: readingTtsRate,
          segments: [{ id: 'reading-intro', text: activeIntroText, pauseAfterSec: 0 }],
        });
        if (introRes.audioBase64) {
          partsToConcat.push({
            file: decodeBase64AudioClip(
              introRes.audioBase64,
              cleanDownloadFileName(`${cleanReadingTitle} Intro`, 'mp3', 'Reading Intro'),
              introRes.mimeType || 'audio/mpeg',
            ),
            pauseAfterSec: 0.45,
            role: 'intro',
          });
        }
      }

      partsToConcat.push({
        file: res.audioFile,
        pauseAfterSec: 0.35,
        role: 'body',
      });

      const outroText = [watermarkOutro.outroLine1.trim(), watermarkOutro.outroLine2.trim()]
        .filter(Boolean)
        .join('. ');
      if (readingOutroSpeechEnabled && watermarkOutro.outroSeconds > 0 && outroText) {
        setReadingTtsProgress(82);
        setReadingTtsStageLabel('Đang tạo giọng đọc Outro...');
        const useViOutro =
          hasVietnameseChars(outroText) &&
          (readingProvider === 'auto' || readingProvider === 'edge');
        const outroRes = await synthesizeAudioWithProgressJob({
          provider: readingProvider,
          voice: useViOutro ? 'vi-VN-HoaiMyNeural' : readingVoice,
          lang: useViOutro ? 'vi-VN' : baseLang,
          rate: readingTtsRate,
          segments: [{ id: 'reading-outro', text: outroText, pauseAfterSec: 0 }],
        });
        if (outroRes.audioBase64) {
          partsToConcat.push({
            file: decodeBase64AudioClip(
              outroRes.audioBase64,
              cleanDownloadFileName(`${cleanReadingTitle} Outro`, 'mp3', 'Reading Outro'),
              outroRes.mimeType || 'audio/mpeg',
            ),
            pauseAfterSec: 0.45,
            role: 'outro',
          });
        }
      }

      setReadingTtsProgress(88);
      setReadingTtsStageLabel('Đang nối Intro · Bài đọc · Outro & hòa nhạc nền...');

      const combined = await concatAudioFilesWithGaps(
        partsToConcat.map((p) => ({ file: p.file, pauseAfterSec: p.pauseAfterSec })),
        cleanDownloadFileName(cleanReadingTitle, 'wav', 'Reading Speech'),
      );

      const introIdx = partsToConcat.findIndex((p) => p.role === 'intro');
      const bodyIdx = partsToConcat.findIndex((p) => p.role === 'body');
      const outroIdx = partsToConcat.findIndex((p) => p.role === 'outro');

      const exactIntroEndSec = bodyIdx >= 0 ? combined.segmentOffsets[bodyIdx] : 0;
      const bodyDurSec = bodyIdx >= 0 ? combined.segmentDurations[bodyIdx] : res.durationSec;
      const bodyEndWithIntro = Number((exactIntroEndSec + bodyDurSec + 0.35).toFixed(3));
      const outroStartSec = outroIdx >= 0 ? combined.segmentOffsets[outroIdx] : undefined;
      const outroSpeechDur = outroIdx >= 0 ? combined.segmentDurations[outroIdx] + 0.55 : 0;

      const updatedOutroSec =
        readingOutroSpeechEnabled && outroIdx >= 0
          ? Math.max(watermarkOutro.outroSeconds, Number(outroSpeechDur.toFixed(1)))
          : watermarkOutro.outroSeconds;
      const updatedWatermark: EduWatermarkOutroConfig =
        updatedOutroSec !== watermarkOutro.outroSeconds
          ? { ...watermarkOutro, outroSeconds: updatedOutroSec }
          : watermarkOutro;

      if (updatedWatermark !== watermarkOutro) {
        setWatermarkOutro(updatedWatermark);
      }

      const shiftedWords = shiftReadingWordsForIntro(bodyWords, exactIntroEndSec);
      const shiftedCues = res.cues.map((cue) => ({
        ...cue,
        start: Number((cue.start + exactIntroEndSec).toFixed(3)),
        end: Number((cue.end + exactIntroEndSec).toFixed(3)),
        words: shiftReadingWordsForIntro(cue.words, exactIntroEndSec),
      }));

      const speechWindows: Array<{ start: number; end: number }> = [];
      if (introIdx >= 0) {
        speechWindows.push({
          start: combined.segmentOffsets[introIdx],
          end: combined.segmentOffsets[introIdx] + combined.segmentDurations[introIdx],
        });
      }
      if (bodyIdx >= 0) {
        speechWindows.push({
          start: combined.segmentOffsets[bodyIdx],
          end: combined.segmentOffsets[bodyIdx] + combined.segmentDurations[bodyIdx],
        });
      }
      if (outroIdx >= 0) {
        speechWindows.push({
          start: combined.segmentOffsets[outroIdx],
          end: combined.segmentOffsets[outroIdx] + combined.segmentDurations[outroIdx],
        });
      }

      const metrics = computeReadingTimelineMetrics({
        words: shiftedWords,
        contentDuration: bodyEndWithIntro,
        introEnabled: introIdx >= 0,
        introSeconds: exactIntroEndSec,
        outroSeconds: updatedWatermark.outroSeconds,
        outroText,
      });

      let finalAudioFile = combined.file;
      let finalTotalDur = Math.max(combined.durationSec, metrics.effectiveTotalDuration);

      if (readingBgmPreset !== 'none' && readingBgmVolume > 0) {
        const mixed = await mixVoiceWithBgmPreset({
          voiceFile: combined.file,
          bgmPreset: readingBgmPreset,
          bgmVolume: readingBgmVolume,
          speechWindows,
          introEndSec: exactIntroEndSec,
          outroStartSec: outroStartSec ?? metrics.outroStart,
          minTotalDurationSec: metrics.effectiveTotalDuration,
          outputFileName: cleanDownloadFileName(cleanReadingTitle, 'wav', 'Reading Along'),
        });
        if (mixed.file) {
          finalAudioFile = mixed.file;
          finalTotalDur = Math.max(finalTotalDur, mixed.durationSec);
        }
      }

      const nextSig = JSON.stringify({
        readingTitle: cleanTitle.trim(),
        readingText: cleanBody.trim(),
        readingProvider,
        readingVoice,
        readingTtsRate,
        readingIntroEnabled,
        readingIntroText: activeIntroText,
        readingOutroSpeechEnabled,
        outroSpeechText:
          readingOutroSpeechEnabled && updatedWatermark.outroSeconds > 0 ? outroText : '',
        outroSeconds: updatedWatermark.outroSeconds,
        readingBgmPreset,
        readingBgmVolume: Number(readingBgmVolume.toFixed(2)),
      });

      if (introIdx >= 0) {
        setReadingIntroSeconds(Number(exactIntroEndSec.toFixed(2)));
      }
      setIsCustomAlignAudio(false);
      setSynthesizedReadingSig(nextSig);
      setAlignFile(finalAudioFile);
      setAlignAudioDur(Math.max(3, finalTotalDur));
      setAlignAudioUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(finalAudioFile);
      });
      setAlignResult({
        language: res.detectedLanguage,
        modelUsed: res.whisperAligned ? 'fast-forced' : res.providerUsed,
        backendUsed: res.providerUsed,
        durationSec: metrics.contentEnd,
        text: cleanBody,
        words: shiftedWords,
        cues: shiftedCues,
        srt: res.srt,
      });
      setAlignCurrentSec(0);
      setReadingTtsProgress(100);
      setReadingTtsStageLabel('Hoàn tất Intro · Bài đọc · Outro có nhạc nền!');

      return {
        audioFile: finalAudioFile,
        title: cleanTitle,
        text: cleanBody,
        words: shiftedWords,
        contentEnd: metrics.contentEnd,
        totalDuration: metrics.effectiveTotalDuration,
        introEnabled: introIdx >= 0,
        introSeconds: exactIntroEndSec,
        introSubtitle: activeIntroText || cleanTitle,
        watermarkOutro: updatedWatermark,
      };
    } catch (err) {
      setAlignError(err instanceof Error ? err.message : 'Lỗi tạo Audio TTS cho bài đọc.');
      return null;
    } finally {
      setIsGeneratingReadingTts(false);
    }
  };

  const handleRunWordAlign = async () => {
    if (!alignFile || isAligning) return;
    setAlignError(null);
    setIsAligning(true);
    setReadingTtsProgress(5);
    setReadingTtsStageLabel(
      alignMode === 'fast-forced'
        ? 'Đang căn nhịp siêu tốc theo kịch bản (Fast Forced Align)...'
        : 'Đang tải model Whisper & căn chỉnh từng từ...',
    );
    try {
      const data = await alignAudioWithProgressJob(
        {
          audioFile: alignFile,
          lang: alignLang,
          model: alignModel,
          referenceText: readingText,
          alignMode,
        },
        (pct, label) => {
          setReadingTtsProgress(pct);
          setReadingTtsStageLabel(label);
        },
      );
      if (alignMode === 'whisper' && data.text?.trim() && !readingText.trim()) {
        setReadingText(data.text.trim());
      }
      if (alignAudioRef.current && Number.isFinite(alignAudioRef.current.duration)) {
        setAlignAudioDur(alignAudioRef.current.duration);
      }
      const cuesArr = Array.isArray(data.cues) ? data.cues : [];
      const wordsArr = Array.isArray(data.words) ? data.words : [];
      const wordsEnd = wordsArr.length > 0 ? wordsArr[wordsArr.length - 1].end : 0;
      const cuesEnd = cuesArr.length > 0 ? cuesArr[cuesArr.length - 1].end : 0;
      const dur = Math.max(
        wordsEnd,
        cuesEnd,
        alignAudioRef.current && Number.isFinite(alignAudioRef.current.duration)
          ? alignAudioRef.current.duration
          : alignAudioDur,
      );
      setAlignResult({
        language: data.language,
        modelUsed: data.modelUsed || (alignMode === 'fast-forced' ? 'fast-forced' : alignModel),
        backendUsed: data.backendUsed || (alignMode === 'fast-forced' ? 'fast-forced' : 'whisper'),
        durationSec: Number(dur || 0),
        text: data.text || readingText,
        words: wordsArr,
        cues: cuesArr,
        srt: data.srt || '',
      });
    } catch (err) {
      setAlignError(err instanceof Error ? err.message : 'Lỗi căn chỉnh từng từ.');
    } finally {
      setIsAligning(false);
    }
  };

  const handleExportReadingAlongMp4 = async () => {
    if (isExportingReadingMp4) return;
    setAlignError(null);
    setIsExportingReadingMp4(true);
    setReadingExportProgress(0);
    setReadingExportStatus('Đang dựng video Reading Along + Intro/Outro + Nhạc nền...');
    const controller = new AbortController();
    readingAbortRef.current = controller;

    try {
      let targetAudio = alignFile;
      let targetTitle = readingTitle;
      let targetText = readingText;
      let targetWords = effectiveReadingWords;
      let targetContentEnd = readingTimeline.contentEnd;
      let targetTotalDur = readingTimeline.effectiveTotalDuration;
      let targetIntroEnabled = readingIntroEnabled && readingIntroText.trim().length > 0;
      let targetIntroSec = activeIntroSec;
      let targetIntroSub = readingIntroText.trim() || readingTitle;
      let targetWatermark = watermarkOutro;

      if (!targetAudio || (!isCustomAlignAudio && synthesizedReadingSig !== currentReadingSig)) {
        setReadingExportStatus('Đang tạo lại giọng đọc Intro/Outro & hòa nhạc nền mới nhất...');
        const bundle = await handleGenerateReadingTts();
        if (!bundle) {
          throw new Error('Không thể tạo audio bài đọc trước khi xuất MP4.');
        }
        targetAudio = bundle.audioFile;
        targetTitle = bundle.title;
        targetText = bundle.text;
        targetWords = bundle.words;
        targetContentEnd = bundle.contentEnd;
        targetTotalDur = bundle.totalDuration;
        targetIntroEnabled = bundle.introEnabled;
        targetIntroSec = bundle.introSeconds;
        targetIntroSub = bundle.introSubtitle;
        targetWatermark = bundle.watermarkOutro;
      }

      if (controller.signal.aborted) {
        throw new ExportAbortedError();
      }

      const baseStem = cleanOutputTitleStem(targetTitle, 'Reading Along');

      const dummyProject: LessonProject = {
        id: 'reading-along-preview',
        title: targetTitle,
        subtitle: readingTopic,
        theme: 'pastel-sunrise',
        duration: targetTotalDur,
        fps: readingFps === 60 ? 60 : 30,
        cues: [],
        elements: [],
      };

      const saved = await exportProjectToServerDisk(
        dummyProject,
        targetAudio,
        ({ progress, stageLabel }) => {
          setReadingExportProgress(progress);
          setReadingExportStatus(stageLabel);
        },
        {
          aspectRatio: readingAspect,
          resolution: readingResolution,
          quality: readingQuality,
          fps: readingFps,
        },
        baseStem,
        selectedSavePath.trim() || TAB_OUTPUT_SUBFOLDERS.reading,
        {
          signal: controller.signal,
          directoryHandle: localDirHandle || undefined,
          sourceTab: 'Reading Along',
          customRenderFrame: (ctx, time, width, height) => {
            renderReadingAlongFrame(ctx, {
              width,
              height,
              title: targetTitle,
              topicBadge: readingTopic,
              text: targetText,
              words: targetWords,
              currentTime: time,
              contentDuration: targetContentEnd,
              totalDuration: targetTotalDur,
              introEnabled: targetIntroEnabled,
              introSeconds: targetIntroSec,
              introTitle: 'HÔM NAY HỌC GÌ? · TODAY GOAL',
              introSubtitle: targetIntroSub,
              paletteId: readingPaletteId,
              illustrationStyle: readingIllustration,
              bookFrame: readingBookFrame,
              pointerStyle: readingPointerStyle,
              watermarkOutro: targetWatermark,
            });
          },
        },
      );

      setReadingExportStatus(`Hoàn tất! Đã lưu ${saved.fileName} (${saved.savedPath}).`);
      emitOutputUpdated({ relativePath: saved.relativePath, sourceTab: 'Reading Along' });
      await refreshOutputFolders();
    } catch (err) {
      if (err instanceof ExportAbortedError || controller.signal.aborted) {
        setReadingExportStatus('Đã hủy xuất Reading Along MP4.');
      } else {
        setAlignError(err instanceof Error ? err.message : 'Lỗi xuất Reading Along MP4.');
        setReadingExportStatus('');
      }
    } finally {
      readingAbortRef.current = null;
      setIsExportingReadingMp4(false);
    }
  };

  const handleScrapeReadingUrl = async (targetUrl?: string, adaptWithAi = true) => {
    const cleanUrl = (targetUrl || readingUrl).trim();
    if (!cleanUrl || isScrapingOrGeneratingReading) return;
    if (targetUrl) setReadingUrl(targetUrl);
    setAlignError(null);
    setIsScrapingOrGeneratingReading(true);
    setReadingAiProgress(12);
    setReadingAiStageLabel('Đang tải và bóc tách nội dung sạch từ trang web...');

    try {
      const scrapeRes = await fetch('/api/scraper/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl }),
      });
      const scraped = await parseApiJson<{
        title?: string;
        rawText?: string;
        text?: string;
        links?: Array<{ title: string; url: string }>;
        subLinks?: Array<{ title: string; url: string }>;
        error?: string;
      }>(scrapeRes, 'Không đọc được nội dung từ trang web');
      const extractedText = (scraped.rawText || scraped.text || '').trim();
      const extractedLinks = Array.isArray(scraped.links)
        ? scraped.links
        : Array.isArray(scraped.subLinks)
          ? scraped.subLinks
          : [];
      if (!scrapeRes.ok || !extractedText) {
        throw new Error(scraped.error || 'Không trích xuất được nội dung bài đọc từ URL này.');
      }
      setReadingUrlSubLinks(extractedLinks.slice(0, 8));
      setScrapedWebSource({
        url: cleanUrl,
        title: scraped.title || cleanUrl,
        rawText: extractedText,
      });
      setReadingWebPromptMode('web-url');
      setReadingAiProgress(55);

      if (adaptWithAi && effectiveReadingGeminiKey) {
        setReadingAiStageLabel(`AI đang biên tập lại theo trình độ ${readingAiLevel}...`);
        const aiRes = await fetch('/api/ai/generate-reading', {
          method: 'POST',
          headers: buildApiKeyHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({
            mode: 'adapt-url',
            level: readingAiLevel,
            wordCount: readingAiLength,
            sourceTitle: scraped.title || '',
            sourceText: extractedText,
          }),
        });
        const aiData = await parseApiJson<{
          title?: string;
          topicBadge?: string;
          text?: string;
          error?: string;
        }>(aiRes, 'AI chuyển thể bài đọc thất bại');
        if (aiRes.ok && aiData.text?.trim()) {
          setReadingAiProgress(100);
          setReadingTitle(aiData.title || scraped.title || readingTitle);
          setReadingTopic(aiData.topicBadge || `CEFR ${readingAiLevel} · WEB`);
          setReadingText(aiData.text.trim());
          setAlignResult(null);
          setAlignCurrentSec(0);
          setReadingAiStageLabel(`Đã lấy bài từ web & chuyển thể trình độ ${readingAiLevel}!`);
          return;
        }
      }

      const rawLines = extractedText
        .split(/(?<=[.!?])\s+|\r?\n+/)
        .map((s) => s.trim())
        .filter((s) => s.length >= 12)
        .slice(0, 14);
      setReadingAiProgress(100);
      if (scraped.title?.trim()) setReadingTitle(scraped.title.trim().slice(0, 80));
      setReadingTopic(`WEB ARTICLE · ${readingAiLevel}`);
      setReadingText((rawLines.length > 0 ? rawLines : [extractedText.slice(0, 900)]).join('\n'));
      setAlignResult(null);
      setAlignCurrentSec(0);
      setIsWebPromptOpen(true);
      setReadingAiStageLabel(
        effectiveReadingGeminiKey
          ? 'Đã lấy nội dung trang web vào bài đọc!'
          : 'Đã bóc tách văn bản sạch từ Web — có thể sao chép Prompt Web AI bên dưới rồi dán kết quả về sách!',
      );
    } catch (err) {
      setAlignError(err instanceof Error ? err.message : 'Lỗi đọc nội dung từ trang web.');
      setReadingAiStageLabel('');
    } finally {
      setIsScrapingOrGeneratingReading(false);
    }
  };

  const handleAiGenerateReadingPassage = async () => {
    if (isScrapingOrGeneratingReading || !readingAiTopic.trim()) return;
    setAlignError(null);
    setIsScrapingOrGeneratingReading(true);
    setReadingAiProgress(18);
    setReadingAiStageLabel(`AI đang viết bài đọc trình độ ${readingAiLevel}...`);
    try {
      const res = await fetch('/api/ai/generate-reading', {
        method: 'POST',
        headers: buildApiKeyHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          mode: 'generate',
          topic: readingAiTopic.trim(),
          level: readingAiLevel,
          wordCount: readingAiLength,
        }),
      });
      const data = await parseApiJson<{
        title?: string;
        topicBadge?: string;
        text?: string;
        error?: string;
      }>(res, 'AI tạo bài đọc thất bại');
      if (!res.ok || !data.text?.trim()) {
        throw new Error(data.error || 'AI không tạo được bài đọc.');
      }
      setReadingAiProgress(100);
      setReadingTitle(data.title || readingAiTopic.trim());
      setReadingTopic(data.topicBadge || `CEFR ${readingAiLevel}`);
      setReadingText(data.text.trim());
      setAlignResult(null);
      setAlignCurrentSec(0);
      setReadingAiStageLabel(`AI đã tạo xong bài đọc trình độ ${readingAiLevel}!`);
    } catch (err) {
      setAlignError(err instanceof Error ? err.message : 'Lỗi AI tạo bài đọc.');
      setReadingAiStageLabel('');
    } finally {
      setIsScrapingOrGeneratingReading(false);
    }
  };

  const handleCopyReadingWebPrompt = async () => {
    try {
      await navigator.clipboard.writeText(readingWebAiPrompt);
      setCopiedReadingPrompt(true);
      setTimeout(() => setCopiedReadingPrompt(false), 2000);
    } catch {
      setCopiedReadingPrompt(false);
    }
  };

  const handleApplyPastedReadingAi = () => {
    setPastedReadingAiError(null);
    const parsed = parseReadingWebAiResponse(pastedReadingAiResponse, readingAiLevel);
    if (!parsed) {
      setPastedReadingAiError('Hãy dán kết quả JSON hoặc văn bản tiếng Anh từ ChatGPT/Gemini vào ô trên.');
      return;
    }
    setReadingTitle(parsed.title);
    setReadingTopic(parsed.topicBadge);
    setReadingText(parsed.text);
    setAlignResult(null);
    setAlignCurrentSec(0);
    setReadingAiStageLabel(`Đã nạp nội dung từ Web AI (${parsed.title}) vào trang sách!`);
  };

  const wmPosClass =
    watermarkOutro.watermarkCorner === 'top-left'
      ? 'top-2.5 left-2.5'
      : watermarkOutro.watermarkCorner === 'top-right'
        ? 'top-2.5 right-2.5'
        : watermarkOutro.watermarkCorner === 'bottom-left'
          ? 'bottom-10 left-2.5'
          : 'bottom-10 right-2.5';

  return (
    <div className="max-w-[1400px] w-full mx-auto p-4 lg:p-6 space-y-5">
      {/* Header Banner */}
      <section className="bg-white border border-slate-200 rounded-xl p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-lg font-bold text-slate-900">
            Educational Audio Video Studio 1.19 — FFmpeg Server &amp; Reading Along
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Đầy đủ 3 module nguyên bản 1.19: Merge Video+Audio (đơn &amp; batch), Add Karaoke Sub (6 style ASS) + Audio Mix, Reading Along Book+Pointer — file xuất hiển thị ngay ở Thư mục Output chung bên dưới.
          </p>
        </div>
      </section>

      {folderStatusMsg && (
        <div className="px-4 py-2.5 rounded-xl bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 flex items-center justify-between gap-2">
          <span>{folderStatusMsg}</span>
          <button
            type="button"
            onClick={() => setFolderStatusMsg(null)}
            className="text-emerald-700 font-semibold"
          >
            Đóng
          </button>
        </div>
      )}

      {/* Full-width Studio Workspace */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setSubTab('merge')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                subTab === 'merge'
                  ? 'bg-white border-indigo-300 text-indigo-700 shadow-xs'
                  : 'border-transparent text-slate-600 hover:bg-white/60'
              }`}
            >
              <Layers className="w-3.5 h-3.5" />
              <span>1. Merge Video + Audio</span>
            </button>

            <button
              type="button"
              onClick={() => setSubTab('karaoke')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                subTab === 'karaoke'
                  ? 'bg-white border-indigo-300 text-indigo-700 shadow-xs'
                  : 'border-transparent text-slate-600 hover:bg-white/60'
              }`}
            >
              <Music className="w-3.5 h-3.5" />
              <span>2. Add Karaoke Sub &amp; Mix</span>
            </button>

            <button
              type="button"
              onClick={() => setSubTab('align')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg border transition-colors ${
                subTab === 'align'
                  ? 'bg-white border-indigo-300 text-indigo-700 shadow-xs'
                  : 'border-transparent text-slate-600 hover:bg-white/60'
              }`}
            >
              <BookOpen className="w-3.5 h-3.5" />
              <span>3. Reading Along Studio</span>
            </button>
          </div>

          <div className="p-5 space-y-4">
            {/* ── SUB-TAB 1: MERGE VIDEO + AUDIO (Single + Batch) ───────────── */}
            {subTab === 'merge' && (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 pb-1">
                  <div className="inline-flex p-1 bg-slate-100 rounded-lg border border-slate-200">
                    <button
                      type="button"
                      onClick={() => setMergeMode('single')}
                      className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                        mergeMode === 'single'
                          ? 'bg-white text-indigo-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Một Video + Một Audio
                    </button>
                    <button
                      type="button"
                      onClick={() => setMergeMode('batch')}
                      className={`px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                        mergeMode === 'batch'
                          ? 'bg-white text-indigo-700 shadow-xs'
                          : 'text-slate-600 hover:text-slate-900'
                      }`}
                    >
                      Batch – Ghép hàng loạt theo tên file
                    </button>
                  </div>
                  <select
                    value={durationMode}
                    onChange={(e) => setDurationMode(e.target.value as 'loop-video' | 'shortest')}
                    className="px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                  >
                    <option value="shortest">Cắt theo file ngắn hơn (Shortest - Chuẩn 1.19)</option>
                    <option value="loop-video">Tự lặp Video nền khớp hết Audio</option>
                  </select>
                </div>

                {mergeMode === 'single' ? (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 hover:bg-indigo-50/40 cursor-pointer flex items-center gap-2.5">
                      <Film className="w-5 h-5 text-indigo-600 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-800 truncate">
                          {mergeVideoFile ? mergeVideoFile.name : 'Chọn Video nền (.mp4, .mov)'}
                        </div>
                        <div className="text-[11px] text-slate-500">Tên file xuất tự lấy theo tên video gốc</div>
                      </div>
                      <input
                        type="file"
                        accept="video/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;
                          setMergeVideoFile(f);
                          if (f) setMergeOutputName(f.name.replace(/\.[^.]+$/, ''));
                        }}
                      />
                    </label>

                    <label className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 hover:bg-indigo-50/40 cursor-pointer flex items-center gap-2.5">
                      <FileAudio className="w-5 h-5 text-emerald-600 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-xs font-semibold text-slate-800 truncate">
                          {mergeAudioFile ? mergeAudioFile.name : 'Chọn Audio ngoài (.mp3, .wav)'}
                        </div>
                        <div className="text-[11px] text-slate-500">Thay thế audio gốc trong video</div>
                      </div>
                      <input
                        type="file"
                        accept="audio/*"
                        className="hidden"
                        onChange={(e) => setMergeAudioFile(e.target.files?.[0] ?? null)}
                      />
                    </label>
                  </div>
                ) : (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <label className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 hover:bg-indigo-50/40 cursor-pointer flex items-center gap-2.5">
                        <Film className="w-5 h-5 text-indigo-600 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-800">
                            {batchVideos.length > 0 ? `Đã chọn ${batchVideos.length} Video` : 'Chọn nhiều Video (Batch)'}
                          </div>
                          <div className="text-[11px] text-slate-500">Ghép tự động với Audio cùng tên</div>
                        </div>
                        <input
                          type="file"
                          multiple
                          accept="video/*"
                          className="hidden"
                          onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            setBatchVideos(files);
                            if (files[0]) setMergeVideoFile(files[0]);
                          }}
                        />
                      </label>
                      <label className="p-3.5 rounded-xl border border-dashed border-slate-300 bg-slate-50/70 hover:bg-indigo-50/40 cursor-pointer flex items-center gap-2.5">
                        <FileAudio className="w-5 h-5 text-emerald-600 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs font-semibold text-slate-800">
                            {batchAudios.length > 0 ? `Đã chọn ${batchAudios.length} Audio` : 'Chọn nhiều Audio (Batch)'}
                          </div>
                          <div className="text-[11px] text-slate-500">VD: lesson01.mp4 ↔ lesson01.mp3</div>
                        </div>
                        <input
                          type="file"
                          multiple
                          accept="audio/*"
                          className="hidden"
                          onChange={(e) => {
                            const files = Array.from(e.target.files || []);
                            setBatchAudios(files);
                            if (files[0]) setMergeAudioFile(files[0]);
                          }}
                        />
                      </label>
                    </div>
                    {(batchVideos.length > 0 || batchAudios.length > 0) && (
                      <div className="p-2.5 rounded-lg bg-slate-50 border border-slate-200 text-[11px] space-y-1">
                        <div className="font-semibold text-emerald-700">
                          Khớp tự động: {batchMatchedPairs.matched.length} cặp Video + Audio
                        </div>
                        {batchMatchedPairs.missing.length > 0 && (
                          <div className="text-amber-700">
                            Thiếu Audio cùng tên: {batchMatchedPairs.missing.slice(0, 6).join(', ')}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Always-visible Live Preview for Merge + Watermark/Outro */}
                <div className="p-3.5 rounded-xl bg-slate-900 text-white space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                    <span className="font-semibold text-indigo-300 inline-flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5" />
                      <span>Live Preview (Merge Video + Watermark &amp; Outro)</span>
                    </span>
                    <div className="flex items-center gap-2">
                      {mergeVideoUrl && mergeAudioUrl && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowMergeOutroPreview(false);
                            const v = mergePreviewVideoRef.current;
                            const a = mergePreviewAudioRef.current;
                            if (!v || !a) return;
                            if (v.paused || a.paused) {
                              v.currentTime = 0;
                              a.currentTime = 0;
                              void v.play().catch(() => undefined);
                              void a.play().catch(() => undefined);
                            } else {
                              v.pause();
                              a.pause();
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px] font-semibold"
                        >
                          <Play className="w-2.5 h-2.5 fill-current" />
                          <span>Phát khớp Video &amp; Audio</span>
                        </button>
                      )}
                      {watermarkOutro.outroSeconds > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowMergeOutroPreview((o) => !o)}
                          className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded text-[10px] font-semibold ${
                            showMergeOutroPreview
                              ? 'bg-amber-500 text-slate-950'
                              : 'bg-slate-700 hover:bg-slate-600 text-white'
                          }`}
                        >
                          <Eye className="w-2.5 h-2.5" />
                          <span>{showMergeOutroPreview ? 'Đóng Outro' : 'Xem thử Outro'}</span>
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="relative rounded-lg overflow-hidden bg-slate-950 min-h-[175px] flex items-center justify-center border border-slate-800">
                    {mergeVideoUrl ? (
                      <video
                        ref={mergePreviewVideoRef}
                        controls
                        loop={durationMode === 'loop-video'}
                        muted={Boolean(mergeAudioUrl)}
                        src={mergeVideoUrl}
                        className="w-full max-h-60 mx-auto object-contain"
                      />
                    ) : (
                      <div className="p-6 text-center space-y-1">
                        <Film className="w-7 h-7 text-slate-600 mx-auto" />
                        <p className="text-xs font-medium text-slate-300">
                          Khung Live Preview Watermark &amp; Outro
                        </p>
                        <p className="text-[11px] text-slate-500">
                          Chọn Video &amp; Audio ở trên để xem phát khớp và ảnh xem trước nhanh 3 mốc
                        </p>
                      </div>
                    )}

                    {watermarkOutro.watermarkEnabled && watermarkOutro.watermarkText.trim() && (
                      <div
                        style={{ opacity: watermarkOutro.watermarkOpacity }}
                        className={`pointer-events-none absolute px-2.5 py-1 rounded bg-black/55 text-white text-xs font-semibold ${wmPosClass}`}
                      >
                        {watermarkOutro.watermarkText}
                      </div>
                    )}

                    {showMergeOutroPreview && (
                      <div className="absolute inset-0 bg-slate-900/95 flex flex-col items-center justify-center p-6 text-center space-y-1.5 z-10">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-400">
                          Xem trước Outro cuối video (+{watermarkOutro.outroSeconds}s sau khi kết thúc)
                        </span>
                        <div className="text-base font-bold text-white">
                          {watermarkOutro.outroLine1 || 'Thanks for watching!'}
                        </div>
                        {watermarkOutro.outroLine2 && (
                          <div className="text-xs text-slate-300">{watermarkOutro.outroLine2}</div>
                        )}
                      </div>
                    )}
                  </div>

                  {mergeAudioUrl && (
                    <audio
                      ref={mergePreviewAudioRef}
                      controls
                      src={mergeAudioUrl}
                      className="w-full h-8"
                    />
                  )}

                  <VideoSnapshotStrip
                    videoUrl={mergeVideoUrl}
                    watermarkOutro={watermarkOutro}
                    onSeek={(t) => {
                      if (mergePreviewVideoRef.current) {
                        mergePreviewVideoRef.current.currentTime = t;
                      }
                    }}
                  />
                </div>

                {mergeMode === 'single' && (
                  <div>
                    <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                      Tên file đầu ra (mặc định lấy tên video gốc)
                    </label>
                    <input
                      type="text"
                      value={mergeOutputName}
                      onChange={(e) => setMergeOutputName(e.target.value)}
                      placeholder={
                        mergeVideoFile
                          ? mergeVideoFile.name.replace(/\.[^.]+$/, '')
                          : 'Tự lấy theo tên video gốc'
                      }
                      className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-lg font-mono"
                    />
                  </div>
                )}

                {renderOutputFolderControl()}

                <WatermarkOutroSection
                  config={watermarkOutro}
                  onChange={setWatermarkOutro}
                  title="Watermark & Outro (Tùy chọn · Ghép Video)"
                />

                {mergeError && (
                  <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                    {mergeError}
                  </p>
                )}
                {mergeStatus && (
                  <div className="p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 font-medium">
                      <span>{mergeStatus}</span>
                      {(isMerging || mergeProgress > 0) && (
                        <span className="font-mono font-bold tabular-nums">{mergeProgress}%</span>
                      )}
                    </div>
                    {isMerging && (
                      <div className="w-full h-1.5 bg-indigo-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 transition-all duration-300"
                          style={{ width: `${Math.max(4, Math.min(100, mergeProgress))}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  {isMerging ? (
                    <button
                      type="button"
                      onClick={handleCancelMerge}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-white bg-rose-600 rounded-lg hover:bg-rose-700"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      <span>Hủy ghép video</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={
                        mergeMode === 'single'
                          ? !mergeVideoFile || !mergeAudioFile
                          : batchMatchedPairs.matched.length === 0
                      }
                      onClick={() => void handleRunMerge()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>
                        {mergeMode === 'batch'
                          ? `Ghép Batch (${batchMatchedPairs.matched.length} cặp)`
                          : 'Bắt đầu Ghép Video + Audio (FFmpeg)'}
                      </span>
                    </button>
                  )}
                </div>
              </>
            )}

            {/* ── SUB-TAB 2: ADD KARAOKE SUB (.ASS) & MIX AUDIO ─────────────── */}
            {subTab === 'karaoke' && (
              <>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {[
                    {
                      label: 'Video nền *',
                      file: kmVideoFile,
                      set: (f: File | null) => {
                        setKmVideoFile(f);
                        if (f) setKmOutputName(f.name.replace(/\.[^.]+$/, ''));
                      },
                      accept: 'video/*',
                    },
                    { label: 'Voiceover / TTS', file: kmVoiceFile, set: setKmVoiceFile, accept: 'audio/*' },
                    { label: 'Nhạc nền BGM', file: kmMusicFile, set: setKmMusicFile, accept: 'audio/*' },
                    { label: 'Ambient SFX', file: kmSfxFile, set: setKmSfxFile, accept: 'audio/*' },
                  ].map((slot) => (
                    <label
                      key={slot.label}
                      className="p-2.5 rounded-xl border border-dashed border-slate-300 bg-slate-50 hover:bg-indigo-50/40 cursor-pointer text-center space-y-1"
                    >
                      <Upload className="w-4 h-4 text-indigo-600 mx-auto" />
                      <div className="text-[11px] font-semibold text-slate-800 truncate">
                        {slot.file ? slot.file.name : slot.label}
                      </div>
                      <input
                        type="file"
                        accept={slot.accept}
                        className="hidden"
                        onChange={(e) => slot.set(e.target.files?.[0] ?? null)}
                      />
                    </label>
                  ))}
                </div>

                {/* Default built-in BGM & Ambient SFX presets */}
                <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-800">
                      Âm thanh nền mặc định (tự dùng khi chưa tải file BGM / Ambient SFX)
                    </span>
                    <div className="flex items-center gap-2">
                      {kmMusicFile && (
                        <button
                          type="button"
                          onClick={() => setKmMusicFile(null)}
                          className="text-[10px] font-semibold text-rose-600 hover:underline"
                        >
                          Bỏ file BGM
                        </button>
                      )}
                      {kmSfxFile && (
                        <button
                          type="button"
                          onClick={() => setKmSfxFile(null)}
                          className="text-[10px] font-semibold text-rose-600 hover:underline"
                        >
                          Bỏ file SFX
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div className="space-y-1.5">
                      <label className="block text-[10px] font-semibold text-slate-600">
                        Nhạc nền BGM mặc định {kmMusicFile ? '(Đang dùng file tải lên)' : ''}
                      </label>
                      <select
                        disabled={Boolean(kmMusicFile)}
                        value={kmMusicPreset}
                        onChange={(e) =>
                          setKmMusicPreset(e.target.value as 'lofi-calm' | 'soft-study' | 'none')
                        }
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg disabled:opacity-50"
                      >
                        <option value="lofi-calm">Lo-fi Chill Mặc định (Warm Pad)</option>
                        <option value="soft-study">Soft Study Pad (Nhẹ nhàng)</option>
                        <option value="none">Không dùng BGM mặc định</option>
                      </select>
                      {!kmMusicFile && kmMusicPreset !== 'none' && (
                        <audio
                          controls
                          src={`/api/studio/default-audio?preset=${kmMusicPreset}`}
                          className="w-full h-7"
                        />
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <label className="block text-[10px] font-semibold text-slate-600">
                        Ambient SFX mặc định {kmSfxFile ? '(Đang dùng file tải lên)' : ''}
                      </label>
                      <select
                        disabled={Boolean(kmSfxFile)}
                        value={kmSfxPreset}
                        onChange={(e) =>
                          setKmSfxPreset(e.target.value as 'soft-rain' | 'cafe-room' | 'none')
                        }
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg disabled:opacity-50"
                      >
                        <option value="soft-rain">Mưa nhẹ (Soft Rain)</option>
                        <option value="cafe-room">Không gian quán cà phê (Cafe Room)</option>
                        <option value="none">Không dùng SFX mặc định</option>
                      </select>
                      {!kmSfxFile && kmSfxPreset !== 'none' && (
                        <audio
                          controls
                          src={`/api/studio/default-audio?preset=${kmSfxPreset}`}
                          className="w-full h-7"
                        />
                      )}
                    </div>
                  </div>
                </div>

                {/* Always-visible Live Karaoke Effect + Video FX + Watermark/Outro Preview */}
                <div className="p-3 rounded-xl bg-slate-900 text-white space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-indigo-300 font-semibold">
                    <span className="inline-flex items-center gap-1.5">
                      <Eye className="w-3.5 h-3.5" />
                      <span>
                        Live Effect Preview ({kmEffectSpec.id.split('–')[0].trim()} · {kmEffect})
                      </span>
                    </span>
                    <div className="flex items-center gap-2">
                      {kmVideoUrl && kmVoiceUrl && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowKmOutroPreview(false);
                            const v = kmVideoRef.current;
                            const a = kmVoiceRef.current;
                            if (!v || !a) return;
                            if (v.paused || a.paused) {
                              v.currentTime = 0;
                              a.currentTime = 0;
                              void v.play().catch(() => undefined);
                              void a.play().catch(() => undefined);
                            } else {
                              v.pause();
                              a.pause();
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-600 hover:bg-emerald-500 text-white text-[10px]"
                        >
                          <Play className="w-2.5 h-2.5 fill-current" />
                          <span>Phát khớp Video &amp; Voice</span>
                        </button>
                      )}
                      {watermarkOutro.outroSeconds > 0 && (
                        <button
                          type="button"
                          onClick={() => setShowKmOutroPreview((o) => !o)}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-semibold ${
                            showKmOutroPreview
                              ? 'bg-amber-500 text-slate-950'
                              : 'bg-slate-700 hover:bg-slate-600 text-white'
                          }`}
                        >
                          <Eye className="w-2.5 h-2.5" />
                          <span>{showKmOutroPreview ? 'Đóng Outro' : 'Xem thử Outro'}</span>
                        </button>
                      )}
                      <span className="font-mono text-slate-400">{kmPreviewTimeSec.toFixed(1)}s</span>
                    </div>
                  </div>

                  <div className="relative rounded-lg overflow-hidden bg-slate-950 min-h-[185px] flex items-center justify-center border border-slate-800">
                    {kmVideoUrl ? (
                      <video
                        ref={kmVideoRef}
                        controls
                        src={kmVideoUrl}
                        style={{ filter: getPreviewVideoCssFilter(kmEffect) }}
                        onTimeUpdate={(e) => setKmPreviewTimeSec(e.currentTarget.currentTime)}
                        className="w-full max-h-60 mx-auto object-contain"
                      />
                    ) : (
                      <div className="p-6 text-center space-y-1">
                        <Music className="w-7 h-7 text-slate-600 mx-auto" />
                        <p className="text-xs font-medium text-slate-300">
                          Live Preview Karaoke Sub (.ASS) + Watermark/Outro
                        </p>
                        <p className="text-[11px] text-slate-500">
                          Đang hiển thị style <strong>{kmEffectSpec.id}</strong> ({kmSubPosition} · cỡ {kmSubSize}). Chọn Video nền để xem trực tiếp trên video!
                        </p>
                      </div>
                    )}

                    {/* Live Subtitle Style Preview */}
                    {kmActiveCue && !showKmOutroPreview && (
                      <div
                        className={`pointer-events-none absolute inset-x-4 flex justify-center ${
                          kmSubPosition === 'Trên'
                            ? 'top-5'
                            : kmSubPosition === 'Giữa'
                              ? 'top-1/2 -translate-y-1/2'
                              : 'bottom-10'
                        }`}
                      >
                        <div
                          className={`px-3 py-1.5 rounded-lg text-center font-bold max-w-[90%] ${
                            kmEffectSpec.box ? 'bg-slate-900/80 border border-slate-700' : 'bg-black/45'
                          } ${
                            kmSubSize === 'Nhỏ'
                              ? 'text-xs'
                              : kmSubSize === 'Lớn'
                                ? 'text-base'
                                : 'text-sm'
                          }`}
                          style={{
                            textShadow: `0 1px 4px ${kmEffectSpec.outlineColor}`,
                          }}
                        >
                          {(() => {
                            const words = kmActiveCue.text.split(/\s+/).filter(Boolean);
                            const span = Math.max(0.4, kmActiveCue.end - kmActiveCue.start);
                            const pct = Math.max(
                              0,
                              Math.min(1, (kmPreviewTimeSec - kmActiveCue.start) / span),
                            );
                            const activeWordIdx = Math.min(
                              words.length - 1,
                              Math.floor(pct * words.length),
                            );
                            const isTypewriter = kmEffectSpec.mode === 'typewriter';
                            return words.map((w, wi) => {
                              if (isTypewriter && wi > activeWordIdx && kmVideoUrl) return null;
                              const isHighlighted = wi <= activeWordIdx;
                              return (
                                <span
                                  key={`${w}-${wi}`}
                                  style={{
                                    color: isHighlighted
                                      ? kmHighlightColor
                                      : kmEffectSpec.inactiveColor,
                                  }}
                                  className="mx-0.5 inline-block"
                                >
                                  {w}
                                </span>
                              );
                            });
                          })()}
                        </div>
                      </div>
                    )}

                    {watermarkOutro.watermarkEnabled && watermarkOutro.watermarkText.trim() && (
                      <div
                        style={{ opacity: watermarkOutro.watermarkOpacity }}
                        className={`pointer-events-none absolute px-2.5 py-1 rounded bg-black/55 text-white text-xs font-semibold ${wmPosClass}`}
                      >
                        {watermarkOutro.watermarkText}
                      </div>
                    )}

                    {showKmOutroPreview && (
                      <div className="absolute inset-0 bg-slate-900/95 flex flex-col items-center justify-center p-6 text-center space-y-1.5 z-10">
                        <span className="text-[10px] font-bold uppercase tracking-wider text-indigo-400">
                          Xem trước Outro cuối video (+{watermarkOutro.outroSeconds}s sau khi kết thúc karaoke)
                        </span>
                        <div className="text-base font-bold text-white">
                          {watermarkOutro.outroLine1 || 'Thanks for watching!'}
                        </div>
                        {watermarkOutro.outroLine2 && (
                          <div className="text-xs text-slate-300">{watermarkOutro.outroLine2}</div>
                        )}
                      </div>
                    )}
                  </div>

                  {kmVoiceUrl && (
                    <audio ref={kmVoiceRef} controls src={kmVoiceUrl} className="w-full h-8" />
                  )}

                  <VideoSnapshotStrip
                    videoUrl={kmVideoUrl}
                    videoFilterCss={getPreviewVideoCssFilter(kmEffect)}
                    watermarkOutro={watermarkOutro}
                    subtitleSampleText={kmActiveCue?.text}
                    highlightColor={kmHighlightColor}
                    subtitlePosition={kmSubPosition}
                    onSeek={(t) => {
                      if (kmVideoRef.current) {
                        kmVideoRef.current.currentTime = t;
                        setKmPreviewTimeSec(t);
                      }
                    }}
                  />
                </div>

                {/* Karaoke Effect Controls matching 1.19 */}
                <div className="p-3.5 rounded-xl bg-indigo-50/40 border border-indigo-200/70 space-y-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div className="sm:col-span-2">
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Hiệu ứng Karaoke (6 kiểu chuẩn 1.19)
                      </label>
                      <select
                        value={kmStyleId}
                        onChange={(e) => {
                          const nextId = e.target.value;
                          setKmStyleId(nextId);
                          const spec = KARAOKE_EFFECT_PRESETS.find((p) => p.id === nextId);
                          if (spec) setKmHighlightColor(spec.activeColor);
                        }}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        {KARAOKE_EFFECT_PRESETS.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.id}
                          </option>
                        ))}
                      </select>
                      <p className="text-[10px] text-slate-500 mt-1">{kmEffectSpec.description}</p>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Vị trí
                        </label>
                        <select
                          value={kmSubPosition}
                          onChange={(e) => setKmSubPosition(e.target.value as EduKaraokePosition)}
                          className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="Dưới">Dưới</option>
                          <option value="Giữa">Giữa</option>
                          <option value="Trên">Trên</option>
                        </select>
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Cỡ chữ
                        </label>
                        <select
                          value={kmSubSize}
                          onChange={(e) => setKmSubSize(e.target.value as EduKaraokeSize)}
                          className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="Nhỏ">Nhỏ</option>
                          <option value="Vừa">Vừa</option>
                          <option value="Lớn">Lớn</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                {/* SRT / ASS Text */}
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <label className="text-xs font-semibold text-slate-700">
                      Nội dung SRT / Câu thoại để đốt Karaoke .ASS
                    </label>
                    <div className="flex items-center gap-2">
                      <label className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-slate-700 bg-white border border-slate-200 rounded-md hover:bg-slate-50 cursor-pointer">
                        <Upload className="w-3 h-3" />
                        <span>Nạp file .SRT/.VTT/.ASS</span>
                        <input
                          type="file"
                          accept=".srt,.vtt,.ass,.ssa,.lrc,.txt"
                          className="hidden"
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            const txt = await f.text();
                            if (/\.ass$/i.test(f.name) || txt.includes('[V4+ Styles]')) {
                              setKmAssContent(txt);
                            } else {
                              setKmSrtInput(txt);
                            }
                          }}
                        />
                      </label>
                      <label className="inline-flex items-center gap-1 text-[11px] text-slate-600">
                        <span>Màu hát:</span>
                        <input
                          type="color"
                          value={kmHighlightColor}
                          onChange={(e) => setKmHighlightColor(e.target.value)}
                          className="w-6 h-5 rounded border border-slate-200 cursor-pointer"
                        />
                      </label>
                      <button
                        type="button"
                        onClick={handleGenerateAss}
                        className="px-2.5 py-1 text-[11px] font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-md hover:bg-indigo-100"
                      >
                        Sinh mã .ASS →
                      </button>
                    </div>
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10.5px] font-semibold text-slate-600">SRT / Câu thoại</span>
                        <PasteButton
                          onPaste={(txt) => setKmSrtInput(txt)}
                          title="Dán nhanh SRT / câu thoại (thay thế)"
                        />
                      </div>
                      <textarea
                        rows={4}
                        value={kmSrtInput}
                        onChange={(e) => setKmSrtInput(e.target.value)}
                        placeholder="Dán .SRT hoặc từng dòng câu..."
                        className="w-full p-2.5 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[10.5px] font-semibold text-slate-600">Mã Karaoke .ASS</span>
                        <PasteButton
                          onPaste={(txt) => setKmAssContent(txt)}
                          title="Dán nhanh nội dung .ASS (thay thế)"
                        />
                      </div>
                      <textarea
                        rows={4}
                        value={kmAssContent}
                        onChange={(e) => setKmAssContent(e.target.value)}
                        placeholder="Mã Karaoke .ASS tự động sinh (hoặc dán file .ass có sẵn)..."
                        className="w-full p-2.5 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg"
                      />
                    </div>
                  </div>
                </div>

                {/* Video FX + Audio Mix */}
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Hiệu ứng Video FX
                      </label>
                      <select
                        value={kmEffect}
                        onChange={(e) => setKmEffect(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        <option value="Fade cinematic">Fade cinematic</option>
                        <option value="Soft vignette + fade">Soft vignette + fade</option>
                        <option value="Warm film + fade">Warm film + fade</option>
                        <option value="Cool tech + fade">Cool tech + fade</option>
                        <option value="Slow zoom + fade">Slow zoom + fade</option>
                        <option value="None">Không hiệu ứng</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Delay Voiceover (giây)
                      </label>
                      <input
                        type="number"
                        min={0}
                        step={0.2}
                        value={kmVoiceStart}
                        onChange={(e) => setKmVoiceStart(Number(e.target.value))}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Tên file xuất (mặc định tên video gốc)
                      </label>
                      <input
                        type="text"
                        value={kmOutputName}
                        onChange={(e) => setKmOutputName(e.target.value)}
                        placeholder={
                          kmVideoFile
                            ? kmVideoFile.name.replace(/\.[^.]+$/, '')
                            : 'Tự lấy theo tên video gốc'
                        }
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-mono"
                      />
                    </div>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                    <label>
                      <span>Âm gốc: {Math.round(kmOriginalVol * 100)}%</span>
                      <input
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.05}
                        value={kmOriginalVol}
                        onChange={(e) => setKmOriginalVol(Number(e.target.value))}
                        className="w-full accent-indigo-600"
                      />
                    </label>
                    <label>
                      <span>Nhạc nền: {Math.round(kmMusicVol * 100)}%</span>
                      <input
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.05}
                        value={kmMusicVol}
                        onChange={(e) => setKmMusicVol(Number(e.target.value))}
                        className="w-full accent-indigo-600"
                      />
                    </label>
                    <label>
                      <span>SFX: {Math.round(kmSfxVol * 100)}%</span>
                      <input
                        type="range"
                        min={0}
                        max={1.5}
                        step={0.05}
                        value={kmSfxVol}
                        onChange={(e) => setKmSfxVol(Number(e.target.value))}
                        className="w-full accent-indigo-600"
                      />
                    </label>
                    <label>
                      <span>Voice: {Math.round(kmVoiceVol * 100)}%</span>
                      <input
                        type="range"
                        min={0}
                        max={1.8}
                        step={0.05}
                        value={kmVoiceVol}
                        onChange={(e) => setKmVoiceVol(Number(e.target.value))}
                        className="w-full accent-indigo-600"
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap gap-4 text-xs text-slate-700 pt-1">
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={kmVoicePriority}
                        onChange={(e) => setKmVoicePriority(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600"
                      />
                      <span>Ưu tiên Voiceover (Ducking)</span>
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={kmMuteOriginal}
                        onChange={(e) => setKmMuteOriginal(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600"
                      />
                      <span>Tắt tiếng video gốc</span>
                    </label>
                    <label className="inline-flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={kmRemoveDialogue}
                        onChange={(e) => setKmRemoveDialogue(e.target.checked)}
                        className="rounded border-slate-300 text-indigo-600"
                      />
                      <span>Khử giọng trung tâm</span>
                    </label>
                  </div>
                </div>

                {renderOutputFolderControl()}

                <WatermarkOutroSection
                  config={watermarkOutro}
                  onChange={setWatermarkOutro}
                  title="Watermark & Outro (Tùy chọn · Karaoke & Mix)"
                />

                {kmError && (
                  <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                    {kmError}
                  </p>
                )}
                {kmStatus && (
                  <div className="p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 text-xs text-indigo-900 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 font-medium">
                      <span>{kmStatus}</span>
                      {(isRenderingKm || kmProgress > 0) && (
                        <span className="font-mono font-bold tabular-nums">{kmProgress}%</span>
                      )}
                    </div>
                    {isRenderingKm && (
                      <div className="w-full h-1.5 bg-indigo-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 transition-all duration-300"
                          style={{ width: `${Math.max(4, Math.min(100, kmProgress))}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="flex items-center gap-2">
                  {isRenderingKm ? (
                    <button
                      type="button"
                      onClick={handleCancelKaraokeMix}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-white bg-rose-600 rounded-lg hover:bg-rose-700"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      <span>Hủy render</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!kmVideoFile}
                      onClick={() => void handleRunKaraokeMix()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>Add Karaoke + Export MP4</span>
                    </button>
                  )}
                </div>
              </>
            )}

            {/* ── SUB-TAB 3: READING ALONG STUDIO (Book + Pointer + Export MP4) ── */}
            {subTab === 'align' && (
              <>
                {/* Webpage URL Scraper + Web AI Prompt + Inline Gemini API */}
                <div className="p-3.5 rounded-xl bg-gradient-to-br from-indigo-50/80 via-white to-sky-50/70 border border-indigo-200/80 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-xs font-bold text-indigo-950 inline-flex items-center gap-1.5">
                      <Globe className="w-4 h-4 text-indigo-600" />
                      <span>Lấy bài từ Trang Web, Prompt Web AI hoặc Gemini API</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setIsWebPromptOpen((o) => !o)}
                      className="inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 bg-white border border-indigo-200 rounded-lg hover:bg-indigo-50"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{isWebPromptOpen ? 'Ẩn Prompt Web AI' : 'Tạo Prompt cho Web AI (Không cần API Key)'}</span>
                    </button>
                  </div>

                  <ApiKeyInlineControl
                    provider="gemini"
                    hasServerKey={hasReadingGeminiKey}
                    onSaved={refreshReadingVoices}
                    compact
                  />

                  {/* URL Input */}
                  <div className="flex flex-col sm:flex-row gap-2">
                    <div className="relative flex-1">
                      <Link2 className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                      <input
                        type="url"
                        aria-label="Đường link bài báo hoặc truyện tiếng Anh"
                        value={readingUrl}
                        onChange={(e) => setReadingUrl(e.target.value)}
                        placeholder="Dán link bài báo/truyện tiếng Anh (vd: https://...) để lấy vào bài đọc"
                        className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      />
                    </div>
                    <PasteButton
                      size="sm"
                      onPaste={(txt) => setReadingUrl(txt.trim())}
                      title="Dán nhanh link từ Clipboard"
                    />
                    <button
                      type="button"
                      disabled={isScrapingOrGeneratingReading || !readingUrl.trim()}
                      onClick={() => void handleScrapeReadingUrl(undefined, true)}
                      className="inline-flex items-center justify-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 shrink-0"
                    >
                      {isScrapingOrGeneratingReading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Globe className="w-3.5 h-3.5" />
                      )}
                      <span>Lấy nội dung Web</span>
                    </button>
                  </div>

                  {readingUrlSubLinks.length > 0 && (
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[10px] font-semibold text-slate-500">Bài liên quan:</span>
                      {readingUrlSubLinks.map((lnk) => (
                        <button
                          key={lnk.url}
                          type="button"
                          onClick={() => void handleScrapeReadingUrl(lnk.url, true)}
                          className="px-2 py-0.5 text-[10px] font-medium text-indigo-700 bg-white border border-indigo-200 rounded-md hover:bg-indigo-50 truncate max-w-[200px]"
                          title={lnk.title}
                        >
                          {lnk.title}
                        </button>
                      ))}
                    </div>
                  )}

                  {/* AI Generate Topic + Level + Length */}
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 pt-2 border-t border-indigo-100">
                    <input
                      type="text"
                      aria-label="Chủ đề bài đọc"
                      value={readingAiTopic}
                      onChange={(e) => setReadingAiTopic(e.target.value)}
                      placeholder="Chủ đề bài đọc (vd: A rainy day in London, Space travel...)"
                      className="sm:col-span-5 px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                    />
                    <select
                      aria-label="Trình độ CEFR"
                      value={readingAiLevel}
                      onChange={(e) =>
                        setReadingAiLevel(e.target.value as 'A1' | 'A2' | 'B1' | 'B2' | 'C1')
                      }
                      className="sm:col-span-2 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg font-semibold"
                    >
                      <option value="A1">A1 · Cơ bản</option>
                      <option value="A2">A2 · Sơ cấp</option>
                      <option value="B1">B1 · Trung cấp</option>
                      <option value="B2">B2 · Khá</option>
                      <option value="C1">C1 · Nâng cao</option>
                    </select>
                    <select
                      aria-label="Độ dài bài đọc"
                      value={readingAiLength}
                      onChange={(e) => setReadingAiLength(Number(e.target.value))}
                      className="sm:col-span-2 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                    >
                      <option value={65}>Ngắn (~65 từ)</option>
                      <option value={110}>Vừa (~110 từ)</option>
                      <option value={175}>Dài (~175 từ)</option>
                    </select>
                    <button
                      type="button"
                      disabled={isScrapingOrGeneratingReading || !readingAiTopic.trim()}
                      onClick={() => void handleAiGenerateReadingPassage()}
                      className="sm:col-span-3 inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-violet-600 rounded-lg hover:bg-violet-700 disabled:opacity-50"
                    >
                      {isScrapingOrGeneratingReading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      <span>AI Tự tạo bài đọc</span>
                    </button>
                  </div>

                  {/* External Web AI Prompt Builder & Paste Response Box */}
                  {isWebPromptOpen && (
                    <div className="p-3 rounded-xl bg-white border border-indigo-200 space-y-2.5 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-bold text-indigo-950">Prompt cho ChatGPT / Gemini / Claude Web:</span>
                          <button
                            type="button"
                            onClick={() => setReadingWebPromptMode('web-url')}
                            className={`px-2 py-0.5 text-[10px] font-semibold rounded border ${
                              readingWebPromptMode === 'web-url'
                                ? 'bg-indigo-600 border-indigo-600 text-white'
                                : 'bg-slate-50 border-slate-200 text-slate-600'
                            }`}
                          >
                            Theo URL Web
                          </button>
                          <button
                            type="button"
                            onClick={() => setReadingWebPromptMode('topic')}
                            className={`px-2 py-0.5 text-[10px] font-semibold rounded border ${
                              readingWebPromptMode === 'topic'
                                ? 'bg-indigo-600 border-indigo-600 text-white'
                                : 'bg-slate-50 border-slate-200 text-slate-600'
                            }`}
                          >
                            Theo Chủ đề
                          </button>
                        </div>
                        <button
                          type="button"
                          onClick={() => void handleCopyReadingWebPrompt()}
                          className="inline-flex items-center gap-1.5 px-3 py-1 text-[11px] font-semibold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700"
                        >
                          {copiedReadingPrompt ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                          <span>{copiedReadingPrompt ? 'Đã chép Prompt!' : 'Sao chép Prompt Web AI'}</span>
                        </button>
                      </div>

                      <textarea
                        readOnly
                        aria-label="Prompt tạo bài đọc cho Web AI"
                        rows={4}
                        value={readingWebAiPrompt}
                        className="w-full p-2 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg text-slate-700"
                      />

                      <div className="space-y-1.5">
                        <div className="flex items-center justify-between gap-2">
                          <label htmlFor="paste-web-ai-reading" className="text-[11px] font-semibold text-slate-700">
                            Dán kết quả JSON (hoặc đoạn văn) từ Web AI vào đây rồi bấm Áp dụng:
                          </label>
                          <PasteButton
                            onPaste={(txt) => {
                              setPastedReadingAiResponse(txt);
                              setPastedReadingAiError(null);
                            }}
                            title="Dán nhanh kết quả JSON / đoạn văn"
                          />
                        </div>
                        <textarea
                          id="paste-web-ai-reading"
                          rows={3}
                          value={pastedReadingAiResponse}
                          onChange={(e) => {
                            setPastedReadingAiResponse(e.target.value);
                            setPastedReadingAiError(null);
                          }}
                          placeholder='Dán {"title": "...", "topicBadge": "...", "text": "..."} hoặc đoạn văn tiếng Anh...'
                          className="w-full p-2 text-[11px] font-mono bg-slate-50 border border-slate-200 rounded-lg"
                        />
                        {pastedReadingAiError && (
                          <p className="text-[11px] text-rose-700">{pastedReadingAiError}</p>
                        )}
                        <div className="flex justify-end">
                          <button
                            type="button"
                            onClick={handleApplyPastedReadingAi}
                            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[11px] font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            <span>Áp dụng vào Sách</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  )}

                  {(isScrapingOrGeneratingReading || readingAiStageLabel) && (
                    <div className="p-2 rounded-lg bg-white border border-indigo-200 space-y-1">
                      <div className="flex items-center justify-between text-[11px] font-medium text-indigo-900">
                        <span className="truncate">{readingAiStageLabel}</span>
                        <span className="font-mono font-bold tabular-nums">{readingAiProgress}%</span>
                      </div>
                      {isScrapingOrGeneratingReading && (
                        <div className="w-full h-1.5 bg-indigo-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-indigo-600 transition-all duration-300"
                            style={{ width: `${Math.max(8, Math.min(100, readingAiProgress))}%` }}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-12 gap-4 items-start">
                  {/* Left Controls */}
                  <div className="md:col-span-7 space-y-3">
                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label htmlFor="reading-palette-select" className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Màu sách (Book Palette)
                        </label>
                        <select
                          id="reading-palette-select"
                          value={readingPaletteId}
                          onChange={(e) =>
                            setReadingPaletteId(e.target.value as ReadingBookPalette['id'])
                          }
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          {READING_BOOK_PALETTES.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.id}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="reading-illustration-select" className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Phong cách minh họa
                        </label>
                        <select
                          id="reading-illustration-select"
                          value={readingIllustration}
                          onChange={(e) =>
                            setReadingIllustration(e.target.value as ReadingIllustrationStyle)
                          }
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="Flat 2D">Flat 2D - Phẳng</option>
                          <option value="2.5D">2.5D - Minh họa nổi khối</option>
                          <option value="3D Cartoon">3D Cartoon - Giả lập 3D</option>
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label htmlFor="reading-book-frame-select" className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Khung sách (5 mẫu)
                        </label>
                        <select
                          id="reading-book-frame-select"
                          value={readingBookFrame}
                          onChange={(e) => setReadingBookFrame(e.target.value as ReadingBookFrameId)}
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          {READING_BOOK_FRAMES.map((bf) => (
                            <option key={bf.id} value={bf.id}>
                              {bf.label}
                            </option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="reading-pointer-style-select" className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Kiểu con trỏ chỉ chữ (7 mẫu)
                        </label>
                        <select
                          id="reading-pointer-style-select"
                          value={readingPointerStyle}
                          onChange={(e) =>
                            setReadingPointerStyle(e.target.value as ReadingPointerStyleId)
                          }
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          {READING_POINTER_STYLES.map((ps) => (
                            <option key={ps.id} value={ps.id}>
                              {ps.label}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2.5">
                      <div>
                        <label htmlFor="reading-title-input" className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Tiêu đề trang sách
                        </label>
                        <input
                          id="reading-title-input"
                          type="text"
                          value={readingTitle}
                          onChange={(e) => setReadingTitle(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        />
                      </div>
                      <div>
                        <label htmlFor="reading-topic-input" className="block text-[11px] font-semibold text-slate-700 mb-1">
                          Chủ đề / Trình độ
                        </label>
                        <input
                          id="reading-topic-input"
                          type="text"
                          value={readingTopic}
                          onChange={(e) => setReadingTopic(e.target.value)}
                          className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        />
                      </div>
                    </div>

                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
                        <label htmlFor="reading-passage-textarea" className="text-[11px] font-semibold text-slate-700">
                          Nội dung bài đọc
                        </label>
                        <div className="flex items-center gap-3">
                          <PasteButton
                            onPaste={(txt) => {
                              setReadingText(txt);
                              setAlignResult(null);
                              setAlignCurrentSec(0);
                            }}
                            title="Dán nhanh bài đọc mới (thay thế)"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const cleaned = cleanReadingWorksheetInput(readingText, readingTitle);
                              if (cleaned.title) setReadingTitle(cleaned.title);
                              if (cleaned.bodyText) setReadingText(cleaned.bodyText);
                              setAlignResult(null);
                              setAlignCurrentSec(0);
                              setSynthesizedReadingSig('');
                            }}
                            className="text-[11px] font-semibold text-emerald-700 hover:text-emerald-800 whitespace-nowrap"
                          >
                            Làm sạch tiêu đề bài tập
                          </button>
                          <label className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-700 cursor-pointer">
                            Nhập TXT / SRT...
                            <input
                              type="file"
                              accept=".txt,.md,.srt,.vtt"
                              className="hidden"
                              onChange={async (e) => {
                                const f = e.target.files?.[0];
                                if (f) {
                                  const raw = await f.text();
                                  const cleaned = cleanReadingWorksheetInput(raw);
                                  if (cleaned.title) setReadingTitle(cleaned.title);
                                  setReadingText(cleaned.bodyText || raw);
                                  setAlignResult(null);
                                  setAlignCurrentSec(0);
                                  setSynthesizedReadingSig('');
                                }
                              }}
                            />
                          </label>
                        </div>
                      </div>
                      <textarea
                        id="reading-passage-textarea"
                        rows={4}
                        value={readingText}
                        onChange={(e) => {
                          setReadingText(e.target.value);
                          setAlignResult(null);
                          setAlignCurrentSec(0);
                        }}
                        className="w-full p-2.5 text-xs bg-slate-50 border border-slate-200 rounded-lg leading-relaxed"
                      />
                    </div>

                    {/* Intro "Hôm nay học gì?", Spoken Outro & Background Music */}
                    <div className="p-3 rounded-xl bg-indigo-50/50 border border-indigo-200 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] font-bold text-indigo-950">
                          Intro (&quot;Hôm nay học gì?&quot;) · Outro có lời · Nhạc nền
                        </span>
                        <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-700">
                          <label className="inline-flex items-center gap-1.5 font-semibold cursor-pointer">
                            <input
                              type="checkbox"
                              checked={readingIntroEnabled}
                              onChange={(e) => setReadingIntroEnabled(e.target.checked)}
                              className="rounded border-slate-300 text-indigo-600"
                            />
                            <span>Bật Intro</span>
                          </label>
                          <label className="inline-flex items-center gap-1.5 font-semibold cursor-pointer">
                            <input
                              type="checkbox"
                              checked={readingOutroSpeechEnabled}
                              onChange={(e) => setReadingOutroSpeechEnabled(e.target.checked)}
                              className="rounded border-slate-300 text-indigo-600"
                            />
                            <span>Đọc Outro bằng AI</span>
                          </label>
                        </div>
                      </div>

                      {readingIntroEnabled && (
                        <div className="space-y-1">
                          <div className="flex items-center justify-between">
                            <label htmlFor="reading-intro-input" className="text-[10px] font-semibold text-indigo-900">
                              Lời mở đầu Intro (hiển thị &amp; đọc đầu video)
                            </label>
                            {isReadingIntroCustom && (
                              <button
                                type="button"
                                onClick={() => setIsReadingIntroCustom(false)}
                                className="text-[10px] font-semibold text-indigo-600 hover:text-indigo-800"
                              >
                                Tự động theo tiêu đề
                              </button>
                            )}
                          </div>
                          <input
                            id="reading-intro-input"
                            type="text"
                            value={readingIntroText}
                            onChange={(e) => {
                              setIsReadingIntroCustom(true);
                              setReadingIntroText(e.target.value);
                            }}
                            className="w-full px-2.5 py-1.5 text-xs bg-white border border-indigo-200 rounded-lg"
                          />
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <div>
                          <label htmlFor="reading-bgm-select" className="block text-[10px] font-semibold text-slate-700 mb-0.5">
                            Nhạc nền (BGM)
                          </label>
                          <select
                            id="reading-bgm-select"
                            value={readingBgmPreset}
                            onChange={(e) => setReadingBgmPreset(e.target.value as StudioBgmPresetId)}
                            className="w-full px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                          >
                            {STUDIO_BGM_PRESETS.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <div className="flex items-center justify-between text-[10px] font-semibold text-slate-700 mb-0.5">
                            <label htmlFor="reading-bgm-vol">Âm lượng nhạc nền</label>
                            <span className="font-mono">{Math.round(readingBgmVolume * 100)}%</span>
                          </div>
                          <input
                            id="reading-bgm-vol"
                            type="range"
                            min={0}
                            max={0.45}
                            step={0.02}
                            value={readingBgmVolume}
                            disabled={readingBgmPreset === 'none'}
                            onChange={(e) => setReadingBgmVolume(Number(e.target.value))}
                            className="w-full accent-indigo-600 mt-1"
                          />
                        </div>
                      </div>
                    </div>

                    {/* TTS / Audio + Fast Forced Align & Whisper */}
                    <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-[11px] font-bold text-slate-800">
                          Audio giọng đọc (Xuất TTS hoặc Nạp file có sẵn)
                        </span>
                        <label className="inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold text-indigo-700 bg-white border border-indigo-200 rounded-md hover:bg-indigo-50 cursor-pointer">
                          <Upload className="w-3 h-3" />
                          <span>{alignFile ? alignFile.name : 'Chọn Audio/Video'}</span>
                          <input
                            type="file"
                            accept="audio/*,video/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0] ?? null;
                              setAlignFile(f);
                              setIsCustomAlignAudio(Boolean(f));
                              setAlignError(null);
                              setAlignResult(null);
                              setAlignCurrentSec(0);
                              setAlignAudioUrl((prev) => {
                                if (prev) URL.revokeObjectURL(prev);
                                return f ? URL.createObjectURL(f) : null;
                              });
                            }}
                          />
                        </label>
                      </div>

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <select
                          aria-label="Nhà cung cấp TTS bài đọc"
                          value={readingProvider}
                          onChange={(e) => setReadingProvider(e.target.value)}
                          className="px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="auto">Tự động (Edge TTS miễn phí)</option>
                          <option value="edge">Edge TTS (Miễn phí)</option>
                          <option value="elevenlabs">
                            ElevenLabs AI Voice ({effectiveReadingElevenLabsKey ? 'Đã có Key' : 'Nhập Key ngay dưới'})
                          </option>
                          <option value="google">Google Translate TTS (Miễn phí)</option>
                          <option value="polly">Amazon Polly (Miễn phí)</option>
                          <option value="gemini">
                            Gemini Flash TTS ({effectiveReadingGeminiKey ? 'Đã có Key' : 'Nhập Key ngay dưới'})
                          </option>
                        </select>
                        <select
                          aria-label="Giọng đọc bài đọc"
                          value={readingVoice}
                          onChange={(e) => setReadingVoice(e.target.value)}
                          className="sm:col-span-2 px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          {allReadingVoices.length === 0 ? (
                            <option value="en-US-JennyNeural">Edge TTS — Jenny (English US)</option>
                          ) : (
                            allReadingVoices.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.label}
                              </option>
                            ))
                          )}
                        </select>
                      </div>

                      {(readingProvider === 'elevenlabs' || readingProvider === 'gemini') && (
                        <ApiKeyInlineControl
                          provider={readingProvider === 'elevenlabs' ? 'elevenlabs' : 'gemini'}
                          hasServerKey={
                            readingProvider === 'elevenlabs'
                              ? hasReadingElevenLabsKey
                              : hasReadingGeminiKey
                          }
                          onSaved={refreshReadingVoices}
                          compact
                        />
                      )}

                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          aria-label="Tốc độ đọc TTS"
                          value={readingTtsRate}
                          onChange={(e) => setReadingTtsRate(Number(e.target.value))}
                          className="px-2 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                        >
                          <option value={0.75}>0.75x</option>
                          <option value={0.9}>0.9x</option>
                          <option value={1.0}>1.0x</option>
                          <option value={1.15}>1.15x</option>
                          <option value={1.3}>1.3x</option>
                        </select>
                        <button
                          type="button"
                          disabled={isGeneratingReadingTts || !readingText.trim()}
                          onClick={() => void handleGenerateReadingTts()}
                          className="flex-1 inline-flex items-center justify-center gap-1 px-2.5 py-1.5 text-[11px] font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50"
                        >
                          {isGeneratingReadingTts ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <Volume2 className="w-3 h-3" />
                          )}
                          <span>
                            {isGeneratingReadingTts
                              ? `Đang tạo Audio... ${readingTtsProgress}%`
                              : 'Tạo Audio TTS & Đồng bộ từ'}
                          </span>
                        </button>
                      </div>

                      {(isGeneratingReadingTts || isAligning) && (
                        <div className="p-2 rounded-lg bg-emerald-50 border border-emerald-200 space-y-1">
                          <div className="flex items-center justify-between text-[11px] font-medium text-emerald-900">
                            <span className="truncate">{readingTtsStageLabel || 'Đang xử lý...'}</span>
                            <span className="font-mono font-bold tabular-nums">{readingTtsProgress}%</span>
                          </div>
                          <div className="w-full h-1.5 bg-emerald-200 rounded-full overflow-hidden">
                            <div
                              className="h-full bg-emerald-600 transition-all duration-300"
                              style={{ width: `${Math.max(4, Math.min(100, readingTtsProgress))}%` }}
                            />
                          </div>
                        </div>
                      )}

                      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                        <select
                          aria-label="Chế độ căn chỉnh từ"
                          value={alignMode}
                          onChange={(e) => setAlignMode(e.target.value as 'fast-forced' | 'whisper')}
                          className="px-2 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg font-medium"
                        >
                          <option value="fast-forced">⚡ Fast Forced Align (&lt;0.2s)</option>
                          <option value="whisper">Whisper ONNX (Chậm hơn)</option>
                        </select>
                        <select
                          aria-label="Model Whisper căn chữ"
                          disabled={alignMode === 'fast-forced'}
                          value={alignModel}
                          onChange={(e) => setAlignModel(e.target.value)}
                          className="px-2 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg font-mono disabled:opacity-50"
                        >
                          <option value="Xenova/whisper-small">whisper-small</option>
                          <option value="Xenova/whisper-base">whisper-base</option>
                          <option value="Xenova/whisper-tiny">whisper-tiny</option>
                          <option value="large-v3-turbo">large-v3-turbo</option>
                        </select>
                        <select
                          aria-label="Ngôn ngữ căn chữ"
                          value={alignLang}
                          onChange={(e) => setAlignLang(e.target.value)}
                          className="px-2 py-1.5 text-[11px] bg-white border border-slate-200 rounded-lg"
                        >
                          <option value="auto">Tự động ngôn ngữ</option>
                          <option value="en">English</option>
                          <option value="vi">Tiếng Việt</option>
                          <option value="ja">日本語</option>
                        </select>
                      </div>

                      {alignFile && (
                        <button
                          type="button"
                          disabled={isAligning}
                          onClick={() => void handleRunWordAlign()}
                          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100 disabled:opacity-50"
                        >
                          {isAligning ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Wand2 className="w-3.5 h-3.5" />
                          )}
                          <span>
                            {isAligning
                              ? `Đang căn chỉnh từng từ... ${readingTtsProgress}%`
                              : alignMode === 'fast-forced'
                                ? '⚡ Căn nhịp siêu tốc theo kịch bản (<0.2s)'
                                : 'Chạy Whisper Word Alignment (khớp bàn tay)'}
                          </span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Right Live Book + Pointer Preview */}
                  <div className="md:col-span-5 bg-slate-900 rounded-xl p-3 text-white space-y-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-1.5 text-[11px]">
                      <span className="font-bold text-indigo-300">BOOK + POINTER PREVIEW</span>
                      <div className="flex items-center gap-1.5">
                        {readingTimeline.hasOutro && (
                          <button
                            type="button"
                            onClick={() => {
                              const targetSec = Math.min(
                                readingTimeline.effectiveTotalDuration - 0.1,
                                readingTimeline.outroStart + 0.05,
                              );
                              setAlignCurrentSec(targetSec);
                              setIsPlayingReadingPreview(true);
                              if (
                                alignAudioRef.current &&
                                alignAudioUrl &&
                                alignAudioDur > readingTimeline.outroStart + 0.1
                              ) {
                                alignAudioRef.current.currentTime = Math.min(targetSec, alignAudioDur);
                                void alignAudioRef.current.play().catch(() => undefined);
                              } else {
                                alignAudioRef.current?.pause();
                              }
                            }}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 text-[10px] font-bold"
                          >
                            <Eye className="w-2.5 h-2.5" />
                            <span>Xem thử Outro</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            if (isPlayingReadingPreview) {
                              setIsPlayingReadingPreview(false);
                              alignAudioRef.current?.pause();
                            } else {
                              const startAt =
                                alignCurrentSec >= readingTimeline.effectiveTotalDuration - 0.05
                                  ? 0
                                  : alignCurrentSec;
                              if (startAt !== alignCurrentSec) {
                                setAlignCurrentSec(startAt);
                              }
                              setIsPlayingReadingPreview(true);
                              if (alignAudioRef.current && alignAudioUrl) {
                                const audioLimit = Math.max(
                                  readingTimeline.contentEnd,
                                  alignAudioDur || readingTimeline.effectiveTotalDuration,
                                );
                                if (startAt < audioLimit) {
                                  alignAudioRef.current.currentTime = Math.min(startAt, audioLimit);
                                  void alignAudioRef.current.play().catch(() => undefined);
                                }
                              }
                            }
                          }}
                          className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[10px] font-semibold"
                        >
                          {isPlayingReadingPreview ? (
                            <>
                              <Pause className="w-2.5 h-2.5" />
                              <span>Tạm dừng</span>
                            </>
                          ) : (
                            <>
                              <Play className="w-2.5 h-2.5 fill-current" />
                              <span>Phát thử trang sách</span>
                            </>
                          )}
                        </button>
                      </div>
                    </div>

                    <div className={`${previewCanvasDims.cls} mx-auto rounded-lg overflow-hidden bg-slate-950 border border-slate-800`}>
                      <canvas
                        ref={readingCanvasRef}
                        data-testid="reading-along-canvas"
                        width={previewCanvasDims.w}
                        height={previewCanvasDims.h}
                        className="w-full h-full object-contain"
                      />
                    </div>

                    <div className="flex items-center gap-2">
                      <input
                        type="range"
                        aria-label="Thanh tua xem trước Reading Along"
                        min={0}
                        max={readingTimeline.effectiveTotalDuration}
                        step={0.05}
                        value={Math.min(alignCurrentSec, readingTimeline.effectiveTotalDuration)}
                        onChange={(e) => {
                          const t = Number(e.target.value);
                          setAlignCurrentSec(t);
                          if (alignAudioRef.current && alignAudioUrl) {
                            const audioLimit = Math.max(
                              readingTimeline.contentEnd,
                              alignAudioDur || readingTimeline.effectiveTotalDuration,
                            );
                            if (t < audioLimit) {
                              alignAudioRef.current.currentTime = Math.min(
                                t,
                                alignAudioRef.current.duration || t,
                              );
                            } else {
                              alignAudioRef.current.pause();
                            }
                          }
                        }}
                        className="flex-1 accent-indigo-400 h-1"
                      />
                      <span className="text-[10px] font-mono text-slate-300 tabular-nums">
                        {alignCurrentSec.toFixed(1)}s / {readingTimeline.effectiveTotalDuration.toFixed(1)}s
                      </span>
                    </div>
                    {(readingTimeline.hasIntro || readingTimeline.hasOutro) && (
                      <div className="text-[10px] text-slate-400 flex flex-wrap items-center justify-between gap-1">
                        <span>
                          {readingTimeline.hasIntro
                            ? `Intro: 0→${readingTimeline.introEnd.toFixed(1)}s · `
                            : ''}
                          Chữ kết thúc: {readingTimeline.lastWordEnd.toFixed(1)}s
                        </span>
                        {readingTimeline.hasOutro && (
                          <span className="text-amber-300">
                            Outro: {readingTimeline.outroStart.toFixed(1)}s (không đè chữ)
                          </span>
                        )}
                      </div>
                    )}

                    {alignAudioUrl && (
                      <audio
                        ref={alignAudioRef}
                        controls
                        src={alignAudioUrl}
                        onLoadedMetadata={(e) => {
                          if (Number.isFinite(e.currentTarget.duration)) {
                            setAlignAudioDur(e.currentTarget.duration);
                          }
                        }}
                        onTimeUpdate={(e) => {
                          if (!e.currentTarget.paused) {
                            setAlignCurrentSec(e.currentTarget.currentTime);
                          }
                        }}
                        onEnded={() => {
                          if (
                            readingTimeline.hasOutro &&
                            alignCurrentSec < readingTimeline.effectiveTotalDuration - 0.15
                          ) {
                            setAlignCurrentSec((prev) => Math.max(prev, readingTimeline.contentEnd));
                            setIsPlayingReadingPreview(true);
                          } else {
                            setIsPlayingReadingPreview(false);
                          }
                        }}
                        className="w-full h-8"
                      />
                    )}
                  </div>
                </div>

                {/* Video Frame Aspect Ratio + Resolution + Quality + FPS */}
                <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 space-y-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-slate-800">
                      Cấu hình khung hình &amp; chất lượng Video Reading Along
                    </span>
                    <span className="text-[11px] font-mono text-slate-600 tabular-nums">
                      {resolvedReadingDims.width}×{resolvedReadingDims.height} · {resolvedReadingDims.fps}fps
                    </span>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Khung hình (Tỷ lệ)
                      </label>
                      <select
                        value={readingAspect}
                        onChange={(e) => setReadingAspect(e.target.value as ExportAspectRatioId)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        {ASPECT_RATIO_OPTIONS.map((opt) => (
                          <option key={opt.id} value={opt.id}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Độ phân giải
                      </label>
                      <select
                        value={readingResolution}
                        onChange={(e) => setReadingResolution(e.target.value as ExportResolutionId)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        <option value="540p">540p (Nhanh)</option>
                        <option value="720p">720p (HD Chuẩn)</option>
                        <option value="1080p">1080p (Full HD)</option>
                        <option value="1440p">1440p (2K Siêu nét)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Chất lượng nén
                      </label>
                      <select
                        value={readingQuality}
                        onChange={(e) => setReadingQuality(e.target.value as ExportQualityId)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        <option value="standard">Tiêu chuẩn</option>
                        <option value="high">Cao (Nét chữ rõ)</option>
                        <option value="ultra">Ultra (Rất nét)</option>
                      </select>
                    </div>
                    <div>
                      <label className="block text-[11px] font-semibold text-slate-700 mb-1">
                        Khung hình/giây (FPS)
                      </label>
                      <select
                        value={readingFps}
                        onChange={(e) => setReadingFps(Number(e.target.value) as ExportFpsOption)}
                        className="w-full px-2.5 py-1.5 text-xs bg-white border border-slate-200 rounded-lg"
                      >
                        <option value={24}>24 fps</option>
                        <option value={30}>30 fps</option>
                        <option value={60}>60 fps (Mượt)</option>
                      </select>
                    </div>
                  </div>
                </div>

                {renderOutputFolderControl()}

                <WatermarkOutroSection
                  config={watermarkOutro}
                  onChange={setWatermarkOutro}
                  title="Watermark & Outro (Tùy chọn · Reading Along MP4)"
                />

                {alignError && (
                  <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg p-2.5">
                    {alignError}
                  </p>
                )}

                {readingExportStatus && (
                  <div className="p-2.5 rounded-lg bg-indigo-50 border border-indigo-200 text-xs text-indigo-800 space-y-1.5">
                    <div className="flex items-center justify-between font-medium">
                      <span>{readingExportStatus}</span>
                      {isExportingReadingMp4 && (
                        <span className="font-mono">{Math.round(readingExportProgress * 100)}%</span>
                      )}
                    </div>
                    {isExportingReadingMp4 && (
                      <div className="w-full h-1.5 bg-indigo-200 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 transition-all"
                          style={{ width: `${Math.round(readingExportProgress * 100)}%` }}
                        />
                      </div>
                    )}
                  </div>
                )}

                <div className="flex flex-wrap items-center gap-2">
                  {isExportingReadingMp4 ? (
                    <button
                      type="button"
                      onClick={() => readingAbortRef.current?.abort()}
                      className="inline-flex items-center gap-1.5 px-4 py-2.5 text-xs font-bold text-white bg-rose-600 rounded-lg hover:bg-rose-700"
                    >
                      <Square className="w-3.5 h-3.5 fill-current" />
                      <span>Hủy xuất MP4</span>
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={!readingText.trim()}
                      onClick={() => void handleExportReadingAlongMp4()}
                      className="inline-flex items-center gap-2 px-5 py-2.5 text-xs font-bold text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50"
                    >
                      <Sparkles className="w-4 h-4" />
                      <span>Xuất Reading Along MP4</span>
                    </button>
                  )}

                  {alignResult && (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          const blob = new Blob([alignResult.srt], { type: 'text/plain;charset=utf-8' });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement('a');
                          a.href = url;
                          a.download = 'aligned.srt';
                          a.click();
                          setTimeout(() => URL.revokeObjectURL(url), 4000);
                        }}
                        className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
                      >
                        <Download className="w-3.5 h-3.5" />
                        <span>Tải .SRT</span>
                      </button>
                      {onSendAudioCuesToStudio && (
                        <button
                          type="button"
                          onClick={() =>
                            onSendAudioCuesToStudio(
                              alignFile,
                              alignResult.cues,
                              readingTitle || alignFile?.name.replace(/\.[^.]+$/, '') || 'Aligned Lesson',
                            )
                          }
                          className="inline-flex items-center gap-1 px-3 py-2 text-xs font-semibold text-indigo-700 bg-indigo-50 border border-indigo-200 rounded-lg hover:bg-indigo-100"
                        >
                          <Play className="w-3.5 h-3.5 fill-current" />
                          <span>Nạp sang Studio 9:16</span>
                        </button>
                      )}
                    </>
                  )}
                </div>

                {alignResult && alignResult.words.length > 0 && (
                  <div className="p-3 rounded-xl bg-slate-50 border border-slate-200 space-y-2">
                    <div className="text-xs font-bold text-emerald-800 inline-flex items-center gap-1.5">
                      <CheckCircle2 className="w-4 h-4 text-emerald-600" />
                      <span>
                        {alignResult.backendUsed} ({alignResult.modelUsed})
                        {alignResult.language ? ` · ${alignResult.language}` : ''} ·{' '}
                        {alignResult.words.length} từ đã căn chỉnh (bấm vào từ để nhảy bàn tay)
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-1.5 max-h-36 overflow-y-auto p-2 bg-white rounded-lg border border-slate-200">
                      {alignResult.words.map((w, idx) => {
                        const active = alignCurrentSec >= w.start && alignCurrentSec <= w.end;
                        return (
                          <button
                            key={`${w.start}-${idx}`}
                            type="button"
                            onClick={() => {
                              setAlignCurrentSec(w.start);
                              if (alignAudioRef.current && alignAudioUrl) {
                                alignAudioRef.current.currentTime = w.start;
                                void alignAudioRef.current.play().catch(() => undefined);
                              }
                            }}
                            title={`${w.start.toFixed(2)}s - ${w.end.toFixed(2)}s`}
                            className={`px-2 py-0.5 text-xs rounded-md transition-colors ${
                              active
                                ? 'bg-indigo-600 text-white font-bold shadow-xs'
                                : 'bg-slate-100 text-slate-800 hover:bg-indigo-50'
                            }`}
                          >
                            {w.word}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
  );
};
