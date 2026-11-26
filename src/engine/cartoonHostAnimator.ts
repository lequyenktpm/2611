import type { ExportAspectRatioId } from './mp4Config';
import type { SceneElement, TranscriptCue, WordTiming } from './types';

export type CartoonViseme =
  | 'rest'
  | 'closed'
  | 'smile'
  | 'ah'
  | 'ee'
  | 'oh'
  | 'oo';

export type CartoonGestureMode =
  | 'present'
  | 'explain'
  | 'question'
  | 'cheer'
  | 'point-up'
  | 'point-right'
  | 'warn-avoid'
  | 'approve-tip';

export type CartoonExpressionMood = 'neutral' | 'happy' | 'worried' | 'curious' | 'surprised';

export interface CartoonHostContext {
  activeBadge?: 'check' | 'cross' | 'question' | 'none';
  activeStamp?: string;
  activeText?: string;
  cueText?: string;
  toneValue?: number;
  targetDirection?: 'up' | 'right' | 'none';
}

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
  /** Gentle horizontal negative/emphasis head shake offset in px (before scale) */
  headShakeX: number;
  /** Subtle conversational head tilt in radians */
  headTiltRad: number;
  /** 0..1 eyebrow raise on questions & emphasis */
  browLift: number;
  /** -1 (worried inner-up / \) .. 0 (level) .. +1 (inquisitive asymmetrical raise) */
  browSlope: number;
  /** -1 (concerned downturn) .. 0 (neutral) .. +1 (warm smile) */
  smileBias: number;
  /** Pupil horizontal gaze target (-1 left .. +1 right toward companion card) */
  eyeTargetX: number;
  /** Pupil vertical gaze target (-1 up toward top card .. +1 down) */
  eyeTargetY: number;
  mood: CartoonExpressionMood;
  /** Optional subtle reaction indicator near gesturing hand */
  pointerGlyph: 'check' | 'cross' | 'question' | 'tip' | null;
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

function clampRange(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
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
 * Cleans accidental technical/duration suffixes like "(Transcript Nhật-Anh 1:42)" from
 * the top cartoon headline and keeps it concise and punchy for on-screen reading.
 */
export function formatCartoonHostHeadline(rawTitle?: string, maxChars = 40): string {
  const raw = (rawTitle || '').trim();
  if (!raw) return '';

  let cleaned = raw
    .replace(/\(\s*(?:transcript|audio|video|demo|preset|sample)\b[^)]*\)/gi, '')
    .replace(/\(\s*\d{1,2}:\d{2}(?::\d{2})?\s*\)/g, '')
    .replace(/\[(?:transcript|audio|video)\b[^\]]*\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s\-–—·:|]+|[\s\-–—·:|]+$/g, '')
    .trim();

  if (!cleaned) cleaned = raw;
  if (cleaned.length <= maxChars) return cleaned;

  const slice = cleaned.slice(0, maxChars - 1).trim();
  const lastSpace = slice.lastIndexOf(' ');
  const cut = lastSpace >= Math.floor(maxChars * 0.52) ? slice.slice(0, lastSpace).trim() : slice;
  return `${cut.replace(/[,;:·-]+$/, '')}…`;
}

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
  const compact: CartoonViseme[] = [];
  for (const v of raw) {
    if (compact.length === 0 || compact[compact.length - 1] !== v) {
      compact.push(v);
    }
  }
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
  'point-up': {
    leftShoulder: 0.25,
    leftElbow: 0.42,
    rightShoulder: -1.45,
    rightElbow: -0.95,
  },
  'point-right': {
    leftShoulder: 0.28,
    leftElbow: 0.46,
    rightShoulder: 1.05,
    rightElbow: 0.22,
  },
  'warn-avoid': {
    leftShoulder: 0.85,
    leftElbow: 0.65,
    rightShoulder: -0.95,
    rightElbow: -0.78,
  },
  'approve-tip': {
    leftShoulder: 0.48,
    leftElbow: 0.44,
    rightShoulder: -1.18,
    rightElbow: -0.76,
  },
};

