import { WordTiming } from './types';

export type StudioBgmPresetId = 'none' | 'lofi-calm' | 'soft-study' | 'cafe-room' | 'soft-rain';

export const STUDIO_BGM_PRESETS: Array<{ id: StudioBgmPresetId; label: string }> = [
  { id: 'lofi-calm', label: 'Lofi Calm (Nhẹ nhàng)' },
  { id: 'soft-study', label: 'Soft Study (Tập trung)' },
  { id: 'cafe-room', label: 'Cafe Ambience (Quán cà phê)' },
  { id: 'soft-rain', label: 'Soft Rain (Mưa êm dịu)' },
  { id: 'none', label: 'Không nhạc nền' },
];

export interface SpeechWindow {
  start: number;
  end: number;
}

/**
 * Pure helper to shift word timings forward by Intro speech + gap offset.
 */
export function shiftReadingWordsForIntro(
  words: WordTiming[],
  offsetSec: number,
): WordTiming[] {
  const safeOffset = Math.max(0, Number(offsetSec) || 0);
  if (safeOffset <= 0) return words.map((w) => ({ ...w }));
  return words.map((w) => ({
    ...w,
    start: Number((w.start + safeOffset).toFixed(3)),
    end: Number((w.end + safeOffset).toFixed(3)),
  }));
}

/**
 * Pure helper to compute music ducking gain at any timestamp:
 * - Gently ducks BGM when voice is actively speaking
 * - Lets BGM breathe during Intro/Outro & silent pauses
 * - Applies smooth fade-in (0.3s) and fade-out (0.7s) at edges
 */
export function computeDuckingGainAtTime(params: {
  timeSec: number;
  speechWindows: SpeechWindow[];
  baseVolume: number;
  introEndSec?: number;
  outroStartSec?: number;
  totalDurationSec: number;
}): number {
  const base = Math.max(0, Math.min(0.65, Number(params.baseVolume) || 0));
  if (base <= 0) return 0;

  const t = Math.max(0, params.timeSec);
  const total = Math.max(0.5, params.totalDurationSec);

  const isSpeaking = params.speechWindows.some(
    (w) => t >= w.start - 0.08 && t <= w.end + 0.12,
  );
  const inOutroTail =
    typeof params.outroStartSec === 'number' &&
    t >= params.outroStartSec &&
    !isSpeaking;

  let target = isSpeaking
    ? base * 0.42
    : inOutroTail
      ? Math.min(0.65, base * 1.25)
      : base * 0.9;

  if (t < 0.35) {
    target *= Math.max(0.15, t / 0.35);
  }
  const remain = total - t;
  if (remain < 0.7) {
    target *= Math.max(0, remain / 0.7);
  }

  return Number(Math.max(0, Math.min(0.75, target)).toFixed(4));
}

/**
 * Pure stereo 16-bit PCM WAV encoder usable in both Node tests and Browser.
 */
export function encodeStereoFloatChannelsToWavArrayBuffer(
  left: Float32Array,
  right: Float32Array,
  sampleRate = 48000,
): ArrayBuffer {
  const numFrames = Math.min(left.length, right.length);
  const numChannels = 2;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const dataByteLength = numFrames * blockAlign;
  const buffer = new ArrayBuffer(44 + dataByteLength);
  const view = new DataView(buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataByteLength, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);
  writeStr(36, 'data');
  view.setUint32(40, dataByteLength, true);

  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    const lSample = Math.max(-1, Math.min(1, left[i]));
    const rSample = Math.max(-1, Math.min(1, right[i]));
    view.setInt16(offset, lSample < 0 ? lSample * 0x8000 : lSample * 0x7fff, true);
    view.setInt16(offset + 2, rSample < 0 ? rSample * 0x8000 : rSample * 0x7fff, true);
    offset += 4;
  }

  return buffer;
}

function audioBufferToWavFile(buffer: AudioBuffer, fileName: string): File {
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const wavBuf = encodeStereoFloatChannelsToWavArrayBuffer(left, right, buffer.sampleRate);
  const safeName = fileName.toLowerCase().endsWith('.wav')
    ? fileName
    : `${fileName.replace(/\.[^.]+$/, '')}.wav`;
  return new File([wavBuf], safeName, { type: 'audio/wav' });
}

/**
 * Concatenates multiple audio File segments cleanly in the browser using OfflineAudioContext,
 * returning exact start offsets and individual durations so word timings stay 100% locked.
 */
export async function concatAudioFilesWithGaps(
  parts: Array<{ file: File; pauseAfterSec?: number }>,
  outputFileName = 'combined_speech.wav',
): Promise<{
  file: File;
  durationSec: number;
  segmentOffsets: number[];
  segmentDurations: number[];
}> {
  if (parts.length === 0) {
    throw new Error('Không có đoạn audio nào để nối.');
  }

  const audioCtx = new AudioContext();
  try {
    const sampleRate = 48000;
    const decodedList: AudioBuffer[] = [];
    for (const part of parts) {
      const buf = await audioCtx.decodeAudioData(await part.file.arrayBuffer());
      decodedList.push(buf);
    }

    const segmentOffsets: number[] = [];
    const segmentDurations: number[] = [];
    let cursorSec = 0;

    decodedList.forEach((buf, idx) => {
      segmentOffsets.push(Number(cursorSec.toFixed(3)));
      segmentDurations.push(Number(buf.duration.toFixed(3)));
      cursorSec += buf.duration + Math.max(0, parts[idx].pauseAfterSec ?? 0);
    });

    const totalSec = Math.max(0.5, cursorSec);
    const totalSamples = Math.max(1, Math.ceil(totalSec * sampleRate));
    const offline = new OfflineAudioContext(2, totalSamples, sampleRate);

    decodedList.forEach((buf, idx) => {
      const src = offline.createBufferSource();
      src.buffer = buf;
      src.connect(offline.destination);
      src.start(segmentOffsets[idx]);
    });

    const rendered = await offline.startRendering();
    const file = audioBufferToWavFile(rendered, outputFileName);
    return {
      file,
      durationSec: Number(rendered.duration.toFixed(3)),
      segmentOffsets,
      segmentDurations,
    };
  } finally {
    await audioCtx.close().catch(() => undefined);
  }
}

