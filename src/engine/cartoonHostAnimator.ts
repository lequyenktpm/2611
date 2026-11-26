import type { TranscriptCue, WordTiming } from './types';

export type CartoonViseme =
  | 'rest'
  | 'closed'
  | 'smile'
  | 'ah'
  | 'ee'
  | 'oh'
  | 'oo';

export type CartoonGestureMode = 'present' | 'explain' | 'question' | 'cheer';

export interface CartoonLipSyncFrame {
  isSpeaking: boolean;
  activeWord: string;
  activeCueText: string;
  viseme: CartoonViseme;
  /** 0 (closed/smile) .. 1 (wide open D-shape) */
  mouthOpen: number;
  /** Horizontal stretch multiplier (~0.62 narrow O .. 1.24 wide EE/smile) */
  mouthWidth: number;
  /** 0 (flat/D-shape) .. 1 (circular O/OO shape) */
  mouthRound: number;
  /** 0 (open eyes) .. 1 (closed eyelid blink) */
  blinkFactor: number;
  /** Gentle subtle vertical breath/float offset in px (before scale) */
  headBobY: number;
  /** Subtle conversational head tilt in radians */
  headTiltRad: number;
  /** 0..1 eyebrow raise on questions & emphasis */
  browLift: number;
  /** Smoothly interpolated viewer-left arm angles (radians) */
  leftShoulderAngle: number;
  leftElbowAngle: number;
  /** Smoothly interpolated viewer-right arm angles (radians) */
  rightShoulderAngle: number;
  rightElbowAngle: number;
  gestureMode: CartoonGestureMode;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

function smoothstep(t: number): number {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * clamp01(t);
}

interface VisemeMetrics {
  open: number;
  width: number;
  round: number;
}

const VISEME_SHAPES: Record<CartoonViseme, VisemeMetrics> = {
  rest: { open: 0, width: 0.96, round: 0 },
  smile: { open: 0.04, width: 1.08, round: 0 },
  closed: { open: 0.03, width: 0.92, round: 0.05 },
  ah: { open: 0.94, width: 1.06, round: 0.14 },
  ee: { open: 0.46, width: 1.24, round: 0.04 },
  oh: { open: 0.78, width: 0.76, round: 0.88 },
  oo: { open: 0.48, width: 0.62, round: 0.96 },
};

/**
 * Maps a Latin, Japanese (Hiragana/Katakana), Korean Hangul, or punctuation character
 * to an expressive lip-sync viseme.
 */
export function classifyCharToViseme(ch: string): CartoonViseme {
  if (!ch) return 'rest';
  const c = ch.toLowerCase();

  // Bilabial stops/nasals compress lips briefly
  if (c === 'm' || c === 'b' || c === 'p' || c === 'ん' || c === 'ン') {
    return 'closed';
  }
  // Open vowels (a-family & Vietnamese diacritics)
  if ('aàáảãạăằắẳẵặâầấẩẫậäå'.includes(c)) {
    return 'ah';
  }
  // Wide vowels / dentals
  if ('eèéẻẽẹêềếểễệiìíỉĩịyỳýỷỹỵ'.includes(c)) {
    return 'ee';
  }
  // Round mid vowels
  if ('oòóỏõọôồốổỗộơờớởỡợ'.includes(c)) {
    return 'oh';
  }
  // Tight round vowels
  if ('uùúủũụưừứửữựw'.includes(c)) {
    return 'oo';
  }
  // Labiodental / sibilant consonants slightly spread mouth
  if ('fvsztdnlrckgjh'.includes(c)) {
    return 'ee';
  }

  // Japanese Hiragana / Katakana vowel rows
  if (/[あかさたなはまやらわがざだばぱぁアカサタナハマヤラワガザダバパァ]/.test(ch)) {
    return 'ah';
  }
  if (/[いきしちにひみりぎじぢびぴぃイキシチニヒミリギジヂビピィ]/.test(ch)) {
    return 'ee';
  }
  if (/[えけせてねへめれげぜでべぺぇエケセテネヘメレゲゼデベペェ]/.test(ch)) {
    return 'ee';
  }
  if (/[おこそとのほもよろをごぞどぼぽぉオコソトノホモヨロヲゴゾドボポォ]/.test(ch)) {
    return 'oh';
  }
  if (/[うくすつぬふむゆるぐずづぶぷぅウクスツヌフムユルグズヅブプゥ]/.test(ch)) {
    return 'oo';
  }

  // CJK / Hangul syllables: cycle naturally across open conversational shapes
  const code = ch.charCodeAt(0);
  if (code > 0x3000) {
    const seq: CartoonViseme[] = ['ah', 'oh', 'ee', 'oo'];
    return seq[code % seq.length];
  }
  return 'smile';
}

function buildWordVisemeSequence(word: string): CartoonViseme[] {
  const clean = word.replace(/[^\p{L}\p{N}]/gu, '');
  if (!clean) return ['smile'];

  const chars = Array.from(clean);
  const raw = chars.map(classifyCharToViseme);
  // Collapse consecutive identical visemes so mouth transitions feel syllabic rather than fluttery
  const compact: CartoonViseme[] = [];
  for (const v of raw) {
    if (compact.length === 0 || compact[compact.length - 1] !== v) {
      compact.push(v);
    }
  }
  // Ensure at least one vowel-like opening inside real spoken words
  if (compact.length === 1 && compact[0] === 'closed') {
    compact.push('ah');
  }
  return compact.slice(0, 6);
}

function resolveWordTimingAtTime(
  cue: TranscriptCue,
  time: number,
): { word: string; start: number; end: number; cueIndex: number } | null {
  const words: WordTiming[] = Array.isArray(cue.words) ? cue.words : [];
  if (words.length > 0) {
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (time >= w.start && time <= w.end) {
        return { word: w.word, start: w.start, end: w.end, cueIndex: i };
      }
    }
    return null;
  }