const NEGATIVE_CONTEXT_REGEX =
  /\b(avoid|rude|wrong|mistake|don't say|do not say|stop saying|never say|too blunt|too direct|textbook|boring|bad|incorrect|no!)\b|ぶっきらぼう|失礼|ダメ|間違い|使わない|tránh|sai|đừng nói|thô lỗ|cọc lốc|lỗi/i;

const NEGATIVE_NG_TOKEN_REGEX = /(?:^|[\s「『(【])NG(?:$|[\s」』)】:：!])/u;

const QUESTION_CONTEXT_REGEX =
  /[?？]|\b(quiz|question|guess|which|choose|think|wonder|blank|fill in)\b|どっち|どれ|なんで|どう|質問|クイズ|chọn|đố|nghĩ thử|cách nào/i;

const POSITIVE_CONTEXT_REGEX =
  /\b(natural|polite|better|instead|great|correct|awesome|smart|formal|upgrade|native|use this|right way|polite!)\b|丁寧|自然|おすすめ|正解|ネイティブ|良い|使うべき|nên dùng|tự nhiên|chuẩn|lịch sự|chính xác|đúng|hay hơn/i;

const TIP_CONTEXT_REGEX =
  /\b(tip|key|important|note|remember|focus|secret|rule)\b|ポイント|コツ|覚え|重要|mẹo|lưu ý|bí quyết|quy tắc/i;

function classifyMoodAndGesture(
  cue: TranscriptCue | undefined,
  cueIdx: number,
  context?: CartoonHostContext,
): {
  mood: CartoonExpressionMood;
  gestureMode: CartoonGestureMode;
  pointerGlyph: CartoonLipSyncFrame['pointerGlyph'];
} {
  const txt = cue?.text?.trim() ?? '';
  const combined = [txt, context?.cueText, context?.activeStamp, context?.activeText]
    .filter(Boolean)
    .join(' ');
  const dir = context?.targetDirection ?? 'none';

  const isExplicitNegative = context?.activeBadge === 'cross';
  const isExplicitPositive = context?.activeBadge === 'check';
  const isExplicitQuestion = context?.activeBadge === 'question';
  const hasExplicitBadge = isExplicitNegative || isExplicitPositive || isExplicitQuestion;

  const isNegative =
    isExplicitNegative ||
    (!hasExplicitBadge &&
      ((typeof context?.toneValue === 'number' && context.toneValue < 0.34) ||
        NEGATIVE_CONTEXT_REGEX.test(combined) ||
        NEGATIVE_NG_TOKEN_REGEX.test(combined)));

  if (isNegative) {
    return {
      mood: 'worried',
      gestureMode: 'warn-avoid',
      pointerGlyph: 'cross',
    };
  }

  const isQuestion =
    isExplicitQuestion ||
    (!hasExplicitBadge && QUESTION_CONTEXT_REGEX.test(combined));

  if (isQuestion) {
    return {
      mood: 'curious',
      gestureMode: dir === 'right' ? 'point-right' : dir === 'up' ? 'point-up' : 'question',
      pointerGlyph: 'question',
    };
  }

  const isPositive =
    isExplicitPositive ||
    (typeof context?.toneValue === 'number' && context.toneValue >= 0.62) ||
    POSITIVE_CONTEXT_REGEX.test(combined);

  if (isPositive) {
    return {
      mood: 'happy',
      gestureMode:
        dir === 'right'
          ? 'point-right'
          : dir === 'up'
            ? cueIdx % 2 === 0
              ? 'point-up'
              : 'approve-tip'
            : 'cheer',
      pointerGlyph: 'check',
    };
  }

  const isTip = TIP_CONTEXT_REGEX.test(combined);
  if (dir === 'right') {
    return {
      mood: isTip ? 'happy' : 'neutral',
      gestureMode: cueIdx % 2 === 0 ? 'point-right' : 'explain',
      pointerGlyph: isTip ? 'tip' : null,
    };
  }
  if (dir === 'up') {
    return {
      mood: isTip ? 'happy' : 'neutral',
      gestureMode: cueIdx % 2 === 0 ? 'point-up' : 'explain',
      pointerGlyph: isTip ? 'tip' : null,
    };
  }

  return {
    mood: isTip ? 'happy' : 'neutral',
    gestureMode: cueIdx % 2 === 0 ? 'present' : 'explain',
    pointerGlyph: isTip ? 'tip' : null,
  };
}

/**
 * Inspects active scene elements at `time` so Gimmy reacts directly to whatever
 * teaching card, comparison, or tone meter is currently on screen.
 */
export function computeCartoonHostContextFromElements(
  elements: SceneElement[],
  time: number,
  cues: TranscriptCue[] = [],
  aspectRatio: ExportAspectRatioId = '9:16',
): CartoonHostContext {
  const active = elements.filter(
    (el) =>
      time >= el.startTime - 0.02 &&
      time <= el.endTime + 0.02 &&
      !(el.props.kind === 'illustration-prop' && el.props.variant === 'cartoon-host'),
  );

  const activeCard = active.find((el) => el.type === 'sentence-card');
  const activePill = active.find((el) => el.type === 'topic-pill');
  const activeMeter = active.find((el) => el.type === 'tone-meter');
  const activeIll = active.find((el) => el.type === 'illustration-prop');
  const activeCue = cues.find((c) => time >= c.start && time <= c.end);

  const textParts: string[] = [];
  let activeBadge: CartoonHostContext['activeBadge'];
  let activeStamp: string | undefined;
  let toneValue: number | undefined;

  if (activeCard && activeCard.props.kind === 'sentence-card') {
    activeBadge = activeCard.props.badge;
    activeStamp = activeCard.props.stampText;
    textParts.push(activeCard.props.text, activeCard.props.subtext || '');
  }
  if (activePill && activePill.props.kind === 'topic-pill') {
    textParts.push(activePill.props.text);
  }
  if (activeIll && activeIll.props.kind === 'illustration-prop' && activeIll.props.data) {
    const d = activeIll.props.data;
    textParts.push(d.title || '', d.subtitle || '', d.reactionText || '', d.speechText || '');
    if (d.labels?.length) textParts.push(d.labels.join(' '));
  }
  if (activeMeter && activeMeter.props.kind === 'tone-meter') {
    const p = activeMeter.props;
    const span = Math.max(0.05, (p.animateEnd ?? activeMeter.endTime) - (p.animateStart ?? activeMeter.startTime));
    const ratio = clamp01((time - (p.animateStart ?? activeMeter.startTime)) / span);
    toneValue = lerp(p.valueStart, p.valueEnd, ratio);
  }

  const hasCompanionVisual = Boolean(activeCard || activePill || activeMeter || activeIll);
  const targetDirection: CartoonHostContext['targetDirection'] = !hasCompanionVisual
    ? 'none'
    : aspectRatio === '16:9' || aspectRatio === '1:1'
      ? 'right'
      : 'up';

  return {
    activeBadge,
    activeStamp,
    activeText: textParts.filter(Boolean).join(' ').trim() || undefined,
    cueText: activeCue?.text,
    toneValue,
    targetDirection,
  };
}

/**
 * Computes deterministic, silky-smooth frame-accurate animation state for the
 * @Gimmys-style cartoon mascot at any timestamp `time`.
 * Context-aware: adapts facial expressions, brow slant, eye gaze direction, and
 * pointing/warning gestures to match right/wrong/question/tip cards.
 */
export function computeSpeechLipSyncState(
  cues: TranscriptCue[],
  time: number,
  context?: CartoonHostContext,
): CartoonLipSyncFrame {
  const t = Math.max(0, time);

  // Natural blinking every ~3.45s
  const blinkCycle = 3.45;
  const phase = t % blinkCycle;
  const blinkWindow = 0.16;
  let blinkFactor = 0;
  if (phase >= 2.85 && phase <= 2.85 + blinkWindow) {
    const bp = (phase - 2.85) / blinkWindow;
    blinkFactor = Math.sin(bp * Math.PI);
  }

  // Locate active cue (tiny lead-in of 60ms for natural anticipation)
  let activeCueIdx = cues.findIndex((c) => t >= c.start && t <= c.end);
  if (activeCueIdx === -1) {
    activeCueIdx = cues.findIndex((c) => t >= c.start - 0.06 && t <= c.end + 0.06);
  }
  const activeCue = activeCueIdx >= 0 ? cues[activeCueIdx] : undefined;

  const prevCueIdx = Math.max(
    0,
    activeCueIdx >= 0
      ? activeCueIdx - 1
      : cues.filter((c) => c.end < t).length - 1,
  );
  const currentState = classifyMoodAndGesture(
    activeCue ?? cues[prevCueIdx],
    Math.max(0, activeCueIdx),
    context,
  );
  const prevState = classifyMoodAndGesture(
    cues[prevCueIdx],
    prevCueIdx,
    activeCueIdx > 0 ? undefined : context,
  );

  const transitionStart = activeCue ? activeCue.start : 0;
  const gestureBlend = activeCue ? smoothstep((t - transitionStart) / 0.36) : 1;

  const pA = ARM_POSES[prevState.gestureMode];
  const pB = ARM_POSES[currentState.gestureMode];
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

      const interp = smoothstep(localFrac);
      const wordEnvelope = Math.sin(Math.PI * Math.pow(u, 0.85));
      const syllablePulse = 0.72 + 0.28 * Math.sin(Math.PI * localFrac);
      const rawOpen = lerp(s0.open, s1.open, interp);

      viseme = interp < 0.5 ? v0 : v1;
      mouthOpen = clamp01(rawOpen * (0.35 + 0.65 * wordEnvelope) * syllablePulse);
      mouthWidth = lerp(s0.width, s1.width, interp);
      mouthRound = lerp(s0.round, s1.round, interp);
    } else {
      viseme = currentState.mood === 'worried' ? 'closed' : 'smile';
      mouthOpen = 0.04;
      mouthWidth = currentState.mood === 'worried' ? 0.92 : 1.06;
      mouthRound = 0;
    }
  }

  const mood = currentState.mood;
  const breathY = Math.sin(t * 1.8) * 2.4;
  const speakBounceY = isSpeaking ? Math.sin(t * 6.2) * 1.15 * clamp01(mouthOpen * 1.5) : 0;
  const headBobY = breathY + speakBounceY;

  const headShakeX =
    mood === 'worried'
      ? Math.sin(t * 5.2) * 3.2 * (isSpeaking ? 1 : 0.45)
      : 0;

  const targetDir = context?.targetDirection ?? 'none';
  const eyeTargetX = clampRange(
    targetDir === 'right'
      ? 0.68
      : mood === 'curious'
        ? 0.25
        : Math.sin(t * 0.7) * 0.14,
    -1,
    1,
  );
  const eyeTargetY = clampRange(
    targetDir === 'up'
      ? -0.62
      : mood === 'worried'
        ? -0.15
        : 0,
    -1,
    1,
  );

  const browSlope =
    mood === 'worried'
      ? -0.88
      : mood === 'curious'
        ? 0.72
        : mood === 'happy'
          ? 0.38
          : 0.08;

  const smileBias =
    mood === 'worried'
      ? -0.78
      : mood === 'happy'
        ? 0.9
        : mood === 'curious'
          ? 0.05
          : 0.35;

  const browLift =
    mood === 'curious'
      ? lerp(0.4, 0.85, gestureBlend)
      : mood === 'worried'
        ? 0.32
        : isSpeaking
          ? 0.24 + mouthOpen * 0.22
          : 0.08;

  const headTiltRad =
    Math.sin(t * 0.95) * 0.022 +
    (mood === 'curious' ? 0.055 * gestureBlend : 0) +
    (mood === 'worried' ? -0.04 * gestureBlend : 0) +
    (targetDir === 'right' && mood === 'happy' ? 0.03 * gestureBlend : 0);

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
    headShakeX,
    headTiltRad,
    browLift,
    browSlope,
    smileBias,
    eyeTargetX,
    eyeTargetY,
    mood,
    pointerGlyph: currentState.pointerGlyph,
    leftShoulderAngle,
    leftElbowAngle,
    rightShoulderAngle,
    rightElbowAngle,
    gestureMode: currentState.gestureMode,
  };
}