/**
 * Mixes a primary voiceover File with a looping studio background music preset
 * (fetched from /api/studio/default-audio?preset=...), gently ducking music during
 * spoken segments and letting it play cleanly through pauses & Outro.
 */
export async function mixVoiceWithBgmPreset(params: {
  voiceFile: File | null;
  bgmPreset: StudioBgmPresetId;
  bgmVolume: number;
  speechWindows?: SpeechWindow[];
  introEndSec?: number;
  outroStartSec?: number;
  minTotalDurationSec?: number;
  outputFileName?: string;
}): Promise<{ file: File | null; durationSec: number }> {
  const safeVol = Math.max(0, Math.min(0.65, Number(params.bgmVolume) || 0));
  if (!params.voiceFile && (params.bgmPreset === 'none' || safeVol <= 0)) {
    return { file: null, durationSec: params.minTotalDurationSec ?? 0 };
  }
  if (params.voiceFile && (params.bgmPreset === 'none' || safeVol <= 0)) {
    // Still extend silence tail if minTotalDurationSec > voice duration? Only needed when Outro has music.
    const tmpCtx = new AudioContext();
    try {
      const dec = await tmpCtx.decodeAudioData(await params.voiceFile.arrayBuffer());
      return { file: params.voiceFile, durationSec: Number(dec.duration.toFixed(3)) };
    } catch {
      return { file: params.voiceFile, durationSec: params.minTotalDurationSec ?? 0 };
    } finally {
      await tmpCtx.close().catch(() => undefined);
    }
  }

  const audioCtx = new AudioContext();
  try {
    const sampleRate = 48000;
    let voiceBuf: AudioBuffer | null = null;
    if (params.voiceFile) {
      voiceBuf = await audioCtx.decodeAudioData(await params.voiceFile.arrayBuffer());
    }

    let bgmBuf: AudioBuffer | null = null;
    if (params.bgmPreset !== 'none' && safeVol > 0) {
      try {
        const res = await fetch(
          `/api/studio/default-audio?preset=${encodeURIComponent(params.bgmPreset)}`,
        );
        if (res.ok) {
          bgmBuf = await audioCtx.decodeAudioData(await res.arrayBuffer());
        }
      } catch {
        bgmBuf = null;
      }
    }

    if (!bgmBuf) {
      return {
        file: params.voiceFile,
        durationSec: voiceBuf ? Number(voiceBuf.duration.toFixed(3)) : (params.minTotalDurationSec ?? 0),
      };
    }

    const totalDur = Math.max(
      1,
      voiceBuf?.duration ?? 0,
      params.minTotalDurationSec ?? 0,
    );
    const totalSamples = Math.max(1, Math.ceil(totalDur * sampleRate));
    const offline = new OfflineAudioContext(2, totalSamples, sampleRate);

    if (voiceBuf) {
      const voiceSrc = offline.createBufferSource();
      voiceSrc.buffer = voiceBuf;
      voiceSrc.connect(offline.destination);
      voiceSrc.start(0);
    }

    const bgmSrc = offline.createBufferSource();
    bgmSrc.buffer = bgmBuf;
    bgmSrc.loop = true;

    const gainNode = offline.createGain();
    const windows =
      params.speechWindows && params.speechWindows.length > 0
        ? params.speechWindows
        : voiceBuf
          ? [{ start: 0, end: voiceBuf.duration }]
          : [];

    // Sample gain envelope at 20Hz for ultra-smooth ducking & fades
    const step = 0.05;
    gainNode.gain.setValueAtTime(
      computeDuckingGainAtTime({
        timeSec: 0,
        speechWindows: windows,
        baseVolume: safeVol,
        introEndSec: params.introEndSec,
        outroStartSec: params.outroStartSec,
        totalDurationSec: totalDur,
      }),
      0,
    );
    for (let t = step; t <= totalDur; t += step) {
      const g = computeDuckingGainAtTime({
        timeSec: t,
        speechWindows: windows,
        baseVolume: safeVol,
        introEndSec: params.introEndSec,
        outroStartSec: params.outroStartSec,
        totalDurationSec: totalDur,
      });
      gainNode.gain.linearRampToValueAtTime(g, Math.min(totalDur, t));
    }

    bgmSrc.connect(gainNode);
    gainNode.connect(offline.destination);
    bgmSrc.start(0);
    bgmSrc.stop(totalDur);

    const rendered = await offline.startRendering();
    const outFile = audioBufferToWavFile(
      rendered,
      params.outputFileName || params.voiceFile?.name || 'mixed_lesson.wav',
    );
    return {
      file: outFile,
      durationSec: Number(rendered.duration.toFixed(3)),
    };
  } finally {
    await audioCtx.close().catch(() => undefined);
  }
}