  const tokens = cue.text
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) return null;
  const dur = Math.max(0.2, cue.end - cue.start);
  const ratio = clamp01((time - cue.start) / dur);
  const idx = Math.min(tokens.length - 1, Math.floor(ratio * tokens.length));
  const sliceDur = dur / tokens.length;
  return {
    word: tokens[idx],
    start: cue.start + idx * sliceDur,
    end: cue.start + (idx + 1) * sliceDur,
    cueIndex: idx,
  };
}

interface ArmPose {
  leftShoulder: number;
  leftElbow: number;
  rightShoulder: number;
  rightElbow: number;
}

// Reference @Gimmys pose ('present'): viewer-left arm extended gently outward with 4-finger open palm;
// viewer-right arm bent comfortably near waist/hip.
const ARM_POSES: Record<CartoonGestureMode, ArmPose> = {
  present: {
    leftShoulder: 0.42,
    leftElbow: 0.34,
    rightShoulder: -0.26,
    rightElbow: -0.62,
  },
  explain: {
    leftShoulder: 0.56,
    leftElbow: 0.58,
    rightShoulder: -0.52,
    rightElbow: -0.54,
  },
  question: {
    leftShoulder: 0.78,
    leftElbow: 0.88,
    rightShoulder: -0.22,
    rightElbow: -0.52,
  },
  cheer: {
    leftShoulder: 0.68,
    leftElbow: 0.62,
    rightShoulder: -0.68,
    rightElbow: -0.62,
  },
};

function detectGestureForCue(cue: TranscriptCue | undefined, cueIdx: number): CartoonGestureMode {
  if (!cue) return 'present';
  const txt = cue.text.trim();
  if (/[?？]$/.test(txt) || /\b(okay|could|may|can|how|what|why|would|right)\b/i.test(txt)) {
    return cueIdx % 2 === 0 ? 'present' : 'question';
  }
  if (/[!！]$/.test(txt) || /\b(great|awesome|natural|polite|amazing|yes)\b/i.test(txt)) {
    return 'cheer';
  }
  return cueIdx % 2 === 0 ? 'present' : 'explain';
}

/**
 * Computes deterministic, silky-smooth frame-accurate animation state for the
 * @Gimmys-style cartoon mascot at any timestamp `time`.
 * Uses cubic/smoothstep syllable envelopes and damped pose transitions so motion
 * is organic and never jittery.
 */
export function computeSpeechLipSyncState(
  cues: TranscriptCue[],
  time: number,
): CartoonLipSyncFrame {
  const t = Math.max(0, time);

  // Natural blinking every ~3.4s (two crisp 0.16s ease-in-out blinks + slight variance)
  const blinkCycle = 3.45;
  const phase = t % blinkCycle;
  const blinkWindow = 0.16;
  let blinkFactor = 0;
  if (phase >= 2.85 && phase <= 2.85 + blinkWindow) {
    const bp = (phase - 2.85) / blinkWindow;
    blinkFactor = Math.sin(bp * Math.PI);
  }

  // Locate active cue (preferring exact hit; tiny lead-in of 60ms for natural mouth anticipation)
  let activeCueIdx = cues.findIndex((c) => t >= c.start && t <= c.end);
  if (activeCueIdx === -1) {
    activeCueIdx = cues.findIndex((c) => t >= c.start - 0.06 && t <= c.end + 0.06);
  }
  const activeCue = activeCueIdx >= 0 ? cues[activeCueIdx] : undefined;

  // Determine gesture mode & smooth cross-cue pose interpolation
  const prevCueIdx = Math.max(
    0,
    activeCueIdx >= 0
      ? activeCueIdx - 1
      : cues.filter((c) => c.end < t).length - 1,
  );
  const currentGesture = detectGestureForCue(activeCue ?? cues[prevCueIdx], Math.max(0, activeCueIdx));
  const previousGesture = detectGestureForCue(cues[prevCueIdx], prevCueIdx);
  const transitionStart = activeCue ? activeCue.start : 0;
  const gestureBlend = activeCue
    ? smoothstep((t - transitionStart) / 0.42)
    : 1;

  const pA = ARM_POSES[previousGesture];
  const pB = ARM_POSES[currentGesture];
  // Ultra-gentle organic breathing sway on arms (low amplitude, smooth low frequency)
  const swayA = Math.sin(t * 1.45) * 0.045;
  const swayB = Math.cos(t * 1.25) * 0.04;

  const leftShoulderAngle = lerp(pA.leftShoulder, pB.leftShoulder, gestureBlend) + swayA;
  const leftElbowAngle = lerp(pA.leftElbow, pB.leftElbow, gestureBlend) + swayB * 0.8;
  const rightShoulderAngle = lerp(pA.rightShoulder, pB.rightShoulder, gestureBlend) - swayB * 0.7;
  const rightElbowAngle = lerp(pA.rightElbow, pB.rightElbow, gestureBlend) + swayA * 0.6;

  // Determine speech / lip-sync viseme
  let isSpeaking = false;
  let activeWord = '';
  let viseme: CartoonViseme = 'smile';
  let mouthOpen = 0.04;
  let mouthWidth = 1.06;
  let mouthRound = 0;

  if (activeCue && t >= activeCue.start && t <= activeCue.end) {
    const wordHit = resolveWordTimingAtTime(activeCue, t);
    if (wordHit) {
      isSpeaking = true;
      activeWord = wordHit.word;
      const wDur = Math.max(0.08, wordHit.end - wordHit.start);
      const u = clamp01((t - wordHit.start) / wDur);

      const seq = buildWordVisemeSequence(wordHit.word);
      const segPos = u * seq.length;
      const idx0 = Math.min(seq.length - 1, Math.floor(segPos));
      const idx1 = Math.min(seq.length - 1, idx0 + 1);
      const localFrac = segPos - idx0;

      const v0 = seq[idx0];
      const v1 = seq[idx1];
      const s0 = VISEME_SHAPES[v0];
      const s1 = VISEME_SHAPES[v1];

      // Smooth Hermite blend between intra-word phonemes + gentle open/close word envelope
      const interp = smoothstep(localFrac);
      const wordEnvelope = Math.sin(Math.PI * Math.pow(u, 0.85));
      const syllablePulse = 0.72 + 0.28 * Math.sin(Math.PI * localFrac);
      const rawOpen = lerp(s0.open, s1.open, interp);

      viseme = interp < 0.5 ? v0 : v1;
      mouthOpen = clamp01(rawOpen * (0.35 + 0.65 * wordEnvelope) * syllablePulse);
      mouthWidth = lerp(s0.width, s1.width, interp);
      mouthRound = lerp(s0.round, s1.round, interp);
    } else {
      // Short intra-cue pause between words: gentle friendly closed smile
      viseme = 'smile';
      mouthOpen = 0.05;
      mouthWidth = 1.06;
      mouthRound = 0;
    }
  }

  // Soft low-frequency breathing float (never choppy high-frequency jitter)
  const breathY = Math.sin(t * 1.8) * 2.6;
  const speakBounceY = isSpeaking ? Math.sin(t * 6.2) * 1.1 * clamp01(mouthOpen * 1.5) : 0;
  const headBobY = breathY + speakBounceY;

  const isQuestion = Boolean(activeCue && /[?？]/.test(activeCue.text));
  const browLift = isQuestion ? lerp(0.35, 0.85, gestureBlend) : isSpeaking ? 0.25 + mouthOpen * 0.2 : 0.08;
  const headTiltRad =
    Math.sin(t * 0.95) * 0.025 + (isQuestion ? 0.028 * gestureBlend : 0);

  return {
    isSpeaking,
    activeWord,
    activeCueText: activeCue?.text ?? '',
    viseme,
    mouthOpen,
    mouthWidth,
    mouthRound,
    blinkFactor,
    headBobY,
    headTiltRad,
    browLift,
    leftShoulderAngle,
    leftElbowAngle,
    rightShoulderAngle,
    rightElbowAngle,
    gestureMode: currentGesture,
  };
}
