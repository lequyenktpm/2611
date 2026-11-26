import {
  computeElementFrameState,
  computeStaggerItemState,
  easeInOutCubic,
  easeOutCubic,
  easeOutQuint,
  clamp01,
} from './animationMath';
import { getCustomComponentByVariant } from './customComponentStore';
import { VectorPrimitive } from './customComponentTypes';
import { drawPresetBackground, getBackgroundPresetMeta } from './backgroundPresets';
import { computeSpeechLipSyncState, type CartoonLipSyncFrame } from './cartoonHostAnimator';
import type { ExportAspectRatioId } from './mp4Config';
import {
  BackgroundFitMode,
  CANVAS_THEMES,
  ComparisonStripProps,
  DynamicSceneSpec,
  ElementLayout,
  IllustrationPropProps,
  IllustrationSceneIcon,
  KaraokeCardProps,
  LayoutCompositionId,
  LessonProject,
  SceneElement,
  SentenceCardProps,
  Shape3DProps,
  SubtitleDisplayConfig,
  ThemePalette,
  ToneMeterProps,
  TopicPillProps,
  TranscriptCue,
  WordStackProps,
} from './types';

export const STAGE_WIDTH = 1080;
export const STAGE_HEIGHT = 1920;

export function getStageDimensionsForAspect(
  aspectRatio: ExportAspectRatioId = '9:16',
): { width: number; height: number } {
  switch (aspectRatio) {
    case '16:9':
      return { width: 1920, height: 1080 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '4:5':
      return { width: 1080, height: 1350 };
    case '9:16':
    default:
      return { width: STAGE_WIDTH, height: STAGE_HEIGHT };
  }
}

function resolveKaraokeTargetY(
  pos: 'top' | 'center' | 'bottom',
  aspectRatio: ExportAspectRatioId,
  stageH: number,
): number {
  if (pos === 'top') {
    return aspectRatio === '16:9' ? 175 : Math.round(stageH * 0.18);
  }
  if (pos === 'center') {
    return Math.round(stageH * 0.5);
  }
  return aspectRatio === '16:9' ? 948 : aspectRatio === '1:1' ? 920 : aspectRatio === '4:5' ? 1160 : 1585;
}

export function resolveElementLayoutForAspect(
  elements: SceneElement[],
  time: number,
  aspectRatio: ExportAspectRatioId = '9:16',
  subtitleConfig?: SubtitleDisplayConfig,
  compositionId?: LayoutCompositionId,
): Map<string, ElementLayout> {
  const out = new Map<string, ElementLayout>();
  const explicitPos = subtitleConfig?.position ?? (compositionId === 'plain' ? 'center' : undefined);
  const stage = getStageDimensionsForAspect(aspectRatio);

  if (aspectRatio === '9:16') {
    for (const el of elements) {
      if (el.type === 'karaoke-card' && explicitPos && !el.layout.manualPosition) {
        out.set(el.id, {
          ...el.layout,
          x: stage.width / 2,
          y: resolveKaraokeTargetY(explicitPos, aspectRatio, stage.height),
          width: compositionId === 'plain' ? 960 : el.layout.width,
        });
      } else {
        out.set(el.id, el.layout);
      }
    }
    return out;
  }

  if (aspectRatio === '1:1' || aspectRatio === '4:5') {
    const yScale = stage.height / STAGE_HEIGHT;
    const xOffset = (stage.width - STAGE_WIDTH) / 2;
    for (const el of elements) {
      if (el.layout.manualPosition) {
        out.set(el.id, el.layout);
        continue;
      }
      if (el.type === 'karaoke-card' && explicitPos) {
        out.set(el.id, {
          ...el.layout,
          x: stage.width / 2,
          y: resolveKaraokeTargetY(explicitPos, aspectRatio, stage.height),
          width: Math.min(stage.width - 64, Math.max(880, el.layout.width)),
          scale: 1,
        });
        continue;
      }
      const scaledHeight = el.layout.height ? Math.round(el.layout.height * Math.max(0.75, yScale)) : undefined;
      out.set(el.id, {
        ...el.layout,
        x: Math.round(el.layout.x + xOffset),
        y: Math.round(70 + ((el.layout.y - 120) / Math.max(1, STAGE_HEIGHT - 240)) * (stage.height - 150)),
        width: Math.min(stage.width - 48, el.layout.width),
        height: scaledHeight,
        scale: Number((el.layout.scale * Math.max(0.8, Math.sqrt(yScale))).toFixed(3)),
      });
    }
    return out;
  }

  // 16:9 Widescreen (1920 x 1080) adaptive layout
  const visible = elements.filter((el) => time >= el.startTime - 0.01 && time <= el.endTime + 0.01);
  const topStrip = visible.filter(
    (el) => el.type === 'comparison-strip' && el.layout.y < 900 && !el.id.includes('-quiz-opts-'),
  );
  const hasTopStrip = topStrip.length > 0;

  const isTopPill = (el: SceneElement): boolean =>
    (el.type === 'topic-pill' && el.layout.y < 520) ||
    (el.type === 'shape-3d' &&
      el.props.kind === 'shape-3d' &&
      el.props.shapeType === 'pill_3d' &&
      el.layout.y < 420);

  const isQuizOptStrip = (el: SceneElement): boolean =>
    el.type === 'comparison-strip' && (el.id.includes('-quiz-opts-') || el.layout.y >= 900);

  const isCountdownMeter = (el: SceneElement): boolean =>
    el.id.includes('-q-countdown-meter-');

  const isRightFocal = (el: SceneElement): boolean =>
    el.type === 'sentence-card' || el.type === 'tone-meter';

  const isLeftVisual = (el: SceneElement): boolean =>
    (el.type === 'illustration-prop' && !isCountdownMeter(el)) || el.type === 'word-stack';

  const midVisuals = visible.filter(isLeftVisual);
  const midCards = visible.filter(isRightFocal);
  const mid3dBlocks = visible.filter((el) => el.type === 'shape-3d' && !isTopPill(el));
  const midQuizOpts = visible.filter(isQuizOptStrip);
  const midMeters = visible.filter(isCountdownMeter);

  const hasSplitColumns =
    (midVisuals.length > 0 && (midCards.length > 0 || midQuizOpts.length > 0 || midMeters.length > 0)) ||
    mid3dBlocks.length >= 2;

  const hasTopSubCollision = explicitPos === 'top';

  for (const el of elements) {
    if (el.layout.manualPosition) {
      out.set(el.id, el.layout);
      continue;
    }
    if (el.type === 'comparison-strip' && !isQuizOptStrip(el)) {
      out.set(el.id, {
        ...el.layout,
        x: 960,
        y: hasTopSubCollision ? 58 : 72,
        width: 1460,
        scale: hasTopSubCollision ? 0.78 : 0.92,
      });
      continue;
    }

    if (isTopPill(el)) {
      out.set(el.id, {
        ...el.layout,
        x: 960,
        y: hasTopSubCollision ? 295 : hasTopStrip ? 162 : 96,
        width: Math.min(1180, Math.max(660, el.layout.width)),
        height: el.layout.height ? Math.min(96, el.layout.height) : undefined,
        scale: 0.94,
      });
      continue;
    }

    if (el.type === 'karaoke-card') {
      const targetY = explicitPos
        ? resolveKaraokeTargetY(explicitPos, '16:9', stage.height)
        : 948;
      out.set(el.id, {
        ...el.layout,
        x: 960,
        y: targetY,
        width: Math.min(1680, Math.max(1380, Math.round(el.layout.width * 1.65))),
        scale: explicitPos === 'center' ? 1 : 0.94,
      });
      continue;
    }

    if (isQuizOptStrip(el)) {
      const hasMeter = midMeters.length > 0;
      const baseQuizY = hasSplitColumns
        ? hasMeter
          ? 575
          : 630
        : hasMeter
          ? 590
          : 645;
      out.set(el.id, {
        ...el.layout,
        x: hasSplitColumns ? 1405 : 960,
        y: hasTopSubCollision ? Math.max(baseQuizY, 640) : baseQuizY,
        width: hasSplitColumns ? 820 : 1280,
        scale: hasSplitColumns ? 0.80 : 0.86,
      });
      continue;
    }

    if (isCountdownMeter(el)) {
      out.set(el.id, {
        ...el.layout,
        x: hasSplitColumns ? 1405 : 960,
        y: midQuizOpts.length > 0 ? 835 : 715,
        width: 780,
        scale: midQuizOpts.length > 0 ? 0.62 : 0.68,
      });
      continue;
    }

    if (isLeftVisual(el)) {
      if (hasSplitColumns) {
        const vIdx = Math.max(0, midVisuals.findIndex((v) => v.id === el.id));
        const baseLeftY = midVisuals.length > 1 ? 375 + vIdx * 260 : 515;
        out.set(el.id, {
          ...el.layout,
          x: 515,
          y: hasTopSubCollision ? Math.max(baseLeftY, 555) : baseLeftY,
          width: 820,
          scale: Math.min(0.95, el.layout.scale || 1),
        });
      } else {
        const isCartoonHost =
          el.props.kind === 'illustration-prop' && el.props.variant === 'cartoon-host';
        out.set(el.id, {
          ...el.layout,
          x: 960,
          y: hasTopSubCollision ? 560 : isCartoonHost ? 485 : 515,
          width: Math.min(1260, Math.round(el.layout.width * 1.2)),
          scale: isCartoonHost ? 0.8 : Math.min(1.02, el.layout.scale || 1),
        });
      }
      continue;
    }

    if (isRightFocal(el)) {
      if (hasSplitColumns) {
        const hasQuiz = midQuizOpts.length > 0;
        const hasRightLower = hasQuiz || midMeters.length > 0;
        const isToneWithSentence =
          el.type === 'tone-meter' && visible.some((v) => v.type === 'sentence-card');
        let yPos = hasTopSubCollision ? 555 : 515;
        if (el.type === 'sentence-card' && hasQuiz) {
          yPos = hasTopSubCollision ? 345 : 295;
        } else if (el.type === 'sentence-card' && hasRightLower) {
          yPos = hasTopSubCollision ? 430 : 395;
        } else if (el.type === 'sentence-card' && visible.some((v) => v.type === 'tone-meter')) {
          yPos = hasTopSubCollision ? 445 : 410;
        } else if (isToneWithSentence) {
          yPos = 665;
        }
        out.set(el.id, {
          ...el.layout,
          x: 1405,
          y: yPos,
          width: 820,
          scale: hasQuiz ? 0.84 : hasRightLower ? 0.92 : 0.97,
        });
      } else {
        const cIdx = Math.max(0, midCards.findIndex((c) => c.id === el.id));
        const hasCenterLower = midMeters.length > 0 || midQuizOpts.length > 0;
        const baseY =
          midCards.length > 1
            ? 410 + cIdx * 240
            : hasCenterLower && el.type === 'sentence-card'
              ? 355
              : 515;
        out.set(el.id, {
          ...el.layout,
          x: 960,
          y: hasTopSubCollision ? Math.max(baseY, 445) : baseY,
          width: Math.min(1260, Math.round(el.layout.width * 1.25)),
          scale: hasCenterLower ? 0.92 : 1,
        });
      }
      continue;
    }

    if (el.type === 'shape-3d') {
      const sIdx = Math.max(0, mid3dBlocks.findIndex((b) => b.id === el.id));
      if (mid3dBlocks.length >= 2) {
        const isLeft = sIdx % 2 === 0;
        out.set(el.id, {
          ...el.layout,
          x: isLeft ? 515 : 1405,
          y: 515,
          width: 800,
          height: el.layout.height ? Math.min(340, el.layout.height) : undefined,
          scale: 0.96,
        });
      } else {
        out.set(el.id, {
          ...el.layout,
          x: 960,
          y: 515,
          width: Math.min(1220, Math.round(el.layout.width * 1.2)),
          scale: 1,
        });
      }
      continue;
    }

    // Fallback generic mapping
    out.set(el.id, {
      ...el.layout,
      x: Math.round((el.layout.x / STAGE_WIDTH) * stage.width),
      y: Math.round((el.layout.y / STAGE_HEIGHT) * stage.height),
      width: Math.min(stage.width - 64, el.layout.width),
    });
  }

  return out;
}

const FONT_DISPLAY = '"Outfit", "Plus Jakarta Sans", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif';
const FONT_SANS = '"Plus Jakarta Sans", "Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif';

function drawRoundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
  ctx.lineTo(x + radius, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function fillCardWithShadow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  fill: string,
  shadowAlpha = 0.08,
) {
  ctx.save();
  ctx.shadowColor = `rgba(15, 23, 42, ${shadowAlpha})`;
  ctx.shadowBlur = 32;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 12;
  ctx.fillStyle = fill;
  drawRoundedRectPath(ctx, x, y, w, h, r);
  ctx.fill();
  ctx.restore();
}

function hexToRgba(hex: string, alpha: number): string {
  const clean = hex.trim();
  if (clean.startsWith('rgb') || clean.startsWith('hsl')) return clean;
  const raw = clean.replace('#', '');
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (full.length !== 6) return `rgba(37, 99, 235, ${alpha})`;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) {
    return `rgba(37, 99, 235, ${alpha})`;
  }
  return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha)})`;
}

function drawCharacterAvatar(
  ctx: CanvasRenderingContext2D,
  opts: {
    x: number;
    y: number;
    shirtColor: string;
    hairColor: string;
    skinColor?: string;
    hairStyle?: 'short' | 'bob' | 'side';
    expression?: 'smile' | 'happy' | 'curious';
    nameTag?: string;
    tagColor?: string;
    scale?: number;
    lipSync?: CartoonLipSyncFrame;
  },
) {
  const {
    x,
    y,
    shirtColor,
    hairColor,
    skinColor = '#FDE2C8',
    hairStyle = 'short',
    expression = 'smile',
    nameTag,
    tagColor = shirtColor,
    scale = 1,
    lipSync,
  } = opts;

  ctx.save();
  ctx.translate(x, y + (lipSync ? lipSync.headBobY * 0.45 : 0));
  if (scale !== 1) ctx.scale(scale, scale);

  // Back hair for bob/long styles
  if (hairStyle === 'bob') {
    ctx.fillStyle = hairColor;
    drawRoundedRectPath(ctx, -46, -42, 92, 86, 36);
    ctx.fill();
  }

  // Shoulders & shirt
  ctx.fillStyle = shirtColor;
  drawRoundedRectPath(ctx, -48, 34, 96, 62, 30);
  ctx.fill();

  // Shirt collar
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.moveTo(-18, 34);
  ctx.lineTo(0, 50);
  ctx.lineTo(18, 34);
  ctx.closePath();
  ctx.fill();

  // Neck + subtle chin shadow
  ctx.fillStyle = skinColor;
  drawRoundedRectPath(ctx, -13, 18, 26, 24, 10);
  ctx.fill();
  ctx.fillStyle = 'rgba(180, 83, 9, 0.14)';
  ctx.beginPath();
  ctx.ellipse(0, 26, 13, 6, 0, 0, Math.PI * 2);
  ctx.fill();

  // Head
  ctx.fillStyle = skinColor;
  ctx.beginPath();
  ctx.arc(0, -14, 41, 0, Math.PI * 2);
  ctx.fill();

  // Soft cheek blush
  ctx.fillStyle = 'rgba(244, 114, 182, 0.25)';
  ctx.beginPath();
  ctx.ellipse(-22, -4, 8, 5, 0, 0, Math.PI * 2);
  ctx.ellipse(22, -4, 8, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Top hair & fringe
  ctx.fillStyle = hairColor;
  ctx.beginPath();
  ctx.arc(0, -24, 42, Math.PI * 0.96, Math.PI * 2.04);
  ctx.fill();
  if (hairStyle === 'side') {
    ctx.beginPath();
    ctx.moveTo(-40, -28);
    ctx.quadraticCurveTo(-8, -12, 34, -36);
    ctx.quadraticCurveTo(10, -56, -40, -28);
    ctx.fill();
  } else if (hairStyle === 'bob') {
    ctx.beginPath();
    ctx.ellipse(-18, -36, 22, 13, -0.3, 0, Math.PI * 2);
    ctx.ellipse(18, -36, 22, 13, 0.3, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.beginPath();
    ctx.ellipse(0, -44, 34, 15, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Eyebrows
  const browRaise = lipSync ? lipSync.browLift * 2.5 : 0;
  ctx.strokeStyle = hairColor;
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-21, -24 - browRaise);
  ctx.quadraticCurveTo(-14, -27 - browRaise, -7, -24 - browRaise);
  ctx.moveTo(7, -24 - browRaise);
  ctx.quadraticCurveTo(14, -27 - browRaise, 21, -24 - browRaise);
  ctx.stroke();

  // Eyes + white specular glints (smooth blink support)
  const eyeScaleY = lipSync ? Math.max(0.1, 1 - lipSync.blinkFactor) : 1;
  if (eyeScaleY < 0.25) {
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = 3.2;
    ctx.beginPath();
    ctx.arc(-14, -12, 5.2, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(14, -12, 5.2, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.stroke();
  } else {
    ctx.fillStyle = '#0F172A';
    ctx.beginPath();
    ctx.ellipse(-14, -12, 4.8, 4.8 * eyeScaleY, 0, 0, Math.PI * 2);
    ctx.ellipse(14, -12, 4.8, 4.8 * eyeScaleY, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(-15.5, -13.5, 1.7, 0, Math.PI * 2);
    ctx.arc(12.5, -13.5, 1.7, 0, Math.PI * 2);
    ctx.fill();
  }

  // Mouth expression (smooth lip-sync when lipSync state is active)
  if (lipSync && lipSync.isSpeaking && lipSync.mouthOpen > 0.08) {
    const mw = 11.5 * lipSync.mouthWidth;
    const mh = 3.5 + lipSync.mouthOpen * 11;
    ctx.fillStyle = '#9F1239';
    ctx.beginPath();
    if (lipSync.mouthRound > 0.55) {
      ctx.ellipse(0, 3, mw * 0.72, mh * 0.85, 0, 0, Math.PI * 2);
    } else {
      ctx.moveTo(-mw, -1);
      ctx.quadraticCurveTo(0, 1, mw, -1);
      ctx.bezierCurveTo(mw * 0.9, mh + 2, -mw * 0.9, mh + 2, -mw, -1);
    }
    ctx.fill();
    if (lipSync.mouthOpen > 0.45 && lipSync.mouthRound < 0.5) {
      ctx.fillStyle = '#FB7185';
      ctx.beginPath();
      ctx.ellipse(0, mh * 0.62, mw * 0.48, Math.max(2, mh * 0.25), 0, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (expression === 'happy') {
    ctx.fillStyle = '#E11D48';
    ctx.beginPath();
    ctx.arc(0, -1, 13, 0.08 * Math.PI, 0.92 * Math.PI);
    ctx.closePath();
    ctx.fill();
  } else if (expression === 'curious') {
    ctx.fillStyle = '#9F1239';
    ctx.beginPath();
    ctx.ellipse(0, 4, 5.5, 6.5, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 3.8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, -3, 12, 0.16 * Math.PI, 0.84 * Math.PI);
    ctx.stroke();
  }

  // Optional crisp name badge pill below shoulders
  if (nameTag) {
    ctx.font = `700 20px ${FONT_SANS}`;
    const pillW = Math.min(156, Math.max(82, ctx.measureText(nameTag).width + 28));
    fillCardWithShadow(ctx, -pillW / 2, 76, pillW, 34, 17, tagColor, 0.12);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(nameTag, 0, 93, pillW - 16);
  }

  ctx.restore();
}

/**
 * Draws a silky-smooth, speech-synced @Gimmys-style 2D cartoon mascot:
 * - Warm shaded round tan head with thick ink outlines
 * - Blinking oval eyes & expressive eyebrows
 * - Continuous viseme-interpolated D-shape / oval lip-sync mouth
 * - Crisp white tunic torso + articulated Bezier stick arms with 4-finger cartoon hands
 * - Planted stick legs with gentle conversational breathing
 */
function drawCartoonHostCharacter(
  ctx: CanvasRenderingContext2D,
  time: number,
  cues: TranscriptCue[] = [],
) {
  const lip = computeSpeechLipSyncState(cues, time);
  const ink = '#0F172A';

  ctx.save();

  // Helper to draw a fanned 4-finger cartoon hand at wrist (wx, wy) pointing along angle
  const drawCartoonHand = (wx: number, wy: number, baseAngle: number, spreadFlip = 1) => {
    const fingerOffsets = [-0.46, -0.14, 0.18, 0.52];
    const fingerLens = [26, 33, 31, 24];
    ctx.save();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 5.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    fingerOffsets.forEach((off, idx) => {
      const a = baseAngle + off * spreadFlip;
      const len = fingerLens[idx];
      const fx = wx + Math.cos(a) * len;
      const fy = wy + Math.sin(a) * len;
      const cx = wx + Math.cos(a - 0.08 * spreadFlip) * (len * 0.52);
      const cy = wy + Math.sin(a - 0.08 * spreadFlip) * (len * 0.52);
      ctx.beginPath();
      ctx.moveTo(wx, wy);
      ctx.quadraticCurveTo(cx, cy, fx, fy);
      ctx.stroke();
    });
    ctx.restore();
  };

  // Helper to draw smooth articulated Bezier arm from shoulder to elbow to wrist
  const drawArticulatedArm = (
    sx: number,
    sy: number,
    upperAngle: number,
    elbowDelta: number,
    dir: -1 | 1,
    drawHandOnEnd: boolean,
  ) => {
    const upperLen = 104;
    const foreLen = 98;
    const a1 = dir === -1 ? Math.PI * 0.62 + upperAngle * 0.55 : Math.PI * 0.38 - upperAngle * 0.55;
    const ex = sx + Math.cos(a1) * upperLen;
    const ey = sy + Math.sin(a1) * upperLen;
    const a2 = a1 + (dir === -1 ? 0.34 + elbowDelta * 0.45 : -0.34 - elbowDelta * 0.45);
    const wx = ex + Math.cos(a2) * foreLen;
    const wy = ey + Math.sin(a2) * foreLen;

    ctx.save();
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6.8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.quadraticCurveTo(ex + dir * 4, ey, wx, wy);
    ctx.stroke();
    ctx.restore();

    if (drawHandOnEnd) {
      drawCartoonHand(wx, wy, a2, dir);
    }
  };

  // 1. Stick Legs (planted at bottom so feet never float/jump awkwardly)
  ctx.save();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-40, 194);
  ctx.quadraticCurveTo(-46, 266, -42, 336);
  ctx.moveTo(40, 194);
  ctx.quadraticCurveTo(46, 266, 42, 336);
  ctx.stroke();
  // Minimalist feet tips
  ctx.beginPath();
  ctx.moveTo(-42, 336);
  ctx.lineTo(-56, 338);
  ctx.moveTo(42, 336);
  ctx.lineTo(56, 338);
  ctx.stroke();
  ctx.restore();

  // 2. Gentle breathing torso & arms container
  ctx.save();
  ctx.translate(0, lip.headBobY);

  // Left arm (viewer-left, signature @Gimmys expressive open-palm arm reaching out)
  drawArticulatedArm(-72, 16, lip.leftShoulderAngle, lip.leftElbowAngle, -1, true);

  // Soft drop shadow beneath tunic bottom
  ctx.fillStyle = 'rgba(15, 23, 42, 0.08)';
  ctx.beginPath();
  ctx.ellipse(0, 206, 98, 12, 0, 0, Math.PI * 2);
  ctx.fill();

  // White bell/dome tunic body with crisp cool shading on right edge + thick black outline
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(-66, -24);
  ctx.bezierCurveTo(-104, 34, -112, 140, -104, 186);
  ctx.quadraticCurveTo(0, 212, 104, 186);
  ctx.bezierCurveTo(112, 140, 104, 34, 66, -24);
  ctx.closePath();

  const tunicGrad = ctx.createLinearGradient(-105, -20, 105, 195);
  tunicGrad.addColorStop(0, '#FFFFFF');
  tunicGrad.addColorStop(0.66, '#F8FAFC');
  tunicGrad.addColorStop(1, '#DCE6F2');
  ctx.fillStyle = tunicGrad;
  ctx.fill();

  ctx.strokeStyle = ink;
  ctx.lineWidth = 8.5;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();

  // Viewer-right arm (curves neatly inward along the side of the tunic like @Gimmys)
  ctx.save();
  const rSway = Math.sin(time * 1.45) * 6;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 6.8;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(86, 46);
  ctx.quadraticCurveTo(112, 124 + rSway * 0.4, 70, 198 + rSway * 0.3);
  ctx.stroke();
  if (lip.gestureMode === 'cheer' || lip.gestureMode === 'explain') {
    drawArticulatedArm(72, 16, lip.rightShoulderAngle, lip.rightElbowAngle, 1, true);
  }
  ctx.restore();

  // 3. Round Tan Head rotating smoothly around neck pivot
  ctx.save();
  ctx.translate(0, -34);
  ctx.rotate(lip.headTiltRad);
  ctx.translate(0, -124);

  const headR = 132;
  ctx.save();
  ctx.beginPath();
  ctx.arc(0, 0, headR, 0, Math.PI * 2);
  const skinGrad = ctx.createRadialGradient(-44, -56, 18, 12, 18, headR * 1.15);
  skinGrad.addColorStop(0, '#ECC094');
  skinGrad.addColorStop(0.58, '#DDA46F');
  skinGrad.addColorStop(1, '#C5844E');
  ctx.fillStyle = skinGrad;
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 8.8;
  ctx.stroke();
  ctx.restore();

  // Expressive eyebrows
  const browY = -48 - lip.browLift * 10;
  ctx.strokeStyle = ink;
  ctx.lineWidth = 5.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-64, browY + 4);
  ctx.quadraticCurveTo(-45, browY - 7, -26, browY + 3);
  ctx.moveTo(26, browY + 3);
  ctx.quadraticCurveTo(45, browY - 7, 64, browY + 4);
  ctx.stroke();

  // Crisp oval dark eyes with smooth natural blinking
  const eyeScaleY = Math.max(0.08, 1 - lip.blinkFactor);
  if (eyeScaleY < 0.24) {
    ctx.strokeStyle = ink;
    ctx.lineWidth = 5.5;
    ctx.beginPath();
    ctx.arc(-44, -18, 14, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(44, -18, 14, 0.1 * Math.PI, 0.9 * Math.PI);
    ctx.stroke();
  } else {
    ctx.fillStyle = ink;
    ctx.beginPath();
    ctx.ellipse(-44, -18, 11.5, 14.5 * eyeScaleY, 0, 0, Math.PI * 2);
    ctx.ellipse(44, -18, 11.5, 14.5 * eyeScaleY, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Smooth syllable/viseme lip-synced mouth
  const mouthY = 36;
  const openAmt = lip.mouthOpen;
  if (openAmt <= 0.09) {
    // Gentle resting smile or pressed bilabial m/b/p
    ctx.strokeStyle = ink;
    ctx.lineWidth = 6.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (lip.viseme === 'closed') {
      ctx.moveTo(-26, mouthY + 4);
      ctx.quadraticCurveTo(0, mouthY + 7, 26, mouthY + 4);
    } else {
      ctx.arc(0, mouthY - 8, 28, 0.16 * Math.PI, 0.84 * Math.PI);
    }
    ctx.stroke();
  } else {
    const mw = 40 * lip.mouthWidth;
    const mh = 12 + openAmt * 38;
    ctx.save();
    ctx.beginPath();
    if (lip.mouthRound > 0.55) {
      // Smooth rounded 'oh' / 'oo' aperture
      const rx = mw * (0.72 - 0.14 * lip.mouthRound);
      const ry = Math.max(10, mh * 0.62);
      ctx.ellipse(0, mouthY + ry * 0.45, rx, ry, 0, 0, Math.PI * 2);
    } else {
      // Signature @Gimmys D-shaped open mouth: smooth arched upper lip & deep rounded lower curve
      ctx.moveTo(-mw, mouthY);
      ctx.quadraticCurveTo(0, mouthY + 5, mw, mouthY);
      ctx.bezierCurveTo(
        mw * 0.96,
        mouthY + mh * 1.18,
        -mw * 0.96,
        mouthY + mh * 1.18,
        -mw,
        mouthY,
      );
      ctx.closePath();
    }
    ctx.fillStyle = ink;
    ctx.fill();

    // Subtle warm tongue gleam inside wide openings
    if (openAmt > 0.42 && lip.mouthRound < 0.58) {
      ctx.clip();
      ctx.fillStyle = '#E11D48';
      ctx.beginPath();
      ctx.ellipse(0, mouthY + mh * 0.88, mw * 0.56, mh * 0.36, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  ctx.restore(); // end head
  ctx.restore(); // end torso/bob
  ctx.restore();
}

const bgImageCache = new Map<string, HTMLImageElement>();
const bgImageLoading = new Map<string, Promise<HTMLImageElement | null>>();
const bgVideoCache = new Map<string, HTMLVideoElement>();
const bgVideoLoading = new Map<string, Promise<HTMLVideoElement | null>>();

export function computeBackgroundImageDrawRect(
  imgW: number,
  imgH: number,
  stageW = STAGE_WIDTH,
  stageH = STAGE_HEIGHT,
  fit: BackgroundFitMode = 'cover',
): { dx: number; dy: number; dw: number; dh: number } {
  const safeImgW = Math.max(1, imgW);
  const safeImgH = Math.max(1, imgH);
  const scale =
    fit === 'contain'
      ? Math.min(stageW / safeImgW, stageH / safeImgH)
      : Math.max(stageW / safeImgW, stageH / safeImgH);
  const dw = Math.round(safeImgW * scale);
  const dh = Math.round(safeImgH * scale);
  const dx = Math.round((stageW - dw) / 2);
  const dy = Math.round((stageH - dh) / 2);
  return { dx, dy, dw, dh };
}

const bgLoadListeners = new Set<() => void>();

export function subscribeBgImageLoaded(listener: () => void): () => void {
  bgLoadListeners.add(listener);
  return () => {
    bgLoadListeners.delete(listener);
  };
}

function notifyBgImageLoaded() {
  bgLoadListeners.forEach((fn) => {
    try {
      fn();
    } catch {
      // ignore listener errors
    }
  });
}

export async function ensureBgVideoLoaded(videoUrl: string): Promise<HTMLVideoElement | null> {
  if (!videoUrl || typeof document === 'undefined') return null;
  const cached = bgVideoCache.get(videoUrl);
  if (cached && cached.readyState >= 2) return cached;

  const pending = bgVideoLoading.get(videoUrl);
  if (pending) return pending;

  const p = new Promise<HTMLVideoElement | null>((resolve) => {
    const vid = document.createElement('video');
    vid.muted = true;
    vid.loop = true;
    vid.playsInline = true;
    vid.preload = 'auto';
    vid.crossOrigin = 'anonymous';
    const done = (ok: boolean) => {
      vid.removeEventListener('loadeddata', onReady);
      vid.removeEventListener('canplay', onReady);
      vid.removeEventListener('error', onErr);
      bgVideoLoading.delete(videoUrl);
      if (ok && vid.videoWidth > 0) {
        bgVideoCache.set(videoUrl, vid);
        notifyBgImageLoaded();
        resolve(vid);
      } else {
        resolve(null);
      }
    };
    const onReady = () => done(true);
    const onErr = () => done(false);
    vid.addEventListener('loadeddata', onReady);
    vid.addEventListener('canplay', onReady);
    vid.addEventListener('error', onErr);
    vid.src = videoUrl;
    vid.load();
  });
  bgVideoLoading.set(videoUrl, p);
  return p;
}

export function getCachedBgVideo(videoUrl: string): HTMLVideoElement | null {
  if (!videoUrl) return null;
  const cached = bgVideoCache.get(videoUrl);
  if (cached && cached.readyState >= 2) return cached;
  if (!bgVideoLoading.has(videoUrl)) {
    void ensureBgVideoLoaded(videoUrl);
  }
  return cached && cached.readyState >= 2 ? cached : null;
}

export async function seekBackgroundVideoTo(videoUrl: string | undefined, timeSec: number): Promise<void> {
  if (!videoUrl) return;
  const vid = (await ensureBgVideoLoaded(videoUrl)) || getCachedBgVideo(videoUrl);
  if (!vid || !Number.isFinite(vid.duration) || vid.duration <= 0.05) return;
  const wrapped = ((Math.max(0, timeSec) % vid.duration) + vid.duration) % vid.duration;
  if (Math.abs(vid.currentTime - wrapped) < 0.025 && vid.readyState >= 2) return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      vid.removeEventListener('seeked', finish);
      resolve();
    };
    vid.addEventListener('seeked', finish, { once: true });
    try {
      vid.currentTime = wrapped;
    } catch {
      finish();
    }
    setTimeout(finish, 180);
  });
}

export async function seekProjectVideoAssets(project: LessonProject, timeSec: number): Promise<void> {
  const bg = project.backgroundImage;
  if (!bg || bg.kind !== 'video' || !bg.videoUrl) return;
  await seekBackgroundVideoTo(bg.videoUrl, timeSec);
}

export function drawLoadedImageCover(
  ctx: CanvasRenderingContext2D,
  media: HTMLImageElement | HTMLVideoElement,
  mediaW: number,
  mediaH: number,
  stageW: number,
  stageH: number,
  fit: BackgroundFitMode = 'cover',
  zoom = 1,
) {
  const rect = computeBackgroundImageDrawRect(mediaW || stageW, mediaH || stageH, stageW, stageH, fit);
  if (zoom > 1.001) {
    const cx = rect.dx + rect.dw / 2;
    const cy = rect.dy + rect.dh / 2;
    const zw = rect.dw * zoom;
    const zh = rect.dh * zoom;
    ctx.drawImage(media, cx - zw / 2, cy - zh / 2, zw, zh);
    return;
  }
  ctx.drawImage(media, rect.dx, rect.dy, rect.dw, rect.dh);
}

export async function ensureProjectAssetsLoaded(project: LessonProject): Promise<void> {
  const bg = project.backgroundImage;
  if (bg?.kind === 'video' && bg.videoUrl) {
    await ensureBgVideoLoaded(bg.videoUrl);
    return;
  }
  const presetAssetUrl =
    (bg?.kind === 'preset' || (!bg?.kind && !bg?.dataUrl && !bg?.videoUrl)) && bg?.presetId
      ? getBackgroundPresetMeta(bg.presetId)?.assetUrl
      : undefined;
  const dataUrl = bg?.dataUrl || presetAssetUrl;
  if (!dataUrl || typeof Image === 'undefined') return;
  const cached = bgImageCache.get(dataUrl);
  if (cached && cached.complete && cached.naturalWidth > 0) return;

  const pending = bgImageLoading.get(dataUrl);
  if (pending) {
    await pending;
    return;
  }

  const p = new Promise<HTMLImageElement | null>((resolve) => {
    const img = new Image();
    img.onload = () => {
      bgImageCache.set(dataUrl, img);
      bgImageLoading.delete(dataUrl);
      notifyBgImageLoaded();
      resolve(img);
    };
    img.onerror = () => {
      bgImageLoading.delete(dataUrl);
      resolve(null);
    };
    img.src = dataUrl;
  });
  bgImageLoading.set(dataUrl, p);
  await p;
}

export function getCachedBgImage(dataUrl: string): HTMLImageElement | null {
  const cached = bgImageCache.get(dataUrl);
  if (cached && cached.complete && cached.naturalWidth > 0) return cached;
  if (!bgImageLoading.has(dataUrl) && typeof Image !== 'undefined') {
    const img = new Image();
    const p = new Promise<HTMLImageElement | null>((resolve) => {
      img.onload = () => {
        bgImageCache.set(dataUrl, img);
        bgImageLoading.delete(dataUrl);
        notifyBgImageLoaded();
        resolve(img);
      };
      img.onerror = () => {
        bgImageLoading.delete(dataUrl);
        resolve(null);
      };
    });
    bgImageLoading.set(dataUrl, p);
    img.src = dataUrl;
    if (img.complete && img.naturalWidth > 0) {
      bgImageCache.set(dataUrl, img);
      bgImageLoading.delete(dataUrl);
      return img;
    }
  }
  return null;
}

function drawVectorPrimitives(
  ctx: CanvasRenderingContext2D,
  primitives: VectorPrimitive[],
  time: number,
  extraCustomDraw?: (icon: IllustrationSceneIcon) => void,
) {
  let inferredCardWidth = 0;
  for (const p of primitives) {
    if ((p.shape === 'rect' || p.shape === 'pill') && typeof p.w === 'number' && p.w > inferredCardWidth) {
      inferredCardWidth = p.w;
    }
  }

  for (const prim of primitives) {
    ctx.save();
    if (typeof prim.opacity === 'number') {
      ctx.globalAlpha *= clamp01(prim.opacity);
    }
    const px = prim.x ?? 0;
    const py = prim.y ?? 0;

    if (prim.shape === 'rect' || prim.shape === 'pill') {
      const w = prim.w ?? 200;
      const h = prim.h ?? 110;
      const r = prim.shape === 'pill' ? h / 2 : (prim.radius ?? 22);
      if (prim.shadow && prim.fill) {
        fillCardWithShadow(ctx, px, py, w, h, r, prim.fill, 0.09);
      }
      drawRoundedRectPath(ctx, px, py, w, h, r);
      if (prim.fill && !prim.shadow) {
        ctx.fillStyle = prim.fill;
        ctx.fill();
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.lineWidth ?? 3;
        ctx.stroke();
      }
    } else if (prim.shape === 'circle') {
      const r = prim.r ?? 44;
      ctx.beginPath();
      ctx.arc(px, py, r, 0, Math.PI * 2);
      if (prim.fill) {
        ctx.fillStyle = prim.fill;
        ctx.fill();
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.lineWidth ?? 4;
        ctx.stroke();
      }
    } else if (prim.shape === 'ellipse') {
      const rx = prim.rx ?? 64;
      const ry = prim.ry ?? 40;
      ctx.beginPath();
      ctx.ellipse(px, py, rx, ry, 0, 0, Math.PI * 2);
      if (prim.fill) {
        ctx.fillStyle = prim.fill;
        ctx.fill();
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.lineWidth ?? 4;
        ctx.stroke();
      }
    } else if (prim.shape === 'arc') {
      const r = prim.r ?? 48;
      ctx.strokeStyle = prim.stroke || prim.fill || '#2563EB';
      ctx.lineWidth = prim.lineWidth ?? 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(px, py, r, prim.startAngle ?? 0, prim.endAngle ?? Math.PI);
      ctx.stroke();
    } else if (prim.shape === 'polygon' && Array.isArray(prim.points) && prim.points.length >= 2) {
      ctx.beginPath();
      ctx.moveTo(prim.points[0][0], prim.points[0][1]);
      for (let i = 1; i < prim.points.length; i++) {
        ctx.lineTo(prim.points[i][0], prim.points[i][1]);
      }
      ctx.closePath();
      if (prim.fill) {
        ctx.fillStyle = prim.fill;
        ctx.fill();
      }
      if (prim.stroke) {
        ctx.strokeStyle = prim.stroke;
        ctx.lineWidth = prim.lineWidth ?? 3;
        ctx.stroke();
      }
    } else if (prim.shape === 'line' || prim.shape === 'arrow') {
      const x2 = prim.x2 ?? px + 80;
      const y2 = prim.y2 ?? py;
      const col = prim.stroke || prim.fill || '#1E293B';
      ctx.strokeStyle = col;
      ctx.fillStyle = col;
      ctx.lineWidth = prim.lineWidth ?? 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      if (prim.shape === 'arrow') {
        const ang = Math.atan2(y2 - py, x2 - px);
        const head = Math.max(12, (prim.lineWidth ?? 6) * 2.4);
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 - head * Math.cos(ang - 0.52), y2 - head * Math.sin(ang - 0.52));
        ctx.lineTo(x2 - head * Math.cos(ang + 0.52), y2 - head * Math.sin(ang + 0.52));
        ctx.closePath();
        ctx.fill();
      }
    } else if (prim.shape === 'text') {
      const maxSize = Math.max(16, prim.fontSize ?? 32);
      const weight = prim.fontWeight ?? 700;
      const fallbackW = inferredCardWidth > 0 ? Math.max(80, inferredCardWidth - 40) : 380;
      const maxW = Math.max(48, prim.w ?? fallbackW);
      const maxH = prim.h ? Math.max(28, prim.h) : 220;
      const fitted = fitWrappedTextBlock(ctx, prim.text || '', maxW, maxH, {
        fontWeight: weight,
        fontFamily: FONT_DISPLAY,
        maxFontSize: maxSize,
        minFontSize: 15,
        lineHeightRatio: 1.22,
        maxLines: 3,
      });
      ctx.font = `${weight} ${fitted.fontSize}px ${FONT_DISPLAY}`;
      ctx.fillStyle = prim.fill || '#0F172A';
      ctx.textAlign = prim.align ?? 'center';
      ctx.textBaseline = 'middle';
      const startY = py - ((fitted.lines.length - 1) * fitted.lineHeight) / 2;
      fitted.lines.forEach((ln, li) => {
        ctx.fillText(ln, px, startY + li * fitted.lineHeight, maxW);
      });
    } else if (prim.shape === 'icon' && extraCustomDraw) {
      const bounce = Math.sin(time * 2.5) * 3;
      ctx.translate(px, py + bounce);
      ctx.scale(0.85, 0.85);
      extraCustomDraw((prim.icon || 'sparkles') as IllustrationSceneIcon);
    }

    ctx.restore();
  }
}

function drawSceneIcon(ctx: CanvasRenderingContext2D, kind: IllustrationSceneIcon) {
  ctx.save();
  if (kind === 'tv') {
    fillCardWithShadow(ctx, -92, -62, 184, 124, 28, '#0F172A', 0.14);
    const screenGrad = ctx.createLinearGradient(-72, -44, 72, 34);
    screenGrad.addColorStop(0, '#60A5FA');
    screenGrad.addColorStop(1, '#38BDF8');
    ctx.fillStyle = screenGrad;
    drawRoundedRectPath(ctx, -74, -44, 148, 80, 16);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(-74, -44);
    ctx.lineTo(18, -44);
    ctx.lineTo(-32, 36);
    ctx.lineTo(-74, 36);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(-12, -22);
    ctx.lineTo(28, -2);
    ctx.lineTo(-12, 18);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#94A3B8';
    ctx.lineWidth = 9;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-30, 72);
    ctx.lineTo(30, 72);
    ctx.stroke();
  } else if (kind === 'glasses') {
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Left lens
    ctx.fillStyle = '#E0F2FE';
    drawRoundedRectPath(ctx, -68, -22, 54, 42, 16);
    ctx.fill();
    ctx.stroke();
    // Right lens
    drawRoundedRectPath(ctx, 14, -22, 54, 42, 16);
    ctx.fill();
    ctx.stroke();
    // Nose bridge & temple arms
    ctx.beginPath();
    ctx.arc(0, -4, 15, Math.PI * 1.1, Math.PI * 1.9);
    ctx.moveTo(-68, -6);
    ctx.lineTo(-78, -14);
    ctx.moveTo(68, -6);
    ctx.lineTo(78, -14);
    ctx.stroke();
    // Specular sheen
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(-54, -12);
    ctx.lineTo(-42, 6);
    ctx.moveTo(28, -12);
    ctx.lineTo(40, 6);
    ctx.stroke();
  } else if (kind === 'eye') {
    ctx.fillStyle = '#EFF6FF';
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(-74, 0);
    ctx.quadraticCurveTo(0, -54, 74, 0);
    ctx.quadraticCurveTo(0, 54, -74, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#2563EB';
    ctx.beginPath();
    ctx.arc(0, 0, 24, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#0F172A';
    ctx.beginPath();
    ctx.arc(0, 0, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(-6, -6, 4.5, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'watch') {
    ctx.fillStyle = '#334155';
    drawRoundedRectPath(ctx, -20, -64, 40, 128, 12);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(0, 0, 40, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = '#0F172A';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -20);
    ctx.moveTo(0, 0);
    ctx.lineTo(16, 8);
    ctx.stroke();
  } else if (kind === 'listen') {
    ctx.fillStyle = '#FDE68A';
    ctx.beginPath();
    ctx.ellipse(-8, 0, 36, 48, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(18, 0, 38, -0.7, 0.7);
    ctx.stroke();
  } else if (kind === 'walk') {
    ctx.fillStyle = '#FDBA74';
    ctx.beginPath();
    ctx.arc(0, -36, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#EA580C';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, -10);
    ctx.lineTo(0, 28);
    ctx.moveTo(0, 4);
    ctx.lineTo(-28, 22);
    ctx.moveTo(0, 4);
    ctx.lineTo(26, 18);
    ctx.moveTo(0, 28);
    ctx.lineTo(-18, 58);
    ctx.moveTo(0, 28);
    ctx.lineTo(22, 58);
    ctx.stroke();
  } else if (kind === 'airplane') {
    ctx.fillStyle = '#DBEAFE';
    ctx.beginPath();
    ctx.arc(0, 0, 62, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#2563EB';
    ctx.beginPath();
    ctx.moveTo(0, -44);
    ctx.lineTo(12, -10);
    ctx.lineTo(48, 6);
    ctx.lineTo(48, 18);
    ctx.lineTo(12, 8);
    ctx.lineTo(8, 34);
    ctx.lineTo(22, 46);
    ctx.lineTo(-22, 46);
    ctx.lineTo(-8, 34);
    ctx.lineTo(-12, 8);
    ctx.lineTo(-48, 18);
    ctx.lineTo(-48, 6);
    ctx.lineTo(-12, -10);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'luggage') {
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(-18, -36);
    ctx.lineTo(-18, -56);
    ctx.lineTo(18, -56);
    ctx.lineTo(18, -36);
    ctx.stroke();
    fillCardWithShadow(ctx, -42, -36, 84, 88, 18, '#F59E0B', 0.12);
    ctx.fillStyle = '#FEF3C7';
    drawRoundedRectPath(ctx, -26, -16, 52, 16, 8);
    ctx.fill();
    ctx.fillStyle = '#1E293B';
    ctx.beginPath();
    ctx.arc(-26, 56, 7, 0, Math.PI * 2);
    ctx.arc(26, 56, 7, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'menu') {
    fillCardWithShadow(ctx, -50, -56, 100, 112, 16, '#FFF7ED', 0.12);
    ctx.fillStyle = '#EA580C';
    drawRoundedRectPath(ctx, -50, -56, 100, 26, 12);
    ctx.fill();
    ctx.fillStyle = '#FDBA74';
    drawRoundedRectPath(ctx, -32, -14, 64, 10, 5);
    ctx.fill();
    drawRoundedRectPath(ctx, -32, 6, 48, 10, 5);
    ctx.fill();
    drawRoundedRectPath(ctx, -32, 26, 56, 10, 5);
    ctx.fill();
  } else if (kind === 'cup') {
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 4;
    ctx.lineCap = 'round';
    [-12, 8].forEach((sx) => {
      ctx.beginPath();
      ctx.moveTo(sx, -34);
      ctx.quadraticCurveTo(sx - 6, -46, sx + 2, -56);
      ctx.stroke();
    });
    fillCardWithShadow(ctx, -46, -24, 92, 74, 22, '#FFFFFF', 0.12);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 3;
    drawRoundedRectPath(ctx, -46, -24, 92, 74, 22);
    ctx.stroke();
    ctx.fillStyle = '#38BDF8';
    drawRoundedRectPath(ctx, -36, -12, 72, 52, 15);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    drawRoundedRectPath(ctx, -28, -4, 14, 34, 7);
    ctx.fill();
    ctx.strokeStyle = '#94A3B8';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(46, 12, 16, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  } else if (kind === 'shopping-bag') {
    ctx.strokeStyle = '#BE185D';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.arc(0, -34, 20, Math.PI, 0);
    ctx.stroke();
    fillCardWithShadow(ctx, -44, -30, 88, 86, 16, '#EC4899', 0.12);
    ctx.fillStyle = '#FCE7F3';
    ctx.beginPath();
    ctx.arc(-16, -12, 5, 0, Math.PI * 2);
    ctx.arc(16, -12, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'price-tag') {
    ctx.save();
    ctx.rotate(-0.2);
    fillCardWithShadow(ctx, -52, -32, 104, 64, 16, '#10B981', 0.12);
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(-32, 0, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `800 30px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('$%', 12, 2);
    ctx.restore();
  } else if (kind === 'stethoscope') {
    ctx.fillStyle = '#FEE2E2';
    ctx.beginPath();
    ctx.arc(0, 0, 58, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#EF4444';
    drawRoundedRectPath(ctx, -12, -34, 24, 68, 8);
    ctx.fill();
    drawRoundedRectPath(ctx, -34, -12, 68, 24, 8);
    ctx.fill();
  } else if (kind === 'sun') {
    ctx.fillStyle = '#FACC15';
    ctx.beginPath();
    ctx.arc(0, 0, 34, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#F59E0B';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (let r = 0; r < 8; r++) {
      const a = (r * Math.PI) / 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 44, Math.sin(a) * 44);
      ctx.lineTo(Math.cos(a) * 58, Math.sin(a) * 58);
      ctx.stroke();
    }
  } else if (kind === 'rain' || kind === 'umbrella') {
    ctx.fillStyle = '#93C5FD';
    ctx.beginPath();
    ctx.arc(-18, -14, 26, 0, Math.PI * 2);
    ctx.arc(16, -18, 30, 0, Math.PI * 2);
    ctx.arc(38, -6, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 6;
    ctx.lineCap = 'round';
    [-22, 0, 22].forEach((dx) => {
      ctx.beginPath();
      ctx.moveTo(dx, 22);
      ctx.lineTo(dx - 8, 46);
      ctx.stroke();
    });
  } else if (kind === 'snowflake') {
    ctx.strokeStyle = '#38BDF8';
    ctx.lineWidth = 7;
    ctx.lineCap = 'round';
    for (let r = 0; r < 3; r++) {
      const a = (r * Math.PI) / 3;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * -48, Math.sin(a) * -48);
      ctx.lineTo(Math.cos(a) * 48, Math.sin(a) * 48);
      ctx.stroke();
    }
  } else if (kind === 'book') {
    fillCardWithShadow(ctx, -56, -42, 54, 84, 10, '#FFFFFF', 0.1);
    fillCardWithShadow(ctx, 2, -42, 54, 84, 10, '#F8FAFC', 0.1);
    ctx.strokeStyle = '#4F46E5';
    ctx.lineWidth = 6;
    drawRoundedRectPath(ctx, -56, -42, 112, 84, 12);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -42);
    ctx.lineTo(0, 42);
    ctx.stroke();
  } else if (kind === 'pencil') {
    ctx.save();
    ctx.rotate(-0.6);
    fillCardWithShadow(ctx, -16, -48, 32, 88, 6, '#FACC15', 0.1);
    ctx.fillStyle = '#FCA5A5';
    drawRoundedRectPath(ctx, -16, -54, 32, 18, 6);
    ctx.fill();
    ctx.fillStyle = '#1E293B';
    ctx.beginPath();
    ctx.moveTo(-16, 40);
    ctx.lineTo(16, 40);
    ctx.lineTo(0, 62);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (kind === 'graduation') {
    ctx.fillStyle = '#312E81';
    ctx.beginPath();
    ctx.moveTo(0, -42);
    ctx.lineTo(62, -12);
    ctx.lineTo(0, 18);
    ctx.lineTo(-62, -12);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#4338CA';
    drawRoundedRectPath(ctx, -32, 8, 64, 30, 10);
    ctx.fill();
    ctx.strokeStyle = '#FACC15';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(46, -10);
    ctx.lineTo(46, 30);
    ctx.stroke();
  } else if (kind === 'laptop') {
    fillCardWithShadow(ctx, -58, -42, 116, 74, 12, '#1E293B', 0.12);
    ctx.fillStyle = '#60A5FA';
    drawRoundedRectPath(ctx, -46, -32, 92, 54, 8);
    ctx.fill();
    ctx.fillStyle = '#94A3B8';
    drawRoundedRectPath(ctx, -74, 34, 148, 14, 7);
    ctx.fill();
  } else if (kind === 'calendar') {
    fillCardWithShadow(ctx, -50, -46, 100, 96, 18, '#FFFFFF', 0.1);
    ctx.fillStyle = '#4F46E5';
    drawRoundedRectPath(ctx, -50, -46, 100, 30, 14);
    ctx.fill();
    ctx.fillStyle = '#0F172A';
    ctx.font = `800 32px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('15', 0, 18);
  } else if (kind === 'briefcase') {
    ctx.strokeStyle = '#78350F';
    ctx.lineWidth = 7;
    drawRoundedRectPath(ctx, -20, -52, 40, 20, 8);
    ctx.stroke();
    fillCardWithShadow(ctx, -54, -34, 108, 82, 18, '#92400E', 0.12);
    ctx.fillStyle = '#FACC15';
    drawRoundedRectPath(ctx, -14, -4, 28, 16, 6);
    ctx.fill();
  } else if (kind === 'clock') {
    fillCardWithShadow(ctx, -54, -54, 108, 108, 54, '#FFFFFF', 0.12);
    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, 0, 48, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = '#0F172A';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, -26);
    ctx.moveTo(0, 0);
    ctx.lineTo(22, 10);
    ctx.stroke();
  } else if (kind === 'car' || kind === 'bus') {
    fillCardWithShadow(ctx, -60, -26, 120, 56, 16, kind === 'bus' ? '#F59E0B' : '#3B82F6', 0.12);
    ctx.fillStyle = '#DBEAFE';
    drawRoundedRectPath(ctx, -42, -16, 84, 24, 8);
    ctx.fill();
    ctx.fillStyle = '#0F172A';
    ctx.beginPath();
    ctx.arc(-34, 34, 12, 0, Math.PI * 2);
    ctx.arc(34, 34, 12, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'home') {
    ctx.fillStyle = '#F97316';
    ctx.beginPath();
    ctx.moveTo(0, -54);
    ctx.lineTo(62, -6);
    ctx.lineTo(-62, -6);
    ctx.closePath();
    ctx.fill();
    fillCardWithShadow(ctx, -46, -8, 92, 60, 12, '#FFFBEB', 0.1);
    ctx.fillStyle = '#B45309';
    drawRoundedRectPath(ctx, -14, 12, 28, 40, 8);
    ctx.fill();
  } else if (kind === 'dumbbell') {
    ctx.fillStyle = '#475569';
    drawRoundedRectPath(ctx, -48, -6, 96, 12, 6);
    ctx.fill();
    ctx.fillStyle = '#2563EB';
    drawRoundedRectPath(ctx, -56, -28, 18, 56, 8);
    ctx.fill();
    drawRoundedRectPath(ctx, 38, -28, 18, 56, 8);
    ctx.fill();
  } else if (kind === 'music' || kind === 'mic') {
    ctx.fillStyle = '#7C3AED';
    drawRoundedRectPath(ctx, -16, -46, 32, 54, 16);
    ctx.fill();
    ctx.strokeStyle = '#7C3AED';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.arc(0, -8, 28, 0, Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, 20);
    ctx.lineTo(0, 44);
    ctx.moveTo(-20, 44);
    ctx.lineTo(20, 44);
    ctx.stroke();
  } else if (kind === 'camera') {
    fillCardWithShadow(ctx, -54, -34, 108, 72, 18, '#1E293B', 0.12);
    ctx.fillStyle = '#38BDF8';
    ctx.beginPath();
    ctx.arc(0, 2, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(-8, -6, 6, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'heart') {
    ctx.fillStyle = '#EC4899';
    ctx.beginPath();
    ctx.arc(-20, -14, 22, 0, Math.PI * 2);
    ctx.arc(20, -14, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(-40, -6);
    ctx.lineTo(40, -6);
    ctx.lineTo(0, 42);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'sparkles') {
    ctx.fillStyle = '#FACC15';
    const drawStar4 = (sx: number, sy: number, r: number) => {
      ctx.beginPath();
      ctx.moveTo(sx, sy - r);
      ctx.quadraticCurveTo(sx, sy, sx + r, sy);
      ctx.quadraticCurveTo(sx, sy, sx, sy + r);
      ctx.quadraticCurveTo(sx, sy, sx - r, sy);
      ctx.quadraticCurveTo(sx, sy, sx, sy - r);
      ctx.fill();
    };
    drawStar4(-6, -4, 42);
    ctx.fillStyle = '#38BDF8';
    drawStar4(34, -30, 20);
    ctx.fillStyle = '#A855F7';
    drawStar4(32, 28, 16);
  } else if (kind === 'brain') {
    ctx.fillStyle = '#F472B6';
    ctx.beginPath();
    ctx.arc(-18, -6, 28, 0, Math.PI * 2);
    ctx.arc(18, -6, 28, 0, Math.PI * 2);
    ctx.arc(0, -24, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#9D174D';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(0, -38);
    ctx.lineTo(0, 24);
    ctx.stroke();
  } else if (kind === 'lightning') {
    ctx.fillStyle = '#FACC15';
    ctx.beginPath();
    ctx.moveTo(8, -54);
    ctx.lineTo(-28, 4);
    ctx.lineTo(2, 4);
    ctx.lineTo(-10, 54);
    ctx.lineTo(30, -6);
    ctx.lineTo(-2, -6);
    ctx.closePath();
    ctx.fill();
  } else if (kind === 'scale') {
    ctx.strokeStyle = '#475569';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(0, -40);
    ctx.lineTo(0, 42);
    ctx.moveTo(-48, -22);
    ctx.lineTo(48, -22);
    ctx.moveTo(-26, 42);
    ctx.lineTo(26, 42);
    ctx.stroke();
    ctx.fillStyle = '#3B82F6';
    ctx.beginPath();
    ctx.arc(-48, 12, 18, 0, Math.PI);
    ctx.fill();
    ctx.fillStyle = '#10B981';
    ctx.beginPath();
    ctx.arc(48, 12, 18, 0, Math.PI);
    ctx.fill();
  } else if (kind === 'gift') {
    fillCardWithShadow(ctx, -46, -26, 92, 74, 14, '#EF4444', 0.12);
    ctx.fillStyle = '#FACC15';
    ctx.fillRect(-8, -26, 16, 74);
    ctx.fillRect(-46, 2, 92, 14);
  } else if (kind === 'wallet') {
    fillCardWithShadow(ctx, -52, -34, 104, 72, 18, '#0F766E', 0.12);
    ctx.fillStyle = '#14B8A6';
    drawRoundedRectPath(ctx, 10, -10, 46, 26, 10);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(26, 3, 5, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'map-pin') {
    ctx.fillStyle = '#EF4444';
    ctx.beginPath();
    ctx.arc(0, -16, 34, Math.PI, 0);
    ctx.lineTo(0, 48);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(0, -14, 14, 0, Math.PI * 2);
    ctx.fill();
  } else if (kind === 'globe') {
    ctx.fillStyle = '#38BDF8';
    ctx.beginPath();
    ctx.arc(0, 0, 48, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.ellipse(0, 0, 22, 48, 0, 0, Math.PI * 2);
    ctx.moveTo(-48, 0);
    ctx.lineTo(48, 0);
    ctx.stroke();
  } else if (kind === 'handshake' || kind === 'chat') {
    fillCardWithShadow(ctx, -54, -36, 108, 68, 22, '#4F46E5', 0.12);
    ctx.fillStyle = '#FFFFFF';
    [-22, 0, 22].forEach((dx) => {
      ctx.beginPath();
      ctx.arc(dx, -2, 6, 0, Math.PI * 2);
      ctx.fill();
    });
  } else {
    // Crisp smartphone fallback
    fillCardWithShadow(ctx, -40, -70, 80, 140, 18, '#0F172A', 0.1);
    ctx.fillStyle = '#38BDF8';
    drawRoundedRectPath(ctx, -28, -54, 56, 100, 12);
    ctx.fill();
  }
  ctx.restore();
}

function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const safeMaxW = Math.max(24, maxWidth);
  const paragraphs = text.split(/\r?\n/);
  const lines: string[] = [];

  const pushWrappedWord = (word: string) => {
    if (ctx.measureText(word).width <= safeMaxW) {
      lines.push(word);
      return;
    }
    let chunk = '';
    for (const ch of word) {
      const next = chunk + ch;
      if (ctx.measureText(next).width <= safeMaxW || chunk.length === 0) {
        chunk = next;
      } else {
        lines.push(chunk);
        chunk = ch;
      }
    }
    if (chunk) lines.push(chunk);
  };

  for (const para of paragraphs) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    let current = '';
    for (const word of words) {
      if (!current) {
        if (ctx.measureText(word).width <= safeMaxW) {
          current = word;
        } else {
          pushWrappedWord(word);
          current = lines.pop() ?? '';
        }
        continue;
      }
      const candidate = `${current} ${word}`;
      if (ctx.measureText(candidate).width <= safeMaxW) {
        current = candidate;
      } else {
        lines.push(current);
        if (ctx.measureText(word).width <= safeMaxW) {
          current = word;
        } else {
          pushWrappedWord(word);
          current = lines.pop() ?? '';
        }
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

function fitWrappedTextBlock(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  options: {
    fontWeight?: number | string;
    fontFamily?: string;
    maxFontSize: number;
    minFontSize?: number;
    lineHeightRatio?: number;
    maxLines?: number;
  },
): { fontSize: number; lineHeight: number; lines: string[] } {
  const weight = options.fontWeight ?? 700;
  const family = options.fontFamily ?? FONT_DISPLAY;
  const minFont = Math.max(12, options.minFontSize ?? 16);
  const lhRatio = options.lineHeightRatio ?? 1.24;
  const maxLines = options.maxLines ?? 8;
  const safeW = Math.max(24, maxWidth);
  const safeH = Math.max(24, maxHeight);

  let fontSize = Math.max(minFont, options.maxFontSize);
  let bestLines: string[] = [];
  let bestLh = Math.round(fontSize * lhRatio);

  while (fontSize >= minFont) {
    ctx.font = `${weight} ${fontSize}px ${family}`;
    const wrapped = wrapTextLines(ctx, text, safeW);
    const lh = Math.round(fontSize * lhRatio);
    bestLines = wrapped;
    bestLh = lh;
    if (wrapped.length <= maxLines && wrapped.length * lh <= safeH) {
      return { fontSize, lineHeight: lh, lines: wrapped };
    }
    fontSize -= 2;
  }

  return {
    fontSize: minFont,
    lineHeight: Math.round(minFont * lhRatio),
    lines: bestLines.slice(0, maxLines),
  };
}

function drawComparisonStrip(
  ctx: CanvasRenderingContext2D,
  props: ComparisonStripProps,
  width: number,
  time: number,
  elStartTime = 0,
) {
  const count = Math.max(1, props.items.length);
  const safeStripW = Math.max(360, width);
  const elElapsed = Math.max(0, time - elStartTime);

  // Determine active index: latest item whose activateAt <= time
  let activeIdx = -1;
  props.items.forEach((item, idx) => {
    if (item.activateAt !== undefined && time >= item.activateAt) {
      activeIdx = idx;
    }
  });

  const isLongStack = props.items.some((item) => item.label.trim().length > 16) || count > 4;

  if (isLongStack) {
    const rowW = Math.min(1200, safeStripW);
    const rowGap = 12;
    const layouts = props.items.map((item, idx) => {
      const isActive = idx === activeIdx;
      const showSub = Boolean(
        item.sublabel &&
          !(
            !isActive &&
            item.activateAt !== undefined &&
            time < item.activateAt &&
            /đáp\s*án|correct\s*answer|正解/i.test(item.sublabel)
          ),
      );
      const fSize = item.label.length > 78 ? 25 : 28;
      ctx.font = `700 ${fSize}px ${FONT_DISPLAY}`;
      const textMaxW = Math.max(120, rowW - (showSub ? 230 : 68));
      const fitted = fitWrappedTextBlock(ctx, item.label, textMaxW, 130, {
        fontWeight: 700,
        fontFamily: FONT_DISPLAY,
        maxFontSize: fSize,
        minFontSize: 18,
        lineHeightRatio: 1.24,
        maxLines: 3,
      });
      const rowH = Math.max(76, fitted.lines.length * fitted.lineHeight + 28);
      return { item, idx, isActive, showSub, fSize: fitted.fontSize, lh: fitted.lineHeight, lines: fitted.lines, rowH, textMaxW };
    });

    const totalH =
      layouts.reduce((acc, l) => acc + l.rowH, 0) + rowGap * Math.max(0, layouts.length - 1);
    let cursorY = -totalH / 2;

    layouts.forEach(({ item, idx, isActive, showSub, fSize, lh, lines, rowH, textMaxW }) => {
      const stag = computeStaggerItemState(elElapsed, idx, 0.075, 0.34);
      if (!stag.visible) {
        cursorY += rowH + rowGap;
        return;
      }
      const accent = item.accentColor || '#16A34A';
      const activeBoost = isActive ? 1.018 : 1;
      const centerY = cursorY + rowH / 2;

      ctx.save();
      ctx.globalAlpha *= stag.opacity;
      ctx.translate(0, centerY + stag.translateY);
      ctx.scale(stag.scale * activeBoost, stag.scale * activeBoost);

      fillCardWithShadow(
        ctx,
        -rowW / 2,
        -rowH / 2,
        rowW,
        rowH,
        24,
        isActive ? '#FFFFFF' : 'rgba(255,255,255,0.92)',
        isActive ? 0.14 : 0.06,
      );

      if (isActive) {
        ctx.save();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 4.5;
        drawRoundedRectPath(ctx, -rowW / 2, -rowH / 2, rowW, rowH, 24);
        ctx.stroke();
        ctx.restore();
      }

      const textStartY = -((lines.length - 1) * lh) / 2;
      ctx.font = `700 ${fSize}px ${FONT_DISPLAY}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = isActive ? '#0F172A' : '#334155';
      lines.forEach((ln, li) => {
        ctx.fillText(ln, -rowW / 2 + 32, textStartY + li * lh, textMaxW);
      });

      if (showSub && item.sublabel) {
        ctx.font = `700 22px ${FONT_SANS}`;
        const pillW = Math.min(186, Math.max(120, ctx.measureText(item.sublabel).width + 30));
        ctx.fillStyle = isActive ? accent : '#E2E8F0';
        drawRoundedRectPath(ctx, rowW / 2 - pillW - 18, -20, pillW, 40, 20);
        ctx.fill();
        ctx.fillStyle = isActive ? '#FFFFFF' : '#475569';
        ctx.textAlign = 'center';
        ctx.fillText(item.sublabel, rowW / 2 - pillW / 2 - 18, 1, pillW - 18);
      }

      ctx.restore();
      cursorY += rowH + rowGap;
    });
    return;
  }

  // Unified @englishpracticing168 frosted capsule housing all tabs inside one cohesive header bar
  const outerPadX = 14;
  const outerW = safeStripW + outerPadX * 2;
  const outerH = 120;
  fillCardWithShadow(
    ctx,
    -outerW / 2,
    -outerH / 2,
    outerW,
    outerH,
    40,
    'rgba(255, 255, 255, 0.92)',
    0.08,
  );
  ctx.save();
  ctx.strokeStyle = '#E2E8F0';
  ctx.lineWidth = 2;
  drawRoundedRectPath(ctx, -outerW / 2, -outerH / 2, outerW, outerH, 40);
  ctx.stroke();
  ctx.restore();

  const gap = 12;
  const itemW = (safeStripW - gap * (count - 1)) / count;
  const itemH = 96;
  const startX = -safeStripW / 2;
  const startY = -itemH / 2;

  props.items.forEach((item, idx) => {
    const stag = computeStaggerItemState(elElapsed, idx, 0.075, 0.34);
    if (!stag.visible) return;
    const x = startX + idx * (itemW + gap);
    const isActive = idx === activeIdx;
    const accent = item.accentColor || '#2563EB';
    const activeScale = isActive ? 1.02 : 1;

    ctx.save();
    ctx.globalAlpha *= stag.opacity;
    ctx.translate(x + itemW / 2, stag.translateY);
    ctx.scale(stag.scale * activeScale, stag.scale * activeScale);

    if (isActive) {
      fillCardWithShadow(
        ctx,
        -itemW / 2,
        startY,
        itemW,
        itemH,
        28,
        '#FFFFFF',
        0.1,
      );
      ctx.fillStyle = hexToRgba(accent, 0.1);
      drawRoundedRectPath(ctx, -itemW / 2, startY, itemW, itemH, 28);
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3.5;
      ctx.stroke();
    } else {
      ctx.fillStyle = 'rgba(241, 245, 249, 0.72)';
      drawRoundedRectPath(ctx, -itemW / 2, startY, itemW, itemH, 28);
      ctx.fill();
    }

    const showSublabel = Boolean(
      item.sublabel &&
        !(
          !isActive &&
          item.activateAt !== undefined &&
          time < item.activateAt &&
          /đáp\s*án|correct\s*answer|正解/i.test(item.sublabel)
        ),
    );

    const maxLabelW = Math.max(48, itemW - 24);
    const fitted = fitWrappedTextBlock(ctx, item.label, maxLabelW, showSublabel ? 54 : 80, {
      fontWeight: 700,
      fontFamily: FONT_DISPLAY,
      maxFontSize: 31,
      minFontSize: 18,
      lineHeightRatio: 1.18,
      maxLines: 2,
    });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isActive ? accent : '#64748B';
    ctx.font = `700 ${fitted.fontSize}px ${FONT_DISPLAY}`;

    const labelCenterY = showSublabel ? startY + 32 : startY + itemH / 2;
    const firstY = labelCenterY - ((fitted.lines.length - 1) * fitted.lineHeight) / 2;
    fitted.lines.forEach((ln, li) => {
      ctx.fillText(ln, 0, firstY + li * fitted.lineHeight, maxLabelW);
    });

    if (showSublabel && item.sublabel) {
      ctx.font = `600 20px ${FONT_SANS}`;
      ctx.fillStyle = isActive ? '#334155' : '#94A3B8';
      ctx.fillText(item.sublabel, 0, startY + 69, maxLabelW);
    }
    ctx.restore();
  });
}

function drawTopicPill(
  ctx: CanvasRenderingContext2D,
  props: TopicPillProps,
  maxBoxWidth = 880,
) {
  const safeBoxW = Math.max(220, maxBoxWidth);
  const maxTextW = Math.max(150, safeBoxW - 64);
  const fitted = fitWrappedTextBlock(ctx, props.text, maxTextW, 130, {
    fontWeight: 700,
    fontFamily: FONT_SANS,
    maxFontSize: 34,
    minFontSize: 20,
    lineHeightRatio: 1.24,
    maxLines: 3,
  });
  ctx.font = `700 ${fitted.fontSize}px ${FONT_SANS}`;
  const maxLineW = Math.max(120, ...fitted.lines.map((ln) => Math.min(maxTextW, ctx.measureText(ln).width)));
  const pillW = Math.min(safeBoxW, Math.max(220, maxLineW + 64));
  const lh = fitted.lineHeight;
  const pillH = fitted.lines.length === 1 ? 74 : fitted.lines.length * lh + 32;

  fillCardWithShadow(
    ctx,
    -pillW / 2,
    -pillH / 2,
    pillW,
    pillH,
    Math.min(37, Math.round(pillH / 2)),
    props.bgColor,
    0.06,
  );
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = props.textColor;
  ctx.font = `700 ${fitted.fontSize}px ${FONT_SANS}`;
  const startY = -((fitted.lines.length - 1) * lh) / 2 + 1;
  fitted.lines.forEach((ln, li) => {
    ctx.fillText(ln, 0, startY + li * lh, pillW - 44);
  });
}

const VARIANTS_WITH_NATIVE_LABELS = new Set<string>([
  'flow-diagram',
  'timeline-track',
  'tense-timeline',
  'degree-scale',
  'phrasal-split',
  'syllable-stress',
  'trio-icon-cards',
  'contrast-pair-cards',
  'quiz-fill-blank',
  'bs-list-group',
  'bs-pricing-tier',
  'bs-breadcrumb-path',
  'css-bento-stats',
  'css-chat-thread',
  'css-roadmap-steps',
  'css-grammar-equation',
  'bs-badge-cluster',
  'bs-modal-quiz',
  'cartoon-host',
  'dynamic-scene',
  'custom-vector',
]);

function drawProminentLabelsStrip(
  ctx: CanvasRenderingContext2D,
  labels: string[],
  topY: number,
  stripW = 840,
): number {
  const clean = labels.map((l) => l.trim()).filter(Boolean).slice(0, 3);
  if (clean.length === 0) return 0;
  const safeStripW = Math.min(840, Math.max(240, stripW));

  const palette = [
    { bg: '#EEF2FF', border: '#C7D2FE', fg: '#312E81', badge: '#4F46E5' },
    { bg: '#ECFDF5', border: '#A7F3D0', fg: '#065F46', badge: '#10B981' },
    { bg: '#FFF7ED', border: '#FED7AA', fg: '#9A3412', badge: '#EA580C' },
  ];

  // If 2–3 labels are all concise (<= 13 chars), lay them out in 2–3 distinct wide columns
  const allShort = clean.every((l) => l.length <= 13);
  if (allShort && clean.length >= 2) {
    const gap = 16;
    const colW = (safeStripW - gap * (clean.length - 1)) / clean.length;
    const colH = 74;
    const startX = -safeStripW / 2;
    clean.forEach((lbl, i) => {
      const col = palette[i % palette.length];
      const cx = startX + i * (colW + gap);
      fillCardWithShadow(ctx, cx, topY, colW, colH, 20, col.bg, 0.08);
      ctx.strokeStyle = col.border;
      ctx.lineWidth = 2.5;
      drawRoundedRectPath(ctx, cx, topY, colW, colH, 20);
      ctx.stroke();

      const fitted = fitWrappedTextBlock(ctx, lbl, colW - 24, colH - 12, {
        fontWeight: 800,
        maxFontSize: 30,
        minFontSize: 18,
        maxLines: 2,
        lineHeightRatio: 1.15,
      });
      ctx.font = `800 ${fitted.fontSize}px ${FONT_DISPLAY}`;
      ctx.fillStyle = col.fg;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ly = topY + colH / 2 - ((fitted.lines.length - 1) * fitted.lineHeight) / 2;
      fitted.lines.forEach((ln, li) => ctx.fillText(ln, cx + colW / 2, ly + li * fitted.lineHeight, colW - 20));
    });
    return colH;
  }

  // Longer callouts: stack vertically in 2 or 3 distinct spacious rows (never cramped!)
  const gap = 10;
  let cursorY = topY;
  clean.forEach((lbl, i) => {
    const col = palette[i % palette.length];
    const textMaxW = Math.max(120, safeStripW - 108);
    const fitted = fitWrappedTextBlock(ctx, lbl, textMaxW, 86, {
      fontWeight: 800,
      maxFontSize: 30,
      minFontSize: 18,
      maxLines: 2,
      lineHeightRatio: 1.2,
    });
    const rowH = Math.max(66, fitted.lines.length * fitted.lineHeight + 26);

    fillCardWithShadow(ctx, -safeStripW / 2, cursorY, safeStripW, rowH, 20, col.bg, 0.08);
    ctx.strokeStyle = col.border;
    ctx.lineWidth = 2.5;
    drawRoundedRectPath(ctx, -safeStripW / 2, cursorY, safeStripW, rowH, 20);
    ctx.stroke();

    // Numbered pill on left
    ctx.fillStyle = col.badge;
    ctx.beginPath();
    ctx.arc(-safeStripW / 2 + 38, cursorY + rowH / 2, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `800 22px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${i + 1}`, -safeStripW / 2 + 38, cursorY + rowH / 2 + 1);

    ctx.font = `800 ${fitted.fontSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = col.fg;
    ctx.textAlign = 'left';
    const textStartY = cursorY + rowH / 2 - ((fitted.lines.length - 1) * fitted.lineHeight) / 2;
    fitted.lines.forEach((ln, li) => {
      ctx.fillText(ln, -safeStripW / 2 + 72, textStartY + li * fitted.lineHeight, textMaxW);
    });
    cursorY += rowH + gap;
  });
  return cursorY - topY - gap;
}

function measureProminentLabelsHeight(labels?: string[]): number {
  const clean = (labels || []).map((l) => l.trim()).filter(Boolean).slice(0, 3);
  if (clean.length === 0) return 0;
  if (clean.length >= 2 && clean.every((l) => l.length <= 13)) return 74;
  return clean.reduce((sum, l, idx) => {
    const rowH = l.length > 36 ? 98 : 66;
    return sum + rowH + (idx > 0 ? 10 : 0);
  }, 0);
}

function drawIllustrationProp(
  ctx: CanvasRenderingContext2D,
  props: IllustrationPropProps,
  time: number,
  elStartTime = 0,
  cues: TranscriptCue[] = [],
) {
  const elElapsed = Math.max(0, time - elStartTime);
  const floatRamp = easeOutCubic(clamp01(elElapsed / 0.5));
  const floatOffset = props.variant === 'cartoon-host' ? 0 : Math.sin(elElapsed * 2.1) * 6 * floatRamp;
  ctx.save();
  ctx.translate(0, floatOffset);

  if (props.data?.customPrimitives && props.data.customPrimitives.length > 0) {
    drawVectorPrimitives(ctx, props.data.customPrimitives, time, (icon) => drawSceneIcon(ctx, icon));
    ctx.restore();
    return;
  }

  const customDef = getCustomComponentByVariant(props.variant);
  if (customDef && customDef.primitives && customDef.primitives.length > 0) {
    drawVectorPrimitives(ctx, customDef.primitives, time, (icon) => drawSceneIcon(ctx, icon));
    ctx.restore();
    return;
  }

  const attachExtraLabels =
    !VARIANTS_WITH_NATIVE_LABELS.has(props.variant) &&
    Boolean(props.data?.labels && props.data.labels.length > 0);
  const extraLabelsH = attachExtraLabels
    ? measureProminentLabelsHeight(props.data?.labels)
    : 0;
  if (extraLabelsH > 0) {
    ctx.translate(0, -(extraLabelsH + 16) / 2);
  }

  if (props.variant === 'cafe-water') {
    // Glass of water on the left
    ctx.save();
    ctx.translate(-225, 65);
    ctx.fillStyle = '#E0F2FE';
    ctx.beginPath();
    ctx.moveTo(-36, -64);
    ctx.lineTo(36, -64);
    ctx.lineTo(26, 68);
    ctx.lineTo(-26, 68);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#60A5FA';
    ctx.beginPath();
    ctx.moveTo(-31, -20);
    ctx.lineTo(31, -20);
    ctx.lineTo(24, 62);
    ctx.lineTo(-24, 62);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#93C5FD';
    ctx.lineWidth = 4;
    ctx.strokeRect(-1, -1, 2, 2); // noop clean state
    ctx.restore();

    // Minimalist cafe shop center
    fillCardWithShadow(ctx, -125, -80, 250, 220, 24, '#FFFDF9', 0.08);
    // Roof stripes
    const stripeW = 250 / 5;
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = i % 2 === 0 ? '#EF4444' : '#FFFFFF';
      drawRoundedRectPath(ctx, -135 + i * (270 / 5), -110, 270 / 5, 58, 12);
      ctx.fill();
    }
    // Window
    ctx.fillStyle = '#BAE6FD';
    drawRoundedRectPath(ctx, -98, -22, 108, 92, 16);
    ctx.fill();
    // Door
    ctx.fillStyle = '#92400E';
    drawRoundedRectPath(ctx, 28, -12, 72, 152, 14);
    ctx.fill();
    ctx.fillStyle = '#FBBF24';
    ctx.beginPath();
    ctx.arc(84, 64, 7, 0, Math.PI * 2);
    ctx.fill();

    // Friendly modern character on right
    drawCharacterAvatar(ctx, {
      x: 220,
      y: 12,
      shirtColor: '#EC4899',
      hairColor: '#3E2723',
      hairStyle: 'bob',
      expression: 'happy',
      nameTag: 'Customer',
      tagColor: '#DB2777',
    });
  } else if (props.variant === 'coffee-cup') {
    fillCardWithShadow(ctx, -95, -50, 190, 130, 32, '#FFFFFF', 0.08);
    ctx.fillStyle = '#92400E';
    ctx.beginPath();
    ctx.ellipse(0, -34, 72, 20, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(105, 10, 32, -Math.PI / 2, Math.PI / 2);
    ctx.stroke();
  } else if (props.variant === 'friends-chat') {
    // Two modern flat-vector characters chatting with speech bubble above
    drawCharacterAvatar(ctx, {
      x: -145,
      y: 12,
      shirtColor: '#2563EB',
      hairColor: '#1E293B',
      hairStyle: 'short',
      expression: 'smile',
      nameTag: props.data?.labels?.[0] || 'Alex',
      tagColor: '#2563EB',
    });
    drawCharacterAvatar(ctx, {
      x: 145,
      y: 12,
      shirtColor: '#EC4899',
      hairColor: '#78350F',
      hairStyle: 'bob',
      expression: 'happy',
      nameTag: props.data?.labels?.[1] || 'Mia',
      tagColor: '#DB2777',
    });
    // Crisp chat bubble above
    fillCardWithShadow(ctx, -74, -124, 148, 72, 24, '#FFFFFF', 0.09);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -74, -124, 148, 72, 24);
    ctx.stroke();
    ctx.fillStyle = '#2563EB';
    [-26, 0, 26].forEach((dx, i) => {
      const bounce = Math.sin(time * 5 + i * 0.9) * 4;
      ctx.beginPath();
      ctx.arc(dx, -88 + bounce, 7, 0, Math.PI * 2);
      ctx.fill();
    });
  } else if (props.variant === 'office-work') {
    // Minimalist office monitor / desk & calendar
    fillCardWithShadow(ctx, -165, -95, 330, 195, 28, '#FFFFFF', 0.08);
    ctx.fillStyle = '#E0E7FF';
    drawRoundedRectPath(ctx, -135, -65, 270, 125, 16);
    ctx.fill();
    // Tie / collar badge in center + calendar card
    ctx.fillStyle = '#4F46E5';
    drawRoundedRectPath(ctx, -108, -42, 108, 80, 12);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `800 28px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('FRI', -54, -2);
    // Email lines on right
    ctx.fillStyle = '#6366F1';
    drawRoundedRectPath(ctx, 18, -36, 94, 14, 7);
    ctx.fill();
    ctx.fillStyle = '#94A3B8';
    drawRoundedRectPath(ctx, 18, -8, 76, 12, 6);
    ctx.fill();
    drawRoundedRectPath(ctx, 18, 18, 86, 12, 6);
    ctx.fill();
    // Stand
    ctx.fillStyle = '#CBD5E1';
    drawRoundedRectPath(ctx, -40, 100, 80, 20, 8);
    ctx.fill();
  } else if (props.variant === 'hotel-desk') {
    // Formal hotel reception bell + keycard
    fillCardWithShadow(ctx, -160, -70, 320, 165, 28, '#FFFDF9', 0.08);
    ctx.fillStyle = '#7C3AED';
    drawRoundedRectPath(ctx, -125, 24, 250, 44, 16);
    ctx.fill();
    // Bell dome
    ctx.fillStyle = '#F59E0B';
    ctx.beginPath();
    ctx.arc(0, 18, 68, Math.PI, 0);
    ctx.fill();
    ctx.fillStyle = '#FDE68A';
    drawRoundedRectPath(ctx, -12, -66, 24, 16, 8);
    ctx.fill();
    // Sparkle
    const pulse = 0.7 + 0.3 * Math.sin(time * 4);
    ctx.fillStyle = `rgba(124, 58, 237, ${pulse})`;
    ctx.beginPath();
    ctx.arc(82, -52, 8, 0, Math.PI * 2);
    ctx.fill();
  } else if (props.variant === 'lightbulb-tip') {
    const glow = 0.28 + 0.14 * Math.sin(time * 3.5);
    ctx.fillStyle = `rgba(250, 204, 21, ${glow})`;
    ctx.beginPath();
    ctx.arc(0, -18, 118, 0, Math.PI * 2);
    ctx.fill();
    // Bulb glass
    ctx.fillStyle = '#FACC15';
    ctx.beginPath();
    ctx.arc(0, -24, 72, 0, Math.PI * 2);
    ctx.fill();
    drawRoundedRectPath(ctx, -36, 26, 72, 42, 14);
    ctx.fill();
    // Screw base
    ctx.fillStyle = '#475569';
    drawRoundedRectPath(ctx, -32, 68, 64, 34, 12);
    ctx.fill();
    // Inner filament check
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 8;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-22, -20);
    ctx.lineTo(-4, 0);
    ctx.lineTo(26, -34);
    ctx.stroke();
  } else if (props.variant === 'ear-listen') {
    fillCardWithShadow(ctx, -140, -90, 280, 180, 44, '#FFFFFF', 0.08);
    // Headphones arc + sound waves
    ctx.strokeStyle = '#4F46E5';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(0, 6, 58, Math.PI, 0);
    ctx.stroke();
    ctx.fillStyle = '#4F46E5';
    drawRoundedRectPath(ctx, -74, -4, 28, 56, 14);
    ctx.fill();
    drawRoundedRectPath(ctx, 46, -4, 28, 56, 14);
    ctx.fill();
    // Equalizer bars in middle
    [0, 1, 2].forEach((i) => {
      const h = 22 + 28 * Math.abs(Math.sin(time * 5 + i * 0.9));
      ctx.fillStyle = '#0284C7';
      drawRoundedRectPath(ctx, -22 + i * 18, 20 - h / 2, 10, h, 5);
      ctx.fill();
    });
  } else if (props.variant === 'speech-bubble') {
    fillCardWithShadow(ctx, -180, -90, 360, 160, 44, '#FFFFFF', 0.08);
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(-40, 70);
    ctx.lineTo(10, 70);
    ctx.lineTo(-25, 118);
    ctx.closePath();
    ctx.fill();

    // Animated sound bars inside bubble
    const barHeights = [26, 52, 74, 44, 64, 34];
    barHeights.forEach((h, i) => {
      const pulse = Math.abs(Math.sin(time * 4 + i * 0.7));
      const bh = 22 + h * 0.65 * pulse;
      ctx.fillStyle = i % 2 === 0 ? '#4F46E5' : '#0284C7';
      drawRoundedRectPath(ctx, -105 + i * 38, -bh / 2 - 10, 18, bh, 9);
      ctx.fill();
    });
  } else if (props.variant === 'flow-diagram') {
    const nodes =
      props.data?.nodes && props.data.nodes.length >= 2
        ? props.data.nodes.slice(0, 3)
        : [
            { label: 'Present', icon: 'clock' as const, color: '#2563EB' },
            { label: 'Past', icon: 'history' as const, color: '#16A34A' },
            { label: 'Future', icon: 'rocket' as const, color: '#7C3AED' },
          ];
    const xs = nodes.length === 2 ? [-190, 190] : [-280, 0, 280];

    // Connecting arrows
    for (let i = 0; i < xs.length - 1; i++) {
      const ax1 = xs[i] + 74;
      const ax2 = xs[i + 1] - 74;
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(ax1, -24);
      ctx.lineTo(ax2 - 12, -24);
      ctx.stroke();
      ctx.fillStyle = '#94A3B8';
      ctx.beginPath();
      ctx.moveTo(ax2, -24);
      ctx.lineTo(ax2 - 20, -36);
      ctx.lineTo(ax2 - 20, -12);
      ctx.closePath();
      ctx.fill();
    }

    nodes.forEach((node, idx) => {
      const nx = xs[idx];
      const color = node.color || '#2563EB';
      ctx.save();
      ctx.shadowColor = 'rgba(15, 23, 42, 0.12)';
      ctx.shadowBlur = 22;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(nx, -24, 58, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      ctx.strokeStyle = color;
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.arc(nx, -24, 54, 0, Math.PI * 2);
      ctx.stroke();

      // Inner glyph
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.lineWidth = 5;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (node.icon === 'rocket') {
        ctx.beginPath();
        ctx.moveTo(nx, -48);
        ctx.lineTo(nx + 16, -18);
        ctx.lineTo(nx - 16, -18);
        ctx.closePath();
        ctx.fill();
        ctx.fillRect(nx - 6, -18, 12, 16);
      } else if (node.icon === 'star') {
        ctx.beginPath();
        for (let s = 0; s < 5; s++) {
          const a1 = -Math.PI / 2 + (s * 2 * Math.PI) / 5;
          const a2 = a1 + Math.PI / 5;
          ctx.lineTo(nx + Math.cos(a1) * 22, -24 + Math.sin(a1) * 22);
          ctx.lineTo(nx + Math.cos(a2) * 10, -24 + Math.sin(a2) * 10);
        }
        ctx.closePath();
        ctx.fill();
      } else if (node.icon === 'check') {
        ctx.beginPath();
        ctx.moveTo(nx - 18, -24);
        ctx.lineTo(nx - 4, -10);
        ctx.lineTo(nx + 20, -38);
        ctx.stroke();
      } else if (node.icon === 'chat') {
        drawRoundedRectPath(ctx, nx - 22, -40, 44, 30, 10);
        ctx.fill();
        ctx.fillStyle = '#FFFFFF';
        [-10, 0, 10].forEach((dx) => {
          ctx.beginPath();
          ctx.arc(nx + dx, -25, 3.2, 0, Math.PI * 2);
          ctx.fill();
        });
      } else {
        // clock / history default
        ctx.beginPath();
        ctx.arc(nx, -24, 21, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(nx, -36);
        ctx.lineTo(nx, -24);
        ctx.lineTo(nx + 11, -18);
        ctx.stroke();
      }

      // Label pill below circle
      ctx.font = `800 28px ${FONT_DISPLAY}`;
      const lw = Math.min(240, Math.max(132, ctx.measureText(node.label).width + 38));
      fillCardWithShadow(ctx, nx - lw / 2, 46, lw, 46, 23, color, 0.08);
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.label, nx, 69, lw - 24);
    });
  } else if (props.variant === 'gauge-arc') {
    const val = clamp01((props.data?.value ?? 0.65) + Math.sin(time * 2.4) * 0.015);
    const segments = ['#EF4444', '#F97316', '#FACC15', '#4ADE80', '#16A34A'];
    const cx = 0;
    const cy = 58;
    const radius = 152;
    const segSpan = Math.PI / segments.length;
    const gapRad = 0.04;

    fillCardWithShadow(ctx, -370, -138, 740, 278, 36, '#FFFFFF', 0.09);

    segments.forEach((col, i) => {
      const a0 = Math.PI + i * segSpan + gapRad / 2;
      const a1 = Math.PI + (i + 1) * segSpan - gapRad / 2;
      ctx.strokeStyle = col;
      ctx.lineWidth = 34;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.arc(cx, cy, radius, a0, a1);
      ctx.stroke();
    });

    // Indicator dot along arc
    const needleAngle = Math.PI + val * Math.PI;
    const dotX = cx + Math.cos(needleAngle) * radius;
    const dotY = cy + Math.sin(needleAngle) * radius;
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
    ctx.shadowBlur = 14;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(dotX, dotY, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#0F172A';
    ctx.stroke();
    ctx.restore();

    // Friendly emoji face inside arc
    ctx.fillStyle = val < 0.35 ? '#FECACA' : val > 0.65 ? '#BBF7D0' : '#FEF08A';
    ctx.beginPath();
    ctx.arc(0, 24, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1E293B';
    ctx.beginPath();
    ctx.arc(-18, 16, 5.5, 0, Math.PI * 2);
    ctx.arc(18, 16, 5.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#1E293B';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (val < 0.35) {
      ctx.arc(0, 48, 16, 1.15 * Math.PI, 1.85 * Math.PI);
    } else if (val > 0.6) {
      ctx.arc(0, 26, 20, 0.15 * Math.PI, 0.85 * Math.PI);
    } else {
      ctx.moveTo(-16, 36);
      ctx.lineTo(16, 36);
    }
    ctx.stroke();

    const statusText = props.data?.subtitle || 'Good & Polite';
    ctx.font = `700 28px ${FONT_SANS}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(statusText, 0, 106, 480);
  } else if (props.variant === 'timeline-track') {
    const progress = clamp01(props.data?.value ?? 0.68);
    const labels =
      props.data?.labels && props.data.labels.length >= 2
        ? props.data.labels.slice(0, 3)
        : ['Early', 'On time', 'Too late'];

    fillCardWithShadow(ctx, -430, -104, 860, 208, 34, '#FFFFFF', 0.09);

    // Track line
    const x0 = -320;
    const x1 = 320;
    const trackY = -20;
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, trackY);
    ctx.lineTo(x1, trackY);
    ctx.stroke();

    // Active progress fill
    const activeX = x0 + (x1 - x0) * progress;
    const grad = ctx.createLinearGradient(x0, 0, x1, 0);
    grad.addColorStop(0, '#3B82F6');
    grad.addColorStop(1, '#10B981');
    ctx.strokeStyle = grad;
    ctx.beginPath();
    ctx.moveTo(x0, trackY);
    ctx.lineTo(activeX, trackY);
    ctx.stroke();

    // Start marker & Finish Flag
    ctx.fillStyle = '#3B82F6';
    ctx.beginPath();
    ctx.arc(x0, trackY, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#334155';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(x1, trackY + 6);
    ctx.lineTo(x1, trackY - 44);
    ctx.stroke();
    ctx.fillStyle = '#F59E0B';
    drawRoundedRectPath(ctx, x1, trackY - 44, 34, 22, 4);
    ctx.fill();

    // Moving runner dot
    ctx.save();
    ctx.shadowColor = 'rgba(16, 185, 129, 0.45)';
    ctx.shadowBlur = 16;
    ctx.fillStyle = '#10B981';
    ctx.beginPath();
    ctx.arc(activeX, trackY, 22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(activeX, trackY, 9, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Milestone labels
    const lxs = labels.length === 2 ? [-200, 200] : [-270, 0, 270];
    const pillW = labels.length === 2 ? 320 : 236;
    labels.forEach((lbl, i) => {
      const lx = lxs[i];
      const isCurrent = Math.abs(progress - i / Math.max(1, labels.length - 1)) < 0.35;
      ctx.font = `700 24px ${FONT_SANS}`;
      const lines = wrapTextLines(ctx, lbl, pillW - 24).slice(0, 2);
      const pillH = lines.length > 1 ? 66 : 50;
      ctx.fillStyle = isCurrent ? '#DCFCE7' : '#F1F5F9';
      drawRoundedRectPath(ctx, lx - pillW / 2, 24, pillW, pillH, 20);
      ctx.fill();
      ctx.fillStyle = isCurrent ? '#15803D' : '#334155';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ly = 24 + pillH / 2 - ((lines.length - 1) * 26) / 2;
      lines.forEach((ln, li) => ctx.fillText(ln, lx, ly + li * 26));
    });
  } else if (props.variant === 'checklist-card') {
    const items =
      props.data?.checklist && props.data.checklist.length > 0
        ? props.data.checklist.slice(0, 4)
        : [
            { text: 'You are right.', ok: true },
            { text: 'We are on time.', ok: true },
            { text: 'They are here.', ok: true },
          ];
    const rowH = 66;
    const cardH = 74 + items.length * rowH;
    const cardW = 840;
    const topY = -cardH / 2;

    fillCardWithShadow(ctx, -cardW / 2, topY, cardW, cardH, 34, '#FFFFFF', 0.09);

    ctx.font = `700 24px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Checklist', 0, topY + 34);

    items.forEach((item, idx) => {
      const ry = topY + 80 + idx * rowH;
      const isOk = item.ok !== false;
      ctx.fillStyle = isOk ? '#F0FDF4' : '#FEF2F2';
      drawRoundedRectPath(ctx, -cardW / 2 + 28, ry - 24, cardW - 56, 52, 18);
      ctx.fill();

      // Check or Cross circle
      const bx = -cardW / 2 + 64;
      ctx.fillStyle = isOk ? '#16A34A' : '#DC2626';
      ctx.beginPath();
      ctx.arc(bx, ry + 2, 16, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (isOk) {
        ctx.moveTo(bx - 7, ry + 2);
        ctx.lineTo(bx - 2, ry + 8);
        ctx.lineTo(bx + 8, ry - 5);
      } else {
        ctx.moveTo(bx - 6, ry - 4);
        ctx.lineTo(bx + 6, ry + 8);
        ctx.moveTo(bx + 6, ry - 4);
        ctx.lineTo(bx - 6, ry + 8);
      }
      ctx.stroke();

      ctx.font = `700 30px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#0F172A';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.text, bx + 32, ry + 3, cardW - 140);
    });
  } else if (props.variant === 'dialogue-upgrade') {
    const rows =
      props.data?.upgrades && props.data.upgrades.length > 0
        ? props.data.upgrades.slice(0, 3)
        : [
            { prompt: 'Very good', upgrade: 'Wonderful', badgeColor: '#2563EB' },
            { prompt: 'Very tasty', upgrade: 'Delicious', badgeColor: '#16A34A' },
            { prompt: 'Very nice', upgrade: 'Amazing', badgeColor: '#7C3AED' },
          ];
    const rowH = 82;
    const totalH = rows.length * rowH;
    const startY = -totalH / 2 + rowH / 2;

    rows.forEach((row, idx) => {
      const ry = startY + idx * rowH;
      fillCardWithShadow(ctx, -430, ry - 34, 860, 68, 24, '#FFFFFF', 0.08);

      // Mini avatar
      ctx.fillStyle = '#FDE68A';
      ctx.beginPath();
      ctx.arc(-384, ry, 20, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1E293B';
      ctx.beginPath();
      ctx.arc(-390, ry - 2, 2.5, 0, Math.PI * 2);
      ctx.arc(-378, ry - 2, 2.5, 0, Math.PI * 2);
      ctx.fill();

      // Prompt text (auto-fit font size so it never squishes)
      let promptFontPx = 25;
      while (promptFontPx > 19) {
        ctx.font = `600 ${promptFontPx}px ${FONT_SANS}`;
        if (ctx.measureText(row.prompt).width <= 366) break;
        promptFontPx -= 1;
      }
      ctx.fillStyle = '#334155';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(row.prompt, -350, ry + 1, 366);

      // Arrow
      ctx.fillStyle = '#94A3B8';
      ctx.font = `700 28px ${FONT_SANS}`;
      ctx.textAlign = 'center';
      ctx.fillText('→', 42, ry);

      // Upgrade pill
      const bColor = row.badgeColor || '#16A34A';
      ctx.fillStyle = bColor;
      drawRoundedRectPath(ctx, 78, ry - 24, 336, 48, 24);
      ctx.fill();

      let upgFontPx = 25;
      while (upgFontPx > 18) {
        ctx.font = `700 ${upgFontPx}px ${FONT_DISPLAY}`;
        if (ctx.measureText(row.upgrade).width <= 300) break;
        upgFontPx -= 1;
      }
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(row.upgrade, 246, ry + 1, 300);
    });
  } else if (props.variant === 'clock-face') {
    const hour = props.data?.timeHour ?? 8;
    const minute = props.data?.timeMinute ?? 20;
    const formula = props.data?.formula || `${hour}:${String(minute).padStart(2, '0')}`;
    const sub = props.data?.subtitle || 'Use "past" / "to"';

    // Analog clock on left
    const cx = -165;
    const cy = 0;
    const r = 114;
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.12)';
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();

    // Shaded minute sector
    const startAng = -Math.PI / 2;
    const minAng = startAng + (minute / 60) * Math.PI * 2;
    if (minute > 0) {
      ctx.fillStyle = 'rgba(59, 130, 246, 0.16)';
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r - 12, startAng, minAng);
      ctx.closePath();
      ctx.fill();
    }

    // 12 hour dots
    for (let h = 0; h < 12; h++) {
      const a = -Math.PI / 2 + (h / 12) * Math.PI * 2;
      ctx.fillStyle = h % 3 === 0 ? '#1E293B' : '#94A3B8';
      ctx.beginPath();
      ctx.arc(cx + Math.cos(a) * (r - 18), cy + Math.sin(a) * (r - 18), h % 3 === 0 ? 5 : 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Hour & Minute hands
    const hourAng = -Math.PI / 2 + (((hour % 12) + minute / 60) / 12) * Math.PI * 2;
    ctx.strokeStyle = '#0F172A';
    ctx.lineCap = 'round';
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(hourAng) * 58, cy + Math.sin(hourAng) * 58);
    ctx.stroke();

    ctx.strokeStyle = '#2563EB';
    ctx.lineWidth = 6;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(minAng) * 86, cy + Math.sin(minAng) * 86);
    ctx.stroke();

    ctx.fillStyle = '#0F172A';
    ctx.beginPath();
    ctx.arc(cx, cy, 8, 0, Math.PI * 2);
    ctx.fill();

    // Right readout card
    fillCardWithShadow(ctx, -10, -86, 390, 172, 32, '#FFFFFF', 0.09);
    ctx.font = `800 50px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#2563EB';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(formula, 185, -18, 350);
    ctx.font = `600 28px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(sub, 185, 42, 350);
  } else if (props.variant === 'spatial-boxes') {
    const boxes =
      props.data?.boxes && props.data.boxes.length >= 2
        ? props.data.boxes.slice(0, 3)
        : [
            { title: 'AT', subtitle: 'point', icon: 'dot' as const, accent: '#2563EB' },
            { title: 'ON', subtitle: 'surface', icon: 'surface' as const, accent: '#16A34A' },
            { title: 'IN', subtitle: 'space', icon: 'cube' as const, accent: '#7C3AED' },
          ];
    const gap = 24;
    const bw = boxes.length === 2 ? 360 : 276;
    const totalW = boxes.length * bw + (boxes.length - 1) * gap;
    const startX = -totalW / 2;

    boxes.forEach((box, idx) => {
      const bx = startX + idx * (bw + gap) + bw / 2;
      const accent = box.accent || '#2563EB';
      fillCardWithShadow(ctx, bx - bw / 2, -108, bw, 216, 30, '#FFFFFF', 0.09);

      // Icon container
      ctx.fillStyle = '#F8FAFC';
      drawRoundedRectPath(ctx, bx - bw / 2 + 20, -90, bw - 40, 88, 20);
      ctx.fill();

      if (box.icon === 'surface') {
        ctx.fillStyle = '#CBD5E1';
        drawRoundedRectPath(ctx, bx - 44, -40, 88, 16, 8);
        ctx.fill();
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(bx, -52, 14, 0, Math.PI * 2);
        ctx.fill();
      } else if (box.icon === 'cube') {
        ctx.strokeStyle = accent;
        ctx.lineWidth = 4;
        ctx.strokeRect(bx - 26, -68, 52, 46);
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(bx, -45, 11, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.arc(bx, -46, 20, 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.font = `800 36px ${FONT_DISPLAY}`;
      ctx.fillStyle = accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(box.title, bx, 34, bw - 36);

      if (box.subtitle) {
        ctx.font = `600 24px ${FONT_SANS}`;
        ctx.fillStyle = '#64748B';
        ctx.fillText(box.subtitle, bx, 76, bw - 36);
      }
    });
  } else if (props.variant === 'cartoon-host') {
    drawCartoonHostCharacter(ctx, time, cues);
  } else if (props.variant === 'avatar-speech') {
    const speech = props.data?.speechText || 'Could I have some water, please?';
    const reaction = props.data?.reactionText || 'Polite!';
    const lip = computeSpeechLipSyncState(cues, time);

    // Modern speaker avatar on left with smooth speech lip-sync + natural blink
    ctx.save();
    ctx.fillStyle = '#DBEAFE';
    ctx.beginPath();
    ctx.arc(-295, 10, 86, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    drawCharacterAvatar(ctx, {
      x: -295,
      y: 2,
      shirtColor: '#2563EB',
      hairColor: '#1E293B',
      hairStyle: 'side',
      expression: reaction.includes('blunt') ? 'curious' : 'smile',
      scale: 0.92,
      lipSync: lip,
    });

    // Speech bubble on right
    fillCardWithShadow(ctx, -185, -86, 585, 152, 34, '#FFFFFF', 0.09);
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(-185, -18);
    ctx.lineTo(-218, 4);
    ctx.lineTo(-185, 20);
    ctx.closePath();
    ctx.fill();

    ctx.font = `700 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const lines = wrapTextLines(ctx, speech, 520).slice(0, 2);
    const lh = 44;
    const sy = -10 - ((lines.length - 1) * lh) / 2;
    lines.forEach((ln, i) => ctx.fillText(ln, -148, sy + i * lh, 520));

    // Reaction pill
    ctx.font = `700 22px ${FONT_SANS}`;
    const rw = Math.min(240, Math.max(120, ctx.measureText(reaction).width + 38));
    fillCardWithShadow(ctx, 400 - rw - 16, 46, rw, 42, 21, '#4F46E5', 0.08);
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText(reaction, 400 - rw / 2 - 16, 67, rw - 24);
  } else if (props.variant === 'phrase-icon-split') {
    const nodes = (props.data?.nodes ?? []).slice(0, 3);
    const quote = props.data?.speechText || 'I see TV every';
    const chip = (props.data?.highlightWord || 'night.').replace(/["“”]/g, '');
    const contextRule = props.data?.subtitle || props.data?.title || 'Context & meaning';
    const iconKind = props.data?.sceneIcon || 'tv';

    // 1. Cohesive integrated summary card on top (rule breakdown + context line)
    fillCardWithShadow(ctx, -420, -214, 840, 168, 30, '#FFFFFF', 0.09);
    ctx.save();
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -214, 840, 168, 30);
    ctx.stroke();
    ctx.restore();

    if (nodes.length >= 2) {
      const slotW = 760 / nodes.length;
      nodes.forEach((node, i) => {
        const nx = -380 + i * slotW + slotW / 2;
        ctx.fillStyle = '#F8FAFC';
        drawRoundedRectPath(ctx, nx - slotW * 0.42, -198, slotW * 0.84, 72, 18);
        ctx.fill();
        ctx.font = `800 26px ${FONT_DISPLAY}`;
        ctx.fillStyle = node.color || '#334155';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(node.label, nx, -172, slotW * 0.78);
        if (node.sublabel) {
          ctx.font = `600 18px ${FONT_SANS}`;
          ctx.fillStyle = '#64748B';
          ctx.fillText(node.sublabel, nx, -142, slotW * 0.78);
        }
        if (i < nodes.length - 1) {
          ctx.fillStyle = '#94A3B8';
          ctx.font = `700 22px ${FONT_SANS}`;
          ctx.fillText('→', nx + slotW / 2, -162);
        }
      });
    } else {
      ctx.font = `800 28px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#1E293B';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(props.data?.title || 'KEY CONTRAST', 0, -162, 760);
    }

    // Thin divider + fitted context line (never squished!)
    ctx.strokeStyle = '#EEF2F7';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-388, -112);
    ctx.lineTo(388, -112);
    ctx.stroke();

    const fittedRule = fitWrappedTextBlock(ctx, contextRule, 760, 48, {
      fontWeight: 700,
      fontFamily: FONT_DISPLAY,
      maxFontSize: 28,
      minFontSize: 18,
      maxLines: 1,
    });
    ctx.font = `700 ${fittedRule.fontSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(fittedRule.lines[0] ?? contextRule, 0, -79, 760);

    // 2. Large crisp quote line
    const fittedQuote = fitWrappedTextBlock(ctx, quote, 800, 74, {
      fontWeight: 800,
      fontFamily: FONT_DISPLAY,
      maxFontSize: 48,
      minFontSize: 28,
      maxLines: 2,
      lineHeightRatio: 1.18,
    });
    ctx.font = `800 ${fittedQuote.fontSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const qBaseY = fittedQuote.lines.length > 1 ? -4 : 6;
    fittedQuote.lines.forEach((ln, li) => {
      ctx.fillText(
        ln,
        0,
        qBaseY - ((fittedQuote.lines.length - 1) * fittedQuote.lineHeight) / 2 + li * fittedQuote.lineHeight,
        800,
      );
    });

    // 3. Framed rounded icon tile + sleek emphasis chip pill side-by-side / stacked cleanly
    fillCardWithShadow(ctx, -186, 56, 152, 134, 30, '#FFFFFF', 0.11);
    ctx.save();
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2.5;
    drawRoundedRectPath(ctx, -186, 56, 152, 134, 30);
    ctx.stroke();
    ctx.translate(-110, 123);
    ctx.scale(0.84, 0.84);
    drawSceneIcon(ctx, iconKind);
    ctx.restore();

    ctx.font = `800 34px ${FONT_DISPLAY}`;
    const chipW = Math.min(340, Math.max(180, ctx.measureText(chip).width + 64));
    fillCardWithShadow(ctx, 18, 88, chipW, 70, 35, '#EEF2FF', 0.08);
    ctx.strokeStyle = '#C7D2FE';
    ctx.lineWidth = 2.5;
    drawRoundedRectPath(ctx, 18, 88, chipW, 70, 35);
    ctx.stroke();
    ctx.fillStyle = '#4338CA';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(chip, 18 + chipW / 2, 123, chipW - 28);
  } else if (props.variant === 'trio-icon-cards') {
    const defaultNodes = [
      { label: 'Look', sublabel: 'on purpose', sceneIcon: 'eye' as IllustrationSceneIcon, color: '#2563EB' },
      { label: 'See', sublabel: 'automatic', sceneIcon: 'glasses' as IllustrationSceneIcon, color: '#64748B' },
      { label: 'Watch', sublabel: 'moving', sceneIcon: 'tv' as IllustrationSceneIcon, color: '#D97706' },
    ];
    const nodes =
      props.data?.nodes && props.data.nodes.length >= 2
        ? props.data.nodes.slice(0, 3)
        : defaultNodes;
    const gap = 22;
    const cw = nodes.length === 2 ? 360 : 264;
    const ch = 250;
    const startX = -((nodes.length * cw + (nodes.length - 1) * gap) / 2);

    nodes.forEach((node, idx) => {
      const stag = computeStaggerItemState(elElapsed, idx, 0.09, 0.36);
      if (!stag.visible) return;
      const cx = startX + idx * (cw + gap) + cw / 2;
      const accent = node.color || defaultNodes[idx % 3].color;
      const nodeIcon =
        node.sceneIcon ||
        (idx === 0 ? 'eye' : idx === 1 ? 'glasses' : 'tv');

      ctx.save();
      ctx.globalAlpha *= stag.opacity;
      ctx.translate(cx, stag.translateY);
      ctx.scale(stag.scale, stag.scale);

      fillCardWithShadow(ctx, -cw / 2, -ch / 2, cw, ch, 32, '#FFFFFF', 0.1);
      ctx.strokeStyle = hexToRgba(accent, 0.35);
      ctx.lineWidth = 3;
      drawRoundedRectPath(ctx, -cw / 2, -ch / 2, cw, ch, 32);
      ctx.stroke();

      // Tinted icon well
      ctx.fillStyle = hexToRgba(accent, 0.08);
      drawRoundedRectPath(ctx, -cw / 2 + 18, -ch / 2 + 18, cw - 36, 114, 22);
      ctx.fill();
      ctx.save();
      ctx.translate(0, -ch / 2 + 75);
      ctx.scale(0.68, 0.68);
      drawSceneIcon(ctx, nodeIcon);
      ctx.restore();

      ctx.font = `800 34px ${FONT_DISPLAY}`;
      ctx.fillStyle = accent;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(node.label, 0, 42, cw - 28);

      if (node.sublabel) {
        ctx.font = `600 22px ${FONT_SANS}`;
        ctx.fillStyle = '#64748B';
        ctx.fillText(node.sublabel, 0, 86, cw - 28);
      }
      ctx.restore();
    });
  } else if (props.variant === 'contrast-pair-cards') {
    const labels =
      props.data?.labels && props.data.labels.length >= 2
        ? props.data.labels.slice(0, 2)
        : ['Look', 'Watch'];
    const nodes = props.data?.nodes?.slice(0, 2);
    const leftTitle = nodes?.[0]?.label || labels[0];
    const rightTitle = nodes?.[1]?.label || labels[1];
    const leftSub = nodes?.[0]?.sublabel || '';
    const rightSub = nodes?.[1]?.sublabel || '';
    const leftColor = nodes?.[0]?.color || '#2563EB';
    const rightColor = nodes?.[1]?.color || '#D97706';
    const isSwapX = (props.data?.formula || 'cross').toLowerCase() !== 'arrow';

    const cw = 326;
    const ch = 224;
    const leftCx = -235;
    const rightCx = 235;

    // Left Card
    const s0 = computeStaggerItemState(elElapsed, 0, 0, 0.34);
    if (s0.visible) {
      ctx.save();
      ctx.globalAlpha *= s0.opacity;
      ctx.translate(leftCx, s0.translateY);
      ctx.scale(s0.scale, s0.scale);
      fillCardWithShadow(ctx, -cw / 2, -ch / 2, cw, ch, 34, '#FFFFFF', 0.1);
      ctx.strokeStyle = leftColor;
      ctx.lineWidth = 4;
      drawRoundedRectPath(ctx, -cw / 2, -ch / 2, cw, ch, 34);
      ctx.stroke();
      const fittedL = fitWrappedTextBlock(ctx, leftTitle, cw - 40, 120, {
        fontWeight: 800,
        maxFontSize: 52,
        minFontSize: 28,
        maxLines: 2,
      });
      ctx.font = `800 ${fittedL.fontSize}px ${FONT_DISPLAY}`;
      ctx.fillStyle = leftColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const lyBase = leftSub ? -18 : 0;
      fittedL.lines.forEach((ln, li) =>
        ctx.fillText(ln, 0, lyBase - ((fittedL.lines.length - 1) * fittedL.lineHeight) / 2 + li * fittedL.lineHeight, cw - 36),
      );
      if (leftSub) {
        ctx.font = `600 22px ${FONT_SANS}`;
        ctx.fillStyle = '#64748B';
        ctx.fillText(leftSub, 0, 56, cw - 36);
      }
      ctx.restore();
    }

    // Right Card
    const s1 = computeStaggerItemState(elElapsed, 1, 0.12, 0.34);
    if (s1.visible) {
      ctx.save();
      ctx.globalAlpha *= s1.opacity;
      ctx.translate(rightCx, s1.translateY);
      ctx.scale(s1.scale, s1.scale);
      fillCardWithShadow(ctx, -cw / 2, -ch / 2, cw, ch, 34, '#FFFFFF', 0.1);
      ctx.strokeStyle = rightColor;
      ctx.lineWidth = 4;
      drawRoundedRectPath(ctx, -cw / 2, -ch / 2, cw, ch, 34);
      ctx.stroke();
      const fittedR = fitWrappedTextBlock(ctx, rightTitle, cw - 40, 120, {
        fontWeight: 800,
        maxFontSize: 52,
        minFontSize: 28,
        maxLines: 2,
      });
      ctx.font = `800 ${fittedR.fontSize}px ${FONT_DISPLAY}`;
      ctx.fillStyle = rightColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const ryBase = rightSub ? -18 : 0;
      fittedR.lines.forEach((ln, li) =>
        ctx.fillText(ln, 0, ryBase - ((fittedR.lines.length - 1) * fittedR.lineHeight) / 2 + li * fittedR.lineHeight, cw - 36),
      );
      if (rightSub) {
        ctx.font = `600 22px ${FONT_SANS}`;
        ctx.fillStyle = '#64748B';
        ctx.fillText(rightSub, 0, 56, cw - 36);
      }
      ctx.restore();
    }

    // Central swap-cross or arrow badge
    ctx.save();
    if (isSwapX) {
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(0, 0, 44, -Math.PI * 0.85, -Math.PI * 0.15);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, 0, 44, Math.PI * 0.15, Math.PI * 0.85);
      ctx.stroke();
    }
    fillCardWithShadow(ctx, -28, -28, 56, 56, 28, isSwapX ? '#DC2626' : '#16A34A', 0.14);
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (isSwapX) {
      ctx.moveTo(-10, -10);
      ctx.lineTo(10, 10);
      ctx.moveTo(10, -10);
      ctx.lineTo(-10, 10);
    } else {
      ctx.moveTo(-12, 0);
      ctx.lineTo(12, 0);
      ctx.moveTo(2, -10);
      ctx.lineTo(12, 0);
      ctx.lineTo(2, 10);
    }
    ctx.stroke();
    ctx.restore();
  } else if (props.variant === 'quiz-fill-blank') {
    const pillTitle = props.data?.title || 'Question';
    const promptText = props.data?.speechText || "I can't ______ without my glasses.";
    const iconKind = props.data?.sceneIcon || 'glasses';

    fillCardWithShadow(ctx, -420, -142, 840, 284, 34, '#FFFFFF', 0.11);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -142, 840, 284, 34);
    ctx.stroke();

    // Top Question Pill
    ctx.font = `800 22px ${FONT_SANS}`;
    const qPillW = Math.min(280, Math.max(146, ctx.measureText(pillTitle).width + 44));
    ctx.fillStyle = '#EEF2FF';
    drawRoundedRectPath(ctx, -qPillW / 2, -118, qPillW, 42, 21);
    ctx.fill();
    ctx.fillStyle = '#4338CA';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(pillTitle, 0, -97, qPillW - 20);

    // Fill-in-the-blank prompt line(s)
    const fittedQ = fitWrappedTextBlock(ctx, promptText, 760, 88, {
      fontWeight: 700,
      fontFamily: FONT_DISPLAY,
      maxFontSize: 34,
      minFontSize: 22,
      maxLines: 2,
      lineHeightRatio: 1.24,
    });
    ctx.font = `700 ${fittedQ.fontSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    const qStartY = -28 - ((fittedQ.lines.length - 1) * fittedQ.lineHeight) / 2;
    fittedQ.lines.forEach((ln, li) => {
      const ly = qStartY + li * fittedQ.lineHeight;
      ctx.fillText(ln, 0, ly, 760);
      // Highlight blank underline nicely if ______ present
      const blankMatch = ln.match(/_{3,}/);
      if (blankMatch && blankMatch.index !== undefined) {
        const lineW = ctx.measureText(ln).width;
        const preW = ctx.measureText(ln.slice(0, blankMatch.index)).width;
        const bW = ctx.measureText(blankMatch[0]).width;
        const bx = -lineW / 2 + preW;
        ctx.strokeStyle = '#4F46E5';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(bx, ly + fittedQ.fontSize * 0.45);
        ctx.lineTo(bx + bW, ly + fittedQ.fontSize * 0.45);
        ctx.stroke();
      }
    });

    // Crisp vector icon below prompt
    ctx.fillStyle = '#F8FAFC';
    drawRoundedRectPath(ctx, -96, 30, 192, 92, 24);
    ctx.fill();
    ctx.save();
    ctx.translate(0, 76);
    ctx.scale(0.68, 0.68);
    drawSceneIcon(ctx, iconKind);
    ctx.restore();
  } else if (props.variant === 'airport-travel') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFFFF', 0.09);
    ctx.fillStyle = '#2563EB';
    drawRoundedRectPath(ctx, -370, -110, 740, 52, 26);
    ctx.fill();
    ctx.font = `800 24px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('BOARDING PASS', -334, -84);
    ctx.textAlign = 'right';
    ctx.fillText('GATE B12', 334, -84);

    ctx.save();
    ctx.translate(-210, 22);
    ctx.scale(0.85, 0.85);
    drawSceneIcon(ctx, 'airplane');
    ctx.restore();

    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'left';
    ctx.fillText(props.data?.title || 'At the Airport', -100, -4, 420);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText(props.data?.subtitle || 'Check-in · Boarding · Window seat', -100, 44, 420);
  } else if (props.variant === 'restaurant-order') {
    fillCardWithShadow(ctx, -370, -112, 740, 224, 34, '#FFFDF7', 0.09);
    ctx.save();
    ctx.translate(-220, 0);
    drawSceneIcon(ctx, 'menu');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#9A3412';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Ordering Food', -105, -24, 430);
    ctx.font = `600 25px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || '"Could I see the menu, please?"', -105, 28, 430);
  } else if (props.variant === 'shopping-price') {
    fillCardWithShadow(ctx, -370, -112, 740, 224, 34, '#FFFFFF', 0.09);
    ctx.save();
    ctx.translate(-225, 0);
    drawSceneIcon(ctx, 'shopping-bag');
    ctx.restore();
    ctx.save();
    ctx.translate(250, -32);
    ctx.scale(0.8, 0.8);
    drawSceneIcon(ctx, 'price-tag');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#BE185D';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Shopping & Price', -110, -14, 310);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || '"Can I try this on?"', -110, 34, 430);
  } else if (props.variant === 'doctor-health') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFFFF', 0.09);
    ctx.save();
    ctx.translate(-220, 0);
    drawSceneIcon(ctx, 'stethoscope');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#DC2626';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Health & Clinic', -110, -20, 440);
    ctx.font = `600 25px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || '"I have a slight headache."', -110, 30, 440);
  } else if (props.variant === 'weather-forecast') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#F0F9FF', 0.09);
    ctx.save();
    ctx.translate(-220, 0);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'sun');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0369A1';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Weather Forecast', -110, -20, 440);
    ctx.font = `600 25px ${FONT_SANS}`;
    ctx.fillStyle = '#334155';
    ctx.fillText(props.data?.speechText || "It's chilly & sunny outside", -110, 30, 440);
  } else if (props.variant === 'study-desk') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFFFF', 0.09);
    ctx.save();
    ctx.translate(-225, 0);
    drawSceneIcon(ctx, 'book');
    ctx.restore();
    ctx.save();
    ctx.translate(275, -18);
    ctx.scale(0.68, 0.68);
    drawSceneIcon(ctx, 'pencil');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#3730A3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Study & Practice', -110, -20, 340);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || 'Review notes every day', -110, 30, 400);
  } else if (props.variant === 'commute-transport') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFFFF', 0.09);
    ctx.save();
    ctx.translate(-210, -6);
    drawSceneIcon(ctx, props.data?.sceneIcon === 'car' ? 'car' : 'bus');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Daily Commute', -100, -20, 430);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || 'Catch the bus on time', -100, 30, 430);
  } else if (props.variant === 'home-routine') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFBEB', 0.09);
    ctx.save();
    ctx.translate(-215, 0);
    drawSceneIcon(ctx, 'home');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#92400E';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Home Routine', -105, -20, 430);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || 'Everyday daily habits', -105, 30, 430);
  } else if (props.variant === 'gym-fitness') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#FFFFFF', 0.09);
    ctx.save();
    ctx.translate(-215, 0);
    drawSceneIcon(ctx, 'dumbbell');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#1D4ED8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Workout & Habit', -105, -20, 430);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.speechText || 'Stay consistent daily', -105, 30, 430);
  } else if (props.variant === 'phone-call') {
    fillCardWithShadow(ctx, -370, -110, 740, 220, 34, '#0F172A', 0.22);
    ctx.save();
    ctx.translate(-220, 0);
    ctx.scale(0.75, 0.75);
    drawSceneIcon(ctx, 'phone');
    ctx.restore();
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#38BDF8';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'Incoming Call', -115, -20, 440);
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#CBD5E1';
    ctx.fillText(props.data?.speechText || '"Hold on, I’ll call you back"', -115, 30, 440);
  } else if (props.variant === 'tense-timeline') {
    const val = clamp01(props.data?.value ?? 0.5);
    const labels = props.data?.labels?.slice(0, 3) ?? ['Past', 'Present', 'Future'];
    fillCardWithShadow(ctx, -430, -112, 860, 224, 34, '#FFFFFF', 0.09);
    ctx.font = `700 22px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.fillText(props.data?.formula || 'TIME AXIS', 0, -76);
    const x0 = -300;
    const x1 = 300;
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(x0, -14);
    ctx.lineTo(x1, -14);
    ctx.stroke();
    const xs = [-260, 0, 260];
    const cols = ['#64748B', '#2563EB', '#7C3AED'];
    labels.forEach((lbl, i) => {
      const mx = xs[i];
      const active = Math.abs(val - i * 0.5) < 0.26;
      ctx.fillStyle = active ? cols[i] : '#E2E8F0';
      ctx.beginPath();
      ctx.arc(mx, -14, active ? 20 : 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = active ? cols[i] : '#475569';
      ctx.font = `${active ? 800 : 600} 26px ${FONT_DISPLAY}`;
      ctx.fillText(lbl, mx, 46, 200);
    });
  } else if (props.variant === 'degree-scale') {
    const steps = props.data?.labels?.slice(0, 3) ?? ['Basic', 'Stronger', 'Native!'];
    const cols = ['#64748B', '#0284C7', '#EAB308'];
    const useStacked = steps.some((s) => s.length > 14);
    if (useStacked) {
      fillCardWithShadow(ctx, -430, -138, 860, 276, 30, '#FFFFFF', 0.09);
      ctx.font = `800 26px ${FONT_SANS}`;
      ctx.fillStyle = '#334155';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(props.data?.title || 'Key Points', 0, -104, 780);
      steps.forEach((st, i) => {
        const ry = -62 + i * 64;
        const w = 360 + i * 210;
        ctx.fillStyle = cols[i % cols.length];
        drawRoundedRectPath(ctx, -w / 2, ry, w, 52, 16);
        ctx.fill();
        const fitted = fitWrappedTextBlock(ctx, st, w - 28, 44, {
          fontWeight: 800,
          maxFontSize: 26,
          minFontSize: 17,
          maxLines: 1,
        });
        ctx.font = `800 ${fitted.fontSize}px ${FONT_DISPLAY}`;
        ctx.fillStyle = i === 2 ? '#0F172A' : '#FFFFFF';
        ctx.fillText(fitted.lines[0] ?? st, 0, ry + 27, w - 24);
      });
    } else {
      fillCardWithShadow(ctx, -430, -124, 860, 248, 34, '#FFFFFF', 0.09);
      ctx.font = `800 26px ${FONT_SANS}`;
      ctx.fillStyle = '#334155';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(props.data?.title || 'Intensity Scale', 0, -88, 780);
      steps.forEach((st, i) => {
        const bx = -265 + i * 265;
        const barH = 56 + i * 28;
        ctx.fillStyle = cols[i % cols.length];
        drawRoundedRectPath(ctx, bx - 112, 74 - barH, 224, barH, 16);
        ctx.fill();
        const fitted = fitWrappedTextBlock(ctx, st, 200, Math.max(36, barH - 12), {
          fontWeight: 800,
          maxFontSize: 26,
          minFontSize: 16,
          maxLines: 2,
          lineHeightRatio: 1.12,
        });
        ctx.font = `800 ${fitted.fontSize}px ${FONT_DISPLAY}`;
        ctx.fillStyle = i === 2 ? '#0F172A' : '#FFFFFF';
        const ly = 74 - barH / 2 - ((fitted.lines.length - 1) * fitted.lineHeight) / 2;
        fitted.lines.forEach((ln, li) => ctx.fillText(ln, bx, ly + li * fitted.lineHeight, 204));
      });
    }
  } else if (props.variant === 'phrasal-split') {
    const parts = props.data?.labels?.slice(0, 2) ?? ['Verb', 'Particle'];
    fillCardWithShadow(ctx, -430, -116, 860, 232, 34, '#FFFFFF', 0.09);
    fillCardWithShadow(ctx, -370, -54, 240, 86, 24, '#DBEAFE', 0.05);
    ctx.font = `800 32px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#1D4ED8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const p0Lines = wrapTextLines(ctx, parts[0], 210).slice(0, 2);
    p0Lines.forEach((ln, li) => ctx.fillText(ln, -250, -11 - ((p0Lines.length - 1) * 32) / 2 + li * 32));
    ctx.fillStyle = '#64748B';
    ctx.fillText('+', -90, -11);
    fillCardWithShadow(ctx, -50, -54, 240, 86, 24, '#DCFCE7', 0.05);
    ctx.fillStyle = '#15803D';
    const p1Lines = wrapTextLines(ctx, parts[1], 210).slice(0, 2);
    p1Lines.forEach((ln, li) => ctx.fillText(ln, 70, -11 - ((p1Lines.length - 1) * 32) / 2 + li * 32));
    ctx.fillStyle = '#4F46E5';
    ctx.fillText('=', 228, -11);
    ctx.save();
    ctx.translate(325, -12);
    ctx.scale(0.65, 0.65);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'lightning');
    ctx.restore();
    ctx.font = `700 26px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.formula || 'New meaning!', 0, 74, 780);
  } else if (props.variant === 'idiom-split') {
    fillCardWithShadow(ctx, -430, -116, 860, 232, 34, '#FFFFFF', 0.09);
    ctx.fillStyle = '#FEF2F2';
    drawRoundedRectPath(ctx, -395, -72, 340, 144, 24);
    ctx.fill();
    ctx.font = `700 24px ${FONT_SANS}`;
    ctx.fillStyle = '#DC2626';
    ctx.textAlign = 'center';
    ctx.fillText('LITERAL', -225, -38);
    ctx.font = `800 28px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#7F1D1D';
    const litLines = wrapTextLines(ctx, props.data?.speechText || 'Word for word', 300).slice(0, 2);
    litLines.forEach((ln, li) => ctx.fillText(ln, -225, 16 - ((litLines.length - 1) * 30) / 2 + li * 30));

    ctx.fillStyle = '#64748B';
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillText('≠', 0, 0);

    ctx.fillStyle = '#F0FDF4';
    drawRoundedRectPath(ctx, 55, -72, 340, 144, 24);
    ctx.fill();
    ctx.font = `700 24px ${FONT_SANS}`;
    ctx.fillStyle = '#16A34A';
    ctx.fillText('MEANING', 225, -38);
    ctx.font = `800 28px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#14532D';
    const meanLines = wrapTextLines(ctx, props.data?.subtitle || 'Natural sense', 300).slice(0, 2);
    meanLines.forEach((ln, li) => ctx.fillText(ln, 225, 16 - ((meanLines.length - 1) * 30) / 2 + li * 30));
  } else if (props.variant === 'syllable-stress') {
    const syllables = props.data?.labels?.length ? props.data.labels.slice(0, 4) : ['re', 'CORD'];
    const stressedIdx = Math.min(syllables.length - 1, Math.max(0, Math.round(props.data?.value ?? 1)));
    fillCardWithShadow(ctx, -410, -116, 820, 232, 34, '#FFFFFF', 0.09);
    ctx.font = `700 24px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.fillText(props.data?.title || 'SYLLABLE STRESS', 0, -76, 760);
    const gap = Math.min(170, Math.floor(720 / Math.max(1, syllables.length)));
    const startX = -((syllables.length - 1) * gap) / 2;
    syllables.forEach((syl, idx) => {
      const sx = startX + idx * gap;
      const isStressed = idx === stressedIdx;
      ctx.fillStyle = isStressed ? '#4F46E5' : '#E2E8F0';
      ctx.beginPath();
      ctx.arc(sx, -12, isStressed ? 42 : 24, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `${isStressed ? 800 : 700} ${isStressed ? 28 : 24}px ${FONT_DISPLAY}`;
      ctx.fillStyle = isStressed ? '#312E81' : '#475569';
      ctx.fillText(syl, sx, 62, gap - 16);
    });
  } else if (props.variant === 'intonation-curve') {
    const rising = (props.data?.value ?? 0.8) >= 0.5;
    fillCardWithShadow(ctx, -410, -112, 820, 224, 34, '#FFFFFF', 0.09);
    ctx.font = `700 24px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.fillText(rising ? 'RISING INTONATION ↗' : 'FALLING INTONATION ↘', 0, -74);
    ctx.strokeStyle = rising ? '#2563EB' : '#10B981';
    ctx.lineWidth = 10;
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (rising) {
      ctx.moveTo(-260, 40);
      ctx.bezierCurveTo(-60, 36, 80, -34, 260, -40);
    } else {
      ctx.moveTo(-260, -34);
      ctx.bezierCurveTo(-60, -30, 80, 34, 260, 40);
    }
    ctx.stroke();
    ctx.font = `700 28px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.speechText || 'Watch the pitch flow!', 0, 74, 760);
  } else if (props.variant === 'bs-alert-tip') {
    // Callout / Alert Banner with left accent stripe, crisp dynamic tag pill & multi-line body
    const titleStr = props.data?.title || 'Key Note';
    const bodyStr = props.data?.speechText || props.data?.subtitle || '';
    const tagStr = (props.data?.highlightWord || props.data?.formula || '').trim();

    ctx.font = `800 34px ${FONT_DISPLAY}`;
    const titleLines = wrapTextLines(ctx, titleStr, 590).slice(0, 2);
    ctx.font = `600 30px ${FONT_DISPLAY}`;
    const bodyLines = bodyStr ? wrapTextLines(ctx, bodyStr, 590).slice(0, 3) : [];

    const tagH = tagStr ? 48 : 0;
    const contentH = tagH + titleLines.length * 42 + bodyLines.length * 38 + 52;
    const cardH = Math.max(224, contentH);
    const topY = -cardH / 2;

    fillCardWithShadow(ctx, -430, topY, 860, cardH, 24, '#EFF6FF', 0.08);
    ctx.strokeStyle = '#BFDBFE';
    ctx.lineWidth = 3;
    drawRoundedRectPath(ctx, -430, topY, 860, cardH, 24);
    ctx.stroke();
    // Left accent bar
    ctx.fillStyle = '#2563EB';
    drawRoundedRectPath(ctx, -430, topY, 18, cardH, 9);
    ctx.fill();
    // Icon circle
    ctx.fillStyle = '#DBEAFE';
    ctx.beginPath();
    ctx.arc(-336, 0, 52, 0, Math.PI * 2);
    ctx.fill();
    ctx.save();
    ctx.translate(-336, 0);
    ctx.scale(0.62, 0.62);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'sparkles');
    ctx.restore();

    let cursorY = topY + 30;
    if (tagStr) {
      ctx.font = `800 24px ${FONT_DISPLAY}`;
      const pillW = Math.min(420, Math.max(150, ctx.measureText(tagStr).width + 44));
      ctx.fillStyle = '#2563EB';
      drawRoundedRectPath(ctx, -252, cursorY, pillW, 42, 21);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tagStr, -252 + pillW / 2, cursorY + 21, pillW - 24);
      cursorY += 60;
    } else {
      cursorY += 12;
    }

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#1E3A8A';
    titleLines.forEach((ln) => {
      ctx.fillText(ln, -252, cursorY + 14, 595);
      cursorY += 42;
    });

    if (bodyLines.length > 0) {
      cursorY += 6;
      ctx.font = `600 30px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#334155';
      bodyLines.forEach((ln) => {
        ctx.fillText(ln, -252, cursorY + 14, 595);
        cursorY += 38;
      });
    }
  } else if (props.variant === 'bs-card-header') {
    // Card with Colored Header Bar + Multi-line Body (zero hardcoded English boilerplate)
    const headerStr = props.data?.formula || 'LESSON FOCUS';
    const titleStr = props.data?.title || 'Key Lesson';
    const subStr = props.data?.subtitle || props.data?.speechText || '';

    ctx.font = `800 38px ${FONT_DISPLAY}`;
    const titleLines = wrapTextLines(ctx, titleStr, 600).slice(0, 2);
    ctx.font = `600 30px ${FONT_DISPLAY}`;
    const subLines = subStr ? wrapTextLines(ctx, subStr, 600).slice(0, 3) : [];
    const textBlockH = titleLines.length * 46 + (subLines.length > 0 ? 8 + subLines.length * 38 : 0);
    const bodyH = textBlockH + 64;
    const cardH = Math.max(264, 72 + bodyH);
    const topY = -cardH / 2;

    fillCardWithShadow(ctx, -430, topY, 860, cardH, 26, '#FFFFFF', 0.1);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2.5;
    drawRoundedRectPath(ctx, -430, topY, 860, cardH, 26);
    ctx.stroke();

    // Top Header
    ctx.fillStyle = '#4F46E5';
    drawRoundedRectPath(ctx, -430, topY, 860, 72, 24);
    ctx.fill();
    ctx.fillRect(-430, topY + 46, 860, 26);
    ctx.font = `800 28px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(headerStr, -396, topY + 36, 540);

    if (props.data?.highlightWord) {
      ctx.font = `700 24px ${FONT_DISPLAY}`;
      const pillW = Math.min(250, Math.max(115, ctx.measureText(props.data.highlightWord).width + 36));
      ctx.fillStyle = 'rgba(255,255,255,0.22)';
      drawRoundedRectPath(ctx, 396 - pillW, topY + 17, pillW, 38, 19);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.fillText(props.data.highlightWord, 396 - pillW / 2, topY + 36, pillW - 20);
    }

    // Body icon
    const bodyCenterY = topY + 72 + (cardH - 72) / 2;
    ctx.save();
    ctx.translate(-338, bodyCenterY);
    ctx.scale(0.68, 0.68);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'book');
    ctx.restore();

    ctx.textAlign = 'left';
    let by = bodyCenterY - textBlockH / 2 + 22;
    ctx.font = `800 38px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    titleLines.forEach((ln) => {
      ctx.fillText(ln, -246, by, 606);
      by += 46;
    });
    if (subLines.length > 0) {
      by += 4;
      ctx.font = `600 30px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#475569';
      subLines.forEach((ln) => {
        ctx.fillText(ln, -246, by, 606);
        by += 38;
      });
    }
  } else if (props.variant === 'bs-progress-meter') {
    const targetPct = clamp01(props.data?.value ?? 0.78);
    const fillEase = easeOutQuint(clamp01((time - 0.08) / 0.65));
    const pct = targetPct * fillEase;
    const pctLabel = `${Math.round(targetPct * fillEase * 100)}%`;
    fillCardWithShadow(ctx, -420, -112, 840, 224, 28, '#FFFFFF', 0.09);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -112, 840, 224, 28);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `800 32px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'Progress', -376, -54, 580);

    // % Badge pill on right
    ctx.fillStyle = '#DCFCE7';
    drawRoundedRectPath(ctx, 250, -76, 126, 44, 22);
    ctx.fill();
    ctx.font = `800 26px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#15803D';
    ctx.textAlign = 'center';
    ctx.fillText(pctLabel, 313, -54);

    // Track
    const barX = -376;
    const barW = 752;
    const barY = -8;
    const barH = 42;
    ctx.fillStyle = '#E2E8F0';
    drawRoundedRectPath(ctx, barX, barY, barW, barH, 21);
    ctx.fill();

    const fillW = Math.max(48, barW * pct);
    const grad = ctx.createLinearGradient(barX, 0, barX + fillW, 0);
    grad.addColorStop(0, '#0D6EFD');
    grad.addColorStop(1, '#10B981');
    ctx.save();
    drawRoundedRectPath(ctx, barX, barY, fillW, barH, 21);
    ctx.clip();
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, fillW, barH);
    ctx.fillStyle = 'rgba(255,255,255,0.22)';
    const offset = (time * 36) % 36;
    for (let sx = barX - 40 + offset; sx < barX + fillW + 40; sx += 36) {
      ctx.beginPath();
      ctx.moveTo(sx, barY + barH);
      ctx.lineTo(sx + 16, barY);
      ctx.lineTo(sx + 30, barY);
      ctx.lineTo(sx + 14, barY + barH);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(props.data?.subtitle || '', -376, 68, 740);
  } else if (props.variant === 'bs-toast-notify') {
    // Floating Toast Notification with dynamic header & multi-line body
    fillCardWithShadow(ctx, -400, -120, 800, 240, 26, '#FFFFFF', 0.12);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -400, -120, 800, 240, 26);
    ctx.stroke();

    ctx.fillStyle = '#F8FAFC';
    drawRoundedRectPath(ctx, -400, -120, 800, 62, 24);
    ctx.fill();
    ctx.fillRect(-400, -80, 800, 22);
    ctx.fillStyle = '#10B981';
    drawRoundedRectPath(ctx, -366, -102, 28, 28, 8);
    ctx.fill();
    ctx.font = `800 24px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.formula || 'KEY TAKEAWAY', -324, -88, 520);
    ctx.font = `700 22px ${FONT_SANS}`;
    ctx.fillStyle = '#059669';
    ctx.textAlign = 'right';
    ctx.fillText(props.data?.highlightWord || '✓', 366, -88);

    ctx.strokeStyle = '#E2E8F0';
    ctx.beginPath();
    ctx.moveTo(-400, -58);
    ctx.lineTo(400, -58);
    ctx.stroke();

    ctx.save();
    ctx.translate(-310, 30);
    ctx.scale(0.6, 0.6);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'chat');
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.font = `800 32px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'Key Phrase', -225, -4, 590);
    ctx.font = `600 26px ${FONT_SANS}`;
    ctx.fillStyle = '#334155';
    const bodyLines = wrapTextLines(
      ctx,
      props.data?.speechText || props.data?.subtitle || '',
      590,
    ).slice(0, 2);
    bodyLines.forEach((ln, li) => ctx.fillText(ln, -225, 42 + li * 34));
  } else if (props.variant === 'bs-list-group') {
    const items = props.data?.labels?.slice(0, 3) ?? [
      'Listen to rhythm',
      'Repeat out loud',
      'Use in context',
    ];
    fillCardWithShadow(ctx, -415, -138, 830, 276, 26, '#FFFFFF', 0.09);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -415, -138, 830, 276, 26);
    ctx.stroke();

    items.forEach((row, i) => {
      const stag = computeStaggerItemState(elElapsed, i, 0.09, 0.34);
      if (!stag.visible) return;
      const ry = -88 + i * 88;
      ctx.save();
      ctx.globalAlpha *= stag.opacity;
      ctx.translate(0, stag.translateY);
      if (i === 1) {
        ctx.fillStyle = '#EFF6FF';
        drawRoundedRectPath(ctx, -400, ry - 36, 800, 72, 16);
        ctx.fill();
      }
      if (i > 0) {
        ctx.strokeStyle = '#F1F5F9';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(-395, ry - 44);
        ctx.lineTo(395, ry - 44);
        ctx.stroke();
      }
      ctx.fillStyle = i === 1 ? '#2563EB' : '#64748B';
      ctx.beginPath();
      ctx.arc(-352, ry, 22, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = `800 24px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${i + 1}`, -352, ry + 1);

      ctx.textAlign = 'left';
      ctx.font = `${i === 1 ? 800 : 700} 28px ${FONT_DISPLAY}`;
      ctx.fillStyle = i === 1 ? '#1D4ED8' : '#1E293B';
      const lines = wrapTextLines(ctx, row, 670).slice(0, 2);
      const lh = 30;
      const ly = ry - ((lines.length - 1) * lh) / 2;
      lines.forEach((ln, li) => ctx.fillText(ln, -308, ly + li * lh));
      ctx.restore();
    });
  } else if (props.variant === 'bs-pricing-tier') {
    const leftTxt = props.data?.labels?.[0] || 'Literal Style';
    const rightTxt = props.data?.labels?.[1] || 'Natural Fluency';

    fillCardWithShadow(ctx, -420, -118, 392, 236, 26, '#FFFFFF', 0.07);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -118, 392, 236, 26);
    ctx.stroke();
    ctx.fillStyle = '#F1F5F9';
    drawRoundedRectPath(ctx, -386, -88, 128, 36, 18);
    ctx.fill();
    ctx.font = `700 20px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('BASIC', -322, -70);
    ctx.font = `800 30px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#334155';
    const lLines = wrapTextLines(ctx, leftTxt, 340).slice(0, 2);
    lLines.forEach((ln, li) => ctx.fillText(ln, -224, -4 - ((lLines.length - 1) * 34) / 2 + li * 34, 344));
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText('✗ Literal', -224, 64, 340);

    fillCardWithShadow(ctx, 28, -126, 392, 252, 26, '#EEF2FF', 0.14);
    ctx.strokeStyle = '#4F46E5';
    ctx.lineWidth = 4;
    drawRoundedRectPath(ctx, 28, -126, 392, 252, 26);
    ctx.stroke();
    ctx.fillStyle = '#4F46E5';
    drawRoundedRectPath(ctx, 62, -98, 214, 38, 19);
    ctx.fill();
    ctx.font = `800 20px ${FONT_SANS}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText('★ RECOMMENDED', 169, -79, 196);
    ctx.font = `800 30px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#312E81';
    const rLines = wrapTextLines(ctx, rightTxt, 340).slice(0, 2);
    rLines.forEach((ln, li) => ctx.fillText(ln, 224, -6 - ((rLines.length - 1) * 34) / 2 + li * 34, 344));
    ctx.font = `700 24px ${FONT_SANS}`;
    ctx.fillStyle = '#15803D';
    ctx.fillText('✓ 100% Natural', 224, 66, 340);
  } else if (props.variant === 'bs-accordion-faq') {
    fillCardWithShadow(ctx, -420, -128, 840, 256, 26, '#FFFFFF', 0.09);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -128, 840, 256, 26);
    ctx.stroke();

    ctx.fillStyle = '#E0E7FF';
    drawRoundedRectPath(ctx, -420, -128, 840, 74, 24);
    ctx.fill();
    ctx.fillRect(-420, -78, 840, 24);
    ctx.font = `800 28px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#3730A3';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`Q: ${props.data?.title || 'Quick Question'}`, -386, -90, 700);
    ctx.textAlign = 'right';
    ctx.fillText('▲', 386, -90);

    ctx.textAlign = 'left';
    ctx.font = `600 26px ${FONT_SANS}`;
    ctx.fillStyle = '#1E293B';
    const ansText = props.data?.speechText || props.data?.subtitle || 'Clear explanation';
    const ansLines = wrapTextLines(ctx, ansText, 768).slice(0, 3);
    ansLines.forEach((ln, li) => ctx.fillText(ln, -386, -24 + li * 34, 768));
  } else if (props.variant === 'bs-breadcrumb-path') {
    const crumbs = props.data?.labels?.slice(0, 3) ?? ['Context', 'Pattern', 'Fluent!'];
    const useVertical = crumbs.some((c) => c.length > 12);
    if (useVertical) {
      fillCardWithShadow(ctx, -425, -138, 850, 276, 28, '#FFFFFF', 0.09);
      ctx.font = `800 24px ${FONT_SANS}`;
      ctx.fillStyle = '#475569';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(props.data?.title || 'KEY STEPS', 0, -106, 760);
      crumbs.forEach((c, i) => {
        const ry = -66 + i * 64;
        const active = i === crumbs.length - 1;
        ctx.fillStyle = active ? '#0D6EFD' : '#F1F5F9';
        drawRoundedRectPath(ctx, -385, ry, 770, 52, 18);
        ctx.fill();
        const fitted = fitWrappedTextBlock(ctx, `${i + 1}. ${c}`, 730, 44, {
          fontWeight: 800,
          maxFontSize: 28,
          minFontSize: 18,
          maxLines: 1,
        });
        ctx.font = `800 ${fitted.fontSize}px ${FONT_DISPLAY}`;
        ctx.fillStyle = active ? '#FFFFFF' : '#1E293B';
        ctx.fillText(fitted.lines[0] ?? `${i + 1}. ${c}`, 0, ry + 27, 730);
      });
    } else {
      fillCardWithShadow(ctx, -425, -104, 850, 208, 28, '#FFFFFF', 0.09);
      ctx.font = `700 24px ${FONT_SANS}`;
      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(props.data?.title || 'LEARNING PATHWAY', 0, -64, 720);

      const xs = [-260, 0, 260];
      crumbs.forEach((c, i) => {
        const cx = xs[i];
        const active = i === crumbs.length - 1;
        ctx.fillStyle = active ? '#0D6EFD' : '#F1F5F9';
        drawRoundedRectPath(ctx, cx - 108, -24, 216, 68, 34);
        ctx.fill();
        const fitted = fitWrappedTextBlock(ctx, c, 192, 56, {
          fontWeight: 800,
          maxFontSize: 26,
          minFontSize: 16,
          maxLines: 2,
          lineHeightRatio: 1.15,
        });
        ctx.font = `800 ${fitted.fontSize}px ${FONT_DISPLAY}`;
        ctx.fillStyle = active ? '#FFFFFF' : '#334155';
        const ly = 10 - ((fitted.lines.length - 1) * fitted.lineHeight) / 2;
        fitted.lines.forEach((ln, li) => ctx.fillText(ln, cx, ly + li * fitted.lineHeight, 196));
        if (i < crumbs.length - 1) {
          ctx.font = `800 28px ${FONT_SANS}`;
          ctx.fillStyle = '#94A3B8';
          ctx.fillText('›', cx + 130, 10);
        }
      });
    }
  } else if (props.variant === 'css-bento-stats') {
    const tiles = [
      { bg: '#EEF2FF', fg: '#4338CA', num: '01', lbl: props.data?.labels?.[0] || 'Core Word' },
      { bg: '#ECFDF5', fg: '#047857', num: '02', lbl: props.data?.labels?.[1] || 'Tone Check' },
      { bg: '#FFF7ED', fg: '#C2410C', num: '03', lbl: props.data?.labels?.[2] || 'Practice' },
      { bg: '#FDF2F8', fg: '#BE185D', num: '★', lbl: props.data?.title || 'Example' },
    ];
    const coords = [
      [-420, -132],
      [12, -132],
      [-420, 10],
      [12, 10],
    ];
    tiles.forEach((tile, i) => {
      const stag = computeStaggerItemState(elElapsed, i, 0.075, 0.34);
      if (!stag.visible) return;
      const [tx, ty] = coords[i];
      ctx.save();
      ctx.globalAlpha *= stag.opacity;
      ctx.translate(tx + 204, ty + 61 + stag.translateY);
      ctx.scale(stag.scale, stag.scale);
      fillCardWithShadow(ctx, -204, -61, 408, 122, 22, tile.bg, 0.06);
      ctx.fillStyle = tile.fg;
      drawRoundedRectPath(ctx, -204 + 16, -61 + 33, 56, 56, 16);
      ctx.fill();
      ctx.font = `800 24px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(tile.num, -204 + 44, -61 + 62);
      ctx.textAlign = 'left';
      ctx.fillStyle = '#0F172A';
      ctx.font = `800 26px ${FONT_DISPLAY}`;
      const lines = wrapTextLines(ctx, tile.lbl, 298).slice(0, 2);
      const lh = 30;
      const ly = -61 + 62 - ((lines.length - 1) * lh) / 2;
      lines.forEach((ln, li) => ctx.fillText(ln, -204 + 88, ly + li * lh));
      ctx.restore();
    });
  } else if (props.variant === 'css-glass-quote') {
    const grad = ctx.createLinearGradient(-420, -124, 420, 124);
    grad.addColorStop(0, 'rgba(99, 102, 241, 0.16)');
    grad.addColorStop(1, 'rgba(236, 72, 153, 0.14)');
    fillCardWithShadow(ctx, -420, -124, 840, 248, 32, 'rgba(255,255,255,0.86)', 0.12);
    ctx.fillStyle = grad;
    drawRoundedRectPath(ctx, -420, -124, 840, 248, 32);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.92)';
    ctx.lineWidth = 4;
    ctx.stroke();

    ctx.font = `800 84px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#6366F1';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('“', -382, -52);

    ctx.textAlign = 'center';
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    const qLines = wrapTextLines(
      ctx,
      props.data?.speechText || props.data?.title || 'Speak clearly, connect naturally.',
      680,
    ).slice(0, 2);
    qLines.forEach((ln, li) => ctx.fillText(ln, 0, -24 + li * 40));

    if (props.data?.subtitle) {
      ctx.font = `700 24px ${FONT_SANS}`;
      const subW = Math.min(640, Math.max(240, ctx.measureText(props.data.subtitle).width + 44));
      ctx.fillStyle = '#FFFFFF';
      drawRoundedRectPath(ctx, -subW / 2, 50, subW, 46, 23);
      ctx.fill();
      ctx.fillStyle = '#4F46E5';
      ctx.fillText(props.data.subtitle, 0, 74);
    }
  } else if (props.variant === 'css-chat-thread') {
    fillCardWithShadow(ctx, -420, -132, 840, 264, 30, '#F8FAFC', 0.08);
    const s0 = computeStaggerItemState(elElapsed, 0, 0.0, 0.34);
    if (s0.visible) {
      ctx.save();
      ctx.globalAlpha *= s0.opacity;
      ctx.translate(0, s0.translateY);
      fillCardWithShadow(ctx, -382, -104, 620, 88, 24, '#FFFFFF', 0.06);
      ctx.font = `600 26px ${FONT_SANS}`;
      ctx.fillStyle = '#334155';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const l0 = wrapTextLines(ctx, props.data?.labels?.[0] || 'A: "Excuse me?"', 560).slice(0, 2);
      l0.forEach((ln, li) => ctx.fillText(ln, -352, -60 - ((l0.length - 1) * 30) / 2 + li * 30));
      ctx.restore();
    }

    const s1 = computeStaggerItemState(elElapsed, 1, 0.22, 0.36);
    if (s1.visible) {
      ctx.save();
      ctx.globalAlpha *= s1.opacity;
      ctx.translate(0, s1.translateY);
      fillCardWithShadow(ctx, -238, 12, 620, 90, 24, '#4F46E5', 0.14);
      ctx.font = `700 26px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#FFFFFF';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const l1 = wrapTextLines(ctx, props.data?.labels?.[1] || 'B: "Go right ahead!"', 560).slice(0, 2);
      l1.forEach((ln, li) => ctx.fillText(ln, -208, 57 - ((l1.length - 1) * 30) / 2 + li * 30));
      ctx.restore();
    }
  } else if (props.variant === 'css-roadmap-steps') {
    const steps = props.data?.labels?.slice(0, 3) ?? ['Spot It', 'Practice', 'Master'];
    const cols = ['#2563EB', '#7C3AED', '#10B981'];
    const isLong = steps.some((s) => s.length > 13);
    if (isLong) {
      fillCardWithShadow(ctx, -425, -138, 850, 276, 28, '#FFFFFF', 0.09);
      steps.forEach((lbl, i) => {
        const stag = computeStaggerItemState(elElapsed, i, 0.10, 0.34);
        if (!stag.visible) return;
        const ry = -84 + i * 84;
        ctx.save();
        ctx.globalAlpha *= stag.opacity;
        ctx.translate(0, stag.translateY);
        ctx.fillStyle = cols[i % cols.length];
        ctx.beginPath();
        ctx.arc(-350, ry, 24, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `800 24px ${FONT_DISPLAY}`;
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`0${i + 1}`, -350, ry + 1);
        ctx.font = `800 30px ${FONT_DISPLAY}`;
        ctx.fillStyle = '#0F172A';
        ctx.textAlign = 'left';
        const lines = wrapTextLines(ctx, lbl, 680).slice(0, 2);
        const lh = 32;
        const ly = ry - ((lines.length - 1) * lh) / 2;
        lines.forEach((ln, li) => ctx.fillText(ln, -304, ly + li * lh));
        ctx.restore();
      });
    } else {
      fillCardWithShadow(ctx, -425, -116, 850, 232, 30, '#FFFFFF', 0.09);
      const lineGrow = easeOutQuint(clamp01(elElapsed / 0.55));
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 8;
      ctx.beginPath();
      ctx.moveTo(-260, -34);
      ctx.lineTo(-260 + 520 * lineGrow, -34);
      ctx.stroke();

      const xs = [-260, 0, 260];
      steps.forEach((lbl, i) => {
        const stag = computeStaggerItemState(elElapsed, i, 0.10, 0.36);
        if (!stag.visible) return;
        const sx = xs[i];
        ctx.save();
        ctx.globalAlpha *= stag.opacity;
        ctx.translate(sx, stag.translateY);
        ctx.scale(stag.scale, stag.scale);
        ctx.fillStyle = cols[i];
        ctx.beginPath();
        ctx.arc(0, -34, 32, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = `800 26px ${FONT_DISPLAY}`;
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`0${i + 1}`, 0, -33);

        ctx.font = `800 28px ${FONT_DISPLAY}`;
        ctx.fillStyle = '#0F172A';
        const lines = wrapTextLines(ctx, lbl, 224).slice(0, 2);
        lines.forEach((ln, li) => ctx.fillText(ln, 0, 38 + li * 32));
        ctx.restore();
      });
    }
  } else if (props.variant === 'css-toggle-switch') {
    const isOn = (props.data?.value ?? 1) >= 0.5;
    const toggleSlide = isOn ? easeOutQuint(clamp01((elElapsed - 0.12) / 0.42)) : 0;
    fillCardWithShadow(ctx, -415, -112, 830, 224, 30, '#FFFFFF', 0.09);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `700 24px ${FONT_SANS}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText(props.data?.labels?.[0] || 'OFF', -370, -48, 460);
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'ON · Native Mode', -370, 22, 460);

    const tx = 140;
    const ty = -46;
    ctx.fillStyle = toggleSlide > 0.5 ? '#10B981' : '#CBD5E1';
    drawRoundedRectPath(ctx, tx, ty, 224, 92, 46);
    ctx.fill();
    const knobX = tx + 48 + (176 - 48) * toggleSlide;
    ctx.save();
    ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
    ctx.shadowBlur = 12;
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(knobX, ty + 46, 36, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    ctx.font = `800 24px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.fillText(toggleSlide > 0.5 ? 'ON' : 'OFF', toggleSlide > 0.5 ? tx + 86 : tx + 140, ty + 48);
  } else if (props.variant === 'css-browser-mockup') {
    // Modern Browser Window Card with macOS Dots + URL bar + Clear Multi-line Reading Context
    const bodyText =
      props.data?.speechText ||
      props.data?.subtitle ||
      'Reading context';
    const bodyFontPx = bodyText.length > 145 ? 30 : 32;
    const bodyLineH = Math.round(bodyFontPx * 1.28);
    ctx.font = `600 ${bodyFontPx}px ${FONT_DISPLAY}`;
    const wrappedBody = wrapTextLines(ctx, bodyText, 760);
    const displayLines = wrappedBody.slice(0, 7);
    const titleStr = props.data?.title || 'Reading Context';
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    const titleLines = wrapTextLines(ctx, titleStr, 760).slice(0, 2);
    const cardH = Math.max(250, 90 + titleLines.length * 42 + displayLines.length * bodyLineH + 38);
    const cardTop = -Math.round(cardH / 2);

    fillCardWithShadow(ctx, -430, cardTop, 860, cardH, 24, '#FFFFFF', 0.11);
    ctx.strokeStyle = '#E2E8F0';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -430, cardTop, 860, cardH, 24);
    ctx.stroke();

    // Top chrome bar
    ctx.fillStyle = '#F1F5F9';
    drawRoundedRectPath(ctx, -430, cardTop, 860, 58, 22);
    ctx.fill();
    ctx.fillRect(-430, cardTop + 34, 860, 24);

    const dots = ['#EF4444', '#F59E0B', '#10B981'];
    dots.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(-388 + i * 26, cardTop + 29, 8, 0, Math.PI * 2);
      ctx.fill();
    });

    ctx.fillStyle = '#FFFFFF';
    drawRoundedRectPath(ctx, -270, cardTop + 11, 580, 36, 18);
    ctx.fill();
    ctx.font = `700 22px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.formula || 'Reading Context', 20, cardTop + 29, 550);

    let cy = cardTop + 92;
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    titleLines.forEach((tln) => {
      ctx.fillText(tln, 0, cy, 768);
      cy += 42;
    });

    cy += 8;
    ctx.font = `600 ${bodyFontPx}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#1E293B';
    displayLines.forEach((ln, idx) => {
      const lineTxt =
        idx === displayLines.length - 1 && wrappedBody.length > displayLines.length
          ? `${ln.slice(0, Math.max(8, ln.length - 3))}...`
          : ln;
      ctx.fillText(lineTxt, 0, cy + idx * bodyLineH, 768);
    });
  } else if (props.variant === 'css-grammar-equation') {
    const parts = props.data?.labels?.slice(0, 3) ?? ['Could you', 'V-inf', 'Polite!'];
    fillCardWithShadow(ctx, -430, -118, 860, 236, 30, '#FFFFFF', 0.09);
    ctx.font = `700 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.title || 'PATTERN', 0, -78, 760);

    const boxes = [
      { x: -395, w: 220, bg: '#DBEAFE', fg: '#1D4ED8', txt: parts[0] },
      { x: -115, w: 220, bg: '#FEF3C7', fg: '#B45309', txt: parts[1] },
      { x: 165, w: 230, bg: '#DCFCE7', fg: '#15803D', txt: parts[2] },
    ];
    boxes.forEach((b) => {
      ctx.fillStyle = b.bg;
      drawRoundedRectPath(ctx, b.x, -30, b.w, 96, 22);
      ctx.fill();
      ctx.font = `800 26px ${FONT_DISPLAY}`;
      ctx.fillStyle = b.fg;
      const bLines = wrapTextLines(ctx, b.txt, b.w - 20).slice(0, 2);
      const lh = 28;
      const ly = 18 - ((bLines.length - 1) * lh) / 2;
      bLines.forEach((ln, li) => ctx.fillText(ln, b.x + b.w / 2, ly + li * lh));
    });
    ctx.font = `800 32px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText('+', -145, 18);
    ctx.fillText('=', 135, 18);
  } else if (props.variant === 'css-flashcard-flip') {
    fillCardWithShadow(ctx, -340, -124, 680, 224, 28, '#E0E7FF', 0.06);
    fillCardWithShadow(ctx, -370, -104, 740, 224, 28, '#FFFFFF', 0.12);
    ctx.strokeStyle = '#C7D2FE';
    ctx.lineWidth = 2.5;
    drawRoundedRectPath(ctx, -370, -104, 740, 224, 28);
    ctx.stroke();

    ctx.fillStyle = '#EEF2FF';
    drawRoundedRectPath(ctx, -115, -82, 230, 36, 18);
    ctx.fill();
    ctx.font = `800 20px ${FONT_SANS}`;
    ctx.fillStyle = '#4338CA';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.data?.formula || 'FLASHCARD', 0, -64, 210);

    ctx.font = `800 42px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.title || 'commute', 0, -4, 660);
    ctx.font = `600 26px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    const subLines = wrapTextLines(
      ctx,
      props.data?.subtitle || props.data?.speechText || '',
      660,
    ).slice(0, 2);
    subLines.forEach((ln, li) => ctx.fillText(ln, 0, 52 + li * 32, 660));
  } else if (props.variant === 'css-sticky-note') {
    ctx.save();
    ctx.rotate(-0.018);
    fillCardWithShadow(ctx, -375, -124, 750, 248, 22, '#FEF9C3', 0.12);
    ctx.strokeStyle = '#FDE047';
    ctx.lineWidth = 2.5;
    drawRoundedRectPath(ctx, -375, -124, 750, 248, 22);
    ctx.stroke();

    ctx.fillStyle = '#FDE047';
    ctx.beginPath();
    ctx.moveTo(315, 124);
    ctx.lineTo(375, 68);
    ctx.lineTo(315, 68);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = '#EF4444';
    ctx.beginPath();
    ctx.arc(0, -112, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FCA5A5';
    ctx.beginPath();
    ctx.arc(-5, -116, 5, 0, Math.PI * 2);
    ctx.fill();

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = `800 22px ${FONT_SANS}`;
    ctx.fillStyle = '#B45309';
    ctx.fillText(props.data?.formula || 'QUICK NOTE', 0, -68, 620);

    const stickyTitle = fitWrappedTextBlock(ctx, props.data?.title || 'Remember', 660, 60, {
      fontWeight: 800,
      maxFontSize: 36,
      minFontSize: 22,
      maxLines: 1,
    });
    ctx.font = `800 ${stickyTitle.fontSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#1E293B';
    ctx.fillText(stickyTitle.lines[0] ?? 'Remember', 0, -6, 660);

    ctx.font = `600 26px ${FONT_SANS}`;
    ctx.fillStyle = '#334155';
    const rawSub = props.data?.subtitle || props.data?.speechText || '';
    const wrappedSub = wrapTextLines(ctx, rawSub, 630).slice(0, 2);
    const subStartY = wrappedSub.length === 2 ? 44 : 58;
    wrappedSub.forEach((line, idx) => {
      ctx.fillText(line, 0, subStartY + idx * 32, 630);
    });
    ctx.restore();
  } else if (props.variant === 'bs-badge-cluster') {
    const pills = props.data?.labels?.slice(0, 3) ?? ['Phrase 1', 'Phrase 2', 'Phrase 3'];
    const useStacked = pills.some((p) => p.length > 14);
    const palette = [
      { bg: '#DBEAFE', fg: '#1D4ED8' },
      { bg: '#DCFCE7', fg: '#15803D' },
      { bg: '#EDE9FE', fg: '#6D28D9' },
    ];
    if (useStacked) {
      fillCardWithShadow(ctx, -420, -142, 840, 284, 28, '#FFFFFF', 0.1);
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 2;
      drawRoundedRectPath(ctx, -420, -142, 840, 284, 28);
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 28px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#0F172A';
      ctx.fillText(props.data?.title || 'KEY HIGHLIGHTS', 0, -104, 760);

      pills.forEach((txt, i) => {
        const col = palette[i % palette.length];
        const py = -68 + i * 64;
        ctx.fillStyle = col.bg;
        drawRoundedRectPath(ctx, -380, py, 760, 52, 22);
        ctx.fill();
        const fitted = fitWrappedTextBlock(ctx, txt, 720, 44, {
          fontWeight: 800,
          maxFontSize: 28,
          minFontSize: 18,
          maxLines: 1,
        });
        ctx.font = `800 ${fitted.fontSize}px ${FONT_DISPLAY}`;
        ctx.fillStyle = col.fg;
        ctx.fillText(fitted.lines[0] ?? txt, 0, py + 27, 720);
      });
    } else {
      fillCardWithShadow(ctx, -420, -124, 840, 248, 28, '#FFFFFF', 0.1);
      ctx.strokeStyle = '#E2E8F0';
      ctx.lineWidth = 2;
      drawRoundedRectPath(ctx, -420, -124, 840, 248, 28);
      ctx.stroke();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = `800 28px ${FONT_DISPLAY}`;
      ctx.fillStyle = '#0F172A';
      ctx.fillText(props.data?.title || 'KEY HIGHLIGHTS', 0, -72, 740);

      const xs = pills.length === 2 ? [-195, 195] : [-258, 0, 258];
      const pw = pills.length === 2 ? 330 : 236;
      pills.forEach((txt, i) => {
        const col = palette[i % palette.length];
        ctx.fillStyle = col.bg;
        drawRoundedRectPath(ctx, xs[i] - pw / 2, -20, pw, 80, 36);
        ctx.fill();
        const fitted = fitWrappedTextBlock(ctx, txt, pw - 24, 68, {
          fontWeight: 800,
          maxFontSize: 26,
          minFontSize: 16,
          maxLines: 2,
          lineHeightRatio: 1.15,
        });
        ctx.font = `800 ${fitted.fontSize}px ${FONT_DISPLAY}`;
        ctx.fillStyle = col.fg;
        fitted.lines.forEach((ln, li) =>
          ctx.fillText(ln, xs[i], 20 - ((fitted.lines.length - 1) * fitted.lineHeight) / 2 + li * fitted.lineHeight, pw - 20),
        );
      });

      if (props.data?.subtitle) {
        ctx.font = `600 24px ${FONT_SANS}`;
        ctx.fillStyle = '#475569';
        ctx.fillText(props.data.subtitle, 0, 90, 740);
      }
    }
  } else if (props.variant === 'css-magnifying-word') {
    fillCardWithShadow(ctx, -420, -122, 840, 244, 28, '#FFFFFF', 0.1);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -420, -122, 840, 244, 28);
    ctx.stroke();

    ctx.fillStyle = '#EEF2FF';
    ctx.beginPath();
    ctx.arc(-270, -6, 66, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#4F46E5';
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-222, 42);
    ctx.lineTo(-190, 74);
    ctx.stroke();

    ctx.save();
    ctx.translate(-270, -6);
    ctx.scale(0.58, 0.58);
    drawSceneIcon(ctx, props.data?.sceneIcon || 'eye');
    ctx.restore();

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `800 22px ${FONT_SANS}`;
    ctx.fillStyle = '#4F46E5';
    ctx.fillText(props.data?.formula || 'KEY FOCUS', -160, -64, 520);

    ctx.font = `800 36px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    ctx.fillText(props.data?.highlightWord || props.data?.title || 'Spotlight', -160, -4, 540);

    ctx.font = `600 26px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    const subLines = wrapTextLines(
      ctx,
      props.data?.subtitle || props.data?.speechText || '',
      540,
    ).slice(0, 2);
    subLines.forEach((ln, li) => ctx.fillText(ln, -160, 48 + li * 32, 540));
  } else if (props.variant === 'bs-modal-quiz') {
    fillCardWithShadow(ctx, -415, -130, 830, 260, 26, '#FFFFFF', 0.13);
    ctx.strokeStyle = '#CBD5E1';
    ctx.lineWidth = 2;
    drawRoundedRectPath(ctx, -415, -130, 830, 260, 26);
    ctx.stroke();

    ctx.fillStyle = '#1E1B4B';
    drawRoundedRectPath(ctx, -415, -130, 830, 62, 24);
    ctx.fill();
    ctx.fillRect(-415, -90, 830, 22);
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `800 24px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillText(props.data?.formula || 'QUICK CHECK', -380, -98, 560);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#A5B4FC';
    ctx.fillText('✕', 380, -98);

    ctx.textAlign = 'center';
    const qText = props.data?.title || props.data?.speechText || 'Quick Question';
    const fittedQ = fitWrappedTextBlock(ctx, qText, 760, 74, {
      fontWeight: 800,
      maxFontSize: 32,
      minFontSize: 20,
      maxLines: 2,
      lineHeightRatio: 1.18,
    });
    ctx.font = `800 ${fittedQ.fontSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#0F172A';
    const qY = -16 - ((fittedQ.lines.length - 1) * fittedQ.lineHeight) / 2;
    fittedQ.lines.forEach((ln, li) => ctx.fillText(ln, 0, qY + li * fittedQ.lineHeight, 760));

    const optA = props.data?.labels?.[0] || 'A';
    const optB = props.data?.labels?.[1] || 'B';
    ctx.fillStyle = '#EEF2FF';
    drawRoundedRectPath(ctx, -370, 38, 350, 62, 18);
    ctx.fill();
    ctx.fillStyle = '#ECFDF5';
    drawRoundedRectPath(ctx, 20, 38, 350, 62, 18);
    ctx.fill();

    const fittedA = fitWrappedTextBlock(ctx, optA, 324, 52, {
      fontWeight: 800,
      maxFontSize: 26,
      minFontSize: 16,
      maxLines: 2,
      lineHeightRatio: 1.15,
    });
    ctx.font = `800 ${fittedA.fontSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#4338CA';
    const aY = 70 - ((fittedA.lines.length - 1) * fittedA.lineHeight) / 2;
    fittedA.lines.forEach((ln, li) => ctx.fillText(ln, -195, aY + li * fittedA.lineHeight, 324));

    const fittedB = fitWrappedTextBlock(ctx, optB, 324, 52, {
      fontWeight: 800,
      maxFontSize: 26,
      minFontSize: 16,
      maxLines: 2,
      lineHeightRatio: 1.15,
    });
    ctx.font = `800 ${fittedB.fontSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#15803D';
    const bY = 70 - ((fittedB.lines.length - 1) * fittedB.lineHeight) / 2;
    fittedB.lines.forEach((ln, li) => ctx.fillText(ln, 195, bY + li * fittedB.lineHeight, 324));
  } else if (props.variant === 'dynamic-scene' && props.data?.dynamicScene) {
    drawDynamicScene(ctx, props.data.dynamicScene, time);
  } else {
    // pronunciation-wave
    const bars = 9;
    for (let i = 0; i < bars; i++) {
      const pulse = 0.35 + 0.65 * Math.abs(Math.sin(time * 4.5 + i * 0.6));
      const bh = 120 * pulse;
      ctx.fillStyle = i % 3 === 0 ? '#EA580C' : i % 3 === 1 ? '#2563EB' : '#DB2777';
      drawRoundedRectPath(ctx, -160 + i * 38, -bh / 2, 22, bh, 11);
      ctx.fill();
    }
  }

  if (attachExtraLabels && props.data?.labels) {
    drawProminentLabelsStrip(ctx, props.data.labels, 128, 840);
  }

  ctx.restore();
}

function drawDynamicScene(
  ctx: CanvasRenderingContext2D,
  spec: DynamicSceneSpec,
  time: number,
) {
  const motifs = spec.motifs?.length
    ? spec.motifs.slice(0, 3)
    : [{ icon: 'sparkles' as IllustrationSceneIcon, label: 'Key Focus', accent: '#4F46E5' }];

  if (spec.layout === 'split-compare' && motifs.length >= 2) {
    fillCardWithShadow(ctx, -430, -124, 860, 248, 34, '#FFFFFF', 0.09);
    if (spec.badgeText) {
      ctx.font = `700 22px ${FONT_SANS}`;
      ctx.fillStyle = '#64748B';
      ctx.textAlign = 'center';
      ctx.fillText(spec.badgeText, 0, -90);
    }
    const left = motifs[0];
    const right = motifs[1];
    const leftAccent = left.accent || '#DC2626';
    const rightAccent = right.accent || '#16A34A';

    // Left panel
    ctx.fillStyle = '#FEF2F2';
    drawRoundedRectPath(ctx, -395, -56, 336, 154, 24);
    ctx.fill();
    ctx.save();
    ctx.translate(-227, -4);
    ctx.scale(0.55, 0.55);
    drawSceneIcon(ctx, left.icon);
    ctx.restore();
    ctx.font = `800 26px ${FONT_DISPLAY}`;
    ctx.fillStyle = leftAccent;
    ctx.textAlign = 'center';
    ctx.fillText(left.label, -227, 68, 300);

    // Connector
    ctx.font = `800 34px ${FONT_DISPLAY}`;
    ctx.fillStyle = '#64748B';
    ctx.fillText(
      spec.connector === 'vs' ? 'VS' : spec.connector === 'equals' ? '=' : spec.connector === 'plus' ? '+' : '→',
      0,
      14,
    );

    // Right panel
    ctx.fillStyle = '#F0FDF4';
    drawRoundedRectPath(ctx, 59, -56, 336, 154, 24);
    ctx.fill();
    ctx.save();
    ctx.translate(227, -4);
    ctx.scale(0.55, 0.55);
    drawSceneIcon(ctx, right.icon);
    ctx.restore();
    ctx.font = `800 26px ${FONT_DISPLAY}`;
    ctx.fillStyle = rightAccent;
    ctx.fillText(right.label, 227, 68, 300);
    return;
  }

  if (spec.layout === 'triple-card-grid') {
    const gap = 22;
    const count = Math.max(2, Math.min(3, motifs.length));
    const cw = count === 2 ? 370 : 272;
    const startX = -((count * cw + (count - 1) * gap) / 2);
    motifs.slice(0, count).forEach((m, i) => {
      const cx = startX + i * (cw + gap) + cw / 2;
      fillCardWithShadow(ctx, cx - cw / 2, -110, cw, 220, 28, '#FFFFFF', 0.09);
      ctx.save();
      ctx.translate(cx, -32);
      ctx.scale(0.62, 0.62);
      drawSceneIcon(ctx, m.icon);
      ctx.restore();
      ctx.font = `800 28px ${FONT_DISPLAY}`;
      ctx.fillStyle = m.accent || '#2563EB';
      ctx.textAlign = 'center';
      ctx.fillText(m.label, cx, 52, cw - 28);
      if (m.sublabel) {
        ctx.font = `600 20px ${FONT_SANS}`;
        ctx.fillStyle = '#64748B';
        ctx.fillText(m.sublabel, cx, 86, cw - 28);
      }
    });
    return;
  }

  // Hero icon formula / default dynamic composer
  const hero = motifs[0];
  fillCardWithShadow(ctx, -380, -116, 760, 232, 34, '#FFFFFF', 0.09);
  ctx.save();
  ctx.translate(-225, 0);
  const pulseScale = 0.86 + Math.sin(time * 2.5) * 0.03;
  ctx.scale(pulseScale, pulseScale);
  drawSceneIcon(ctx, hero.icon);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  if (spec.badgeText) {
    ctx.font = `700 20px ${FONT_SANS}`;
    ctx.fillStyle = hero.accent || '#4F46E5';
    ctx.fillText(spec.badgeText.toUpperCase(), -100, -52, 430);
  }
  ctx.font = `800 34px ${FONT_DISPLAY}`;
  ctx.fillStyle = '#0F172A';
  ctx.fillText(spec.headline || hero.label, -100, 0, 440);
  if (spec.formula || spec.subtext || hero.sublabel) {
    ctx.font = `600 24px ${FONT_SANS}`;
    ctx.fillStyle = '#475569';
    ctx.fillText(spec.formula || spec.subtext || hero.sublabel || '', -100, 48, 440);
  }
}

function drawSentenceCard(
  ctx: CanvasRenderingContext2D,
  props: SentenceCardProps,
  width: number,
  elElapsed = 1,
) {
  const safeWidth = Math.max(260, width);
  const innerMaxW = Math.max(180, safeWidth - 88);
  const textLen = props.text.trim().length;
  const widthScale = Math.min(1, safeWidth / 760);
  const baseHeadFont = textLen > 95 ? 36 : textLen > 52 ? 40 : 46;
  const maxHeadFont = Math.max(22, Math.round(baseHeadFont * widthScale));

  const fittedHead = fitWrappedTextBlock(ctx, props.text, innerMaxW, 380, {
    fontWeight: 700,
    maxFontSize: maxHeadFont,
    minFontSize: 20,
    maxLines: 6,
    lineHeightRatio: 1.28,
  });
  const headFontSize = fittedHead.fontSize;
  const lineH = fittedHead.lineHeight;
  const lines = fittedHead.lines;

  const subFontSize = Math.max(19, Math.round(30 * widthScale));
  const subLineH = Math.round(subFontSize * 1.26);
  const fittedSub = props.subtext
    ? fitWrappedTextBlock(ctx, props.subtext, innerMaxW, 190, {
        fontWeight: 600,
        maxFontSize: subFontSize,
        minFontSize: 16,
        maxLines: 5,
        lineHeightRatio: 1.26,
      })
    : null;
  const subLines = fittedSub ? fittedSub.lines : [];
  const actualSubFont = fittedSub ? fittedSub.fontSize : subFontSize;
  const actualSubLineH = fittedSub ? fittedSub.lineHeight : subLineH;
  const subH = subLines.length > 0 ? subLines.length * actualSubLineH + 18 : 0;
  const stampPad = props.stampText ? 18 : 0;
  const cardH = Math.max(156, lines.length * lineH + subH + 74 + stampPad);
  const x = -safeWidth / 2;
  const y = -cardH / 2;

  const cardBg = props.bgColor || '#FFFFFF';
  const isDarkBg =
    cardBg !== '#FFFFFF' &&
    (cardBg.startsWith('#0') ||
      cardBg.startsWith('#1') ||
      cardBg.startsWith('#2') ||
      cardBg.includes('rgba') ||
      cardBg.includes('15, 23, 42'));
  const defaultTextColor = props.textColor || (isDarkBg ? '#F8FAFC' : '#0F172A');

  fillCardWithShadow(ctx, x, y, safeWidth, cardH, 38, cardBg, isDarkBg ? 0.3 : 0.1);
  ctx.save();
  ctx.strokeStyle = isDarkBg ? 'rgba(148, 163, 184, 0.24)' : 'rgba(226, 232, 240, 0.95)';
  ctx.lineWidth = 2;
  drawRoundedRectPath(ctx, x, y, safeWidth, cardH, 38);
  ctx.stroke();
  ctx.restore();

  // Clip text inside the card boundary so no oversized token ever bleeds outside
  ctx.save();
  drawRoundedRectPath(ctx, x + 10, y + 8, safeWidth - 20, cardH - 16, 30);
  ctx.clip();

  // Render lines with optional emphasis word + kinetic highlight pill sweep
  ctx.font = `700 ${headFontSize}px ${FONT_DISPLAY}`;
  ctx.textBaseline = 'middle';
  const totalContentH = (lines.length - 1) * lineH + subH;
  const startTextY = y + (cardH - stampPad * 0.45) / 2 - totalContentH / 2;
  const emphasisLower = props.emphasisWord?.trim().toLowerCase();
  const emphColor = props.emphasisColor || (isDarkBg ? '#FACC15' : '#2563EB');
  const sweepProgress = easeOutQuint(clamp01((elElapsed - 0.1) / 0.38));

  lines.forEach((line, lineIdx) => {
    const lineY = startTextY + lineIdx * lineH;
    if (emphasisLower && line.toLowerCase().includes(emphasisLower)) {
      const lower = line.toLowerCase();
      const idx = lower.indexOf(emphasisLower);
      const before = line.slice(0, idx);
      const match = line.slice(idx, idx + emphasisLower.length);
      const after = line.slice(idx + emphasisLower.length);

      const beforeW = before ? ctx.measureText(before).width : 0;
      const matchW = ctx.measureText(match).width;
      const afterW = after ? ctx.measureText(after).width : 0;
      const pillPadX = 12;
      const gapL = before ? 4 : 0;
      const gapR = after ? 4 : 0;
      const totalW = beforeW + gapL + pillPadX * 2 + matchW + gapR + afterW;
      const fitScaleX = totalW > innerMaxW ? innerMaxW / totalW : 1;

      ctx.save();
      if (fitScaleX < 1) {
        ctx.scale(fitScaleX, 1);
      }
      let cursorX = -totalW / 2;
      ctx.textAlign = 'left';

      if (before) {
        ctx.fillStyle = defaultTextColor;
        ctx.fillText(before, cursorX, lineY);
        cursorX += beforeW + gapL;
      }

      const pillW = matchW + pillPadX * 2;
      const pillH = Math.round(headFontSize * 1.24);
      const revealW = Math.max(16, pillW * sweepProgress);
      ctx.fillStyle = hexToRgba(emphColor, isDarkBg ? 0.26 : 0.14);
      drawRoundedRectPath(ctx, cursorX, lineY - pillH / 2, revealW, pillH, 12);
      ctx.fill();

      ctx.fillStyle = emphColor;
      ctx.fillText(match, cursorX + pillPadX, lineY);
      cursorX += pillW + gapR;

      if (after) {
        ctx.fillStyle = defaultTextColor;
        ctx.fillText(after, cursorX, lineY);
      }
      ctx.restore();
    } else {
      ctx.textAlign = 'center';
      ctx.fillStyle = defaultTextColor;
      ctx.fillText(line, 0, lineY, innerMaxW);
    }
  });

  if (subLines.length > 0) {
    ctx.font = `600 ${actualSubFont}px ${FONT_DISPLAY}`;
    ctx.textAlign = 'center';
    ctx.fillStyle = isDarkBg ? '#94A3B8' : '#475569';
    const subStartY = startTextY + (lines.length - 1) * lineH + Math.round(lineH * 0.88);
    subLines.forEach((sLn, sIdx) => {
      ctx.fillText(sLn, 0, subStartY + sIdx * actualSubLineH, innerMaxW);
    });
  }
  ctx.restore();

  // Top-right badge (check, cross, or question) with crisp white halo ring
  if (props.badge === 'check' || props.badge === 'cross' || props.badge === 'question') {
    const bx = x + safeWidth - 18;
    const by = y + 10;
    ctx.save();
    ctx.fillStyle =
      props.badge === 'check' ? '#16A34A' : props.badge === 'cross' ? '#DC2626' : '#4F46E5';
    ctx.beginPath();
    ctx.arc(bx, by, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 4;
    ctx.stroke();
    if (props.badge === 'question') {
      ctx.fillStyle = '#FFFFFF';
      ctx.font = `800 34px ${FONT_DISPLAY}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', bx, by + 1);
    } else {
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      if (props.badge === 'check') {
        ctx.moveTo(bx - 12, by + 1);
        ctx.lineTo(bx - 3, by + 10);
        ctx.lineTo(bx + 13, by - 9);
      } else {
        ctx.moveTo(bx - 10, by - 10);
        ctx.lineTo(bx + 10, by + 10);
        ctx.moveTo(bx + 10, by - 10);
        ctx.lineTo(bx - 10, by + 10);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  // Optional stamp (e.g., RUDE / AVOID) — neatly inset with crisp white border so it never clips
  if (props.stampText) {
    ctx.save();
    ctx.font = `800 24px ${FONT_DISPLAY}`;
    const pillW = Math.min(
      Math.max(116, safeWidth - 56),
      Math.max(126, ctx.measureText(props.stampText).width + 32),
    );
    const stampX = x + safeWidth - Math.max(82, pillW / 2 + 26);
    ctx.translate(stampX, y + cardH - 18);
    ctx.rotate(-0.07);
    ctx.fillStyle = props.stampColor || '#DC2626';
    drawRoundedRectPath(ctx, -pillW / 2, -22, pillW, 44, 12);
    ctx.fill();
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(props.stampText, 0, 1, pillW - 22);
    ctx.restore();
  }
}

function drawToneMeter(
  ctx: CanvasRenderingContext2D,
  props: ToneMeterProps,
  width: number,
  time: number,
) {
  const span = Math.max(0.1, props.animateEnd - props.animateStart);
  const progress = clamp01((time - props.animateStart) / span);
  const eased = easeInOutCubic(progress);
  const value = props.valueStart + (props.valueEnd - props.valueStart) * eased;

  // Gradient bar
  const barW = Math.max(220, width);

  // Title
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `700 24px ${FONT_SANS}`;
  ctx.fillStyle = '#64748B';
  ctx.fillText(props.title, 0, -48, barW);

  const barH = 22;
  const grad = ctx.createLinearGradient(-barW / 2, 0, barW / 2, 0);
  grad.addColorStop(0, '#DC2626');
  grad.addColorStop(0.5, '#F59E0B');
  grad.addColorStop(1, '#16A34A');

  ctx.fillStyle = grad;
  drawRoundedRectPath(ctx, -barW / 2, -barH / 2, barW, barH, barH / 2);
  ctx.fill();

  // Thumb
  const thumbX = -barW / 2 + barW * clamp01(value);
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.2)';
  ctx.shadowBlur = 16;
  ctx.fillStyle = '#FFFFFF';
  ctx.beginPath();
  ctx.arc(thumbX, 0, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = value < 0.38 ? '#DC2626' : value > 0.65 ? '#16A34A' : '#F59E0B';
  ctx.stroke();
  ctx.restore();

  // Labels
  const labelMaxW = Math.max(80, barW * 0.44);
  ctx.font = `700 28px ${FONT_SANS}`;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#DC2626';
  ctx.fillText(props.leftLabel, -barW / 2, 48, labelMaxW);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#16A34A';
  ctx.fillText(props.rightLabel, barW / 2, 48, labelMaxW);
}

function drawWordStack(
  ctx: CanvasRenderingContext2D,
  props: WordStackProps,
  width: number,
  time: number,
) {
  const safeWidth = Math.max(280, width);
  const rowH = 128;
  const gap = 28;
  const totalH = props.rows.length * rowH + (props.rows.length - 1) * gap;
  const startY = -totalH / 2;

  props.rows.forEach((row, idx) => {
    if (time < row.appearAt) return;
    const p = clamp01((time - row.appearAt) / 0.34);
    const eased = easeOutQuint(p);
    const scale = 0.9 + 0.1 * eased;
    const slideY = (1 - eased) * 24;

    ctx.save();
    ctx.globalAlpha *= easeOutCubic(p);
    ctx.translate(0, startY + idx * (rowH + gap) + rowH / 2 + slideY);
    ctx.scale(scale, scale);

    fillCardWithShadow(ctx, -safeWidth / 2, -rowH / 2, safeWidth, rowH, 34, '#FFFFFF', 0.09);

    let phoneticW = 0;
    const maxPhoneticW = Math.round(safeWidth * 0.32);
    if (row.phonetic) {
      ctx.font = `600 30px ${FONT_SANS}`;
      phoneticW = Math.min(maxPhoneticW, ctx.measureText(row.phonetic).width) + 28;
    }

    const availMainW = Math.max(140, safeWidth - 112 - phoneticW);
    let mainFontSize = 66;
    while (mainFontSize > 26) {
      ctx.font = `800 ${mainFontSize}px ${FONT_DISPLAY}`;
      const w = ctx.measureText(row.prefix).width + ctx.measureText(row.suffix).width;
      if (w <= availMainW) break;
      mainFontSize -= 2;
    }

    ctx.font = `800 ${mainFontSize}px ${FONT_DISPLAY}`;
    ctx.textBaseline = 'middle';
    const prefixW = ctx.measureText(row.prefix).width;
    const suffixW = ctx.measureText(row.suffix).width;
    const fullW = prefixW + suffixW;
    const fitScaleX = fullW > availMainW ? availMainW / fullW : 1;
    const leftX = row.phonetic ? -safeWidth / 2 + 56 : -(fullW * fitScaleX) / 2;

    ctx.save();
    ctx.translate(leftX, 0);
    if (fitScaleX < 1) {
      ctx.scale(fitScaleX, 1);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = '#0F172A';
    ctx.fillText(row.prefix, 0, 0);
    ctx.fillStyle = row.suffixColor;
    ctx.fillText(row.suffix, prefixW, 0);
    ctx.restore();

    if (row.phonetic) {
      ctx.font = `600 30px ${FONT_SANS}`;
      ctx.textAlign = 'right';
      ctx.fillStyle = '#64748B';
      ctx.fillText(row.phonetic, safeWidth / 2 - 48, 2, maxPhoneticW);
    }

    ctx.restore();
  });
}

function adjustHex(hex: string, factor: number): string {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) || 0;
  const g = parseInt(full.slice(2, 4), 16) || 0;
  const b = parseInt(full.slice(4, 6), 16) || 0;
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const nr = factor >= 1 ? clamp(r + (255 - r) * (factor - 1)) : clamp(r * factor);
  const ng = factor >= 1 ? clamp(g + (255 - g) * (factor - 1)) : clamp(g * factor);
  const nb = factor >= 1 ? clamp(b + (255 - b) * (factor - 1)) : clamp(b * factor);
  return `rgb(${nr}, ${ng}, ${nb})`;
}

function drawShape3D(
  ctx: CanvasRenderingContext2D,
  props: Shape3DProps,
  width: number,
  height: number,
  elElapsed = 1,
) {
  const x = -width / 2;
  const y = -height / 2;
  const depth = Math.max(0, props.depth ?? 10);
  const darkFill = adjustHex(props.fill, 0.72);
  const lightEdge = adjustHex(props.fill, 1.35);

  if (props.shapeType === 'cube_3d') {
    const s = Math.min(width, height) * 0.48;
    const topY = -s * 0.95;
    const midY = -s * 0.42;
    const botY = s * 0.58;
    const sideY = s * 0.08;

    ctx.save();
    if (props.shadow) {
      ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
      ctx.shadowBlur = 26;
      ctx.shadowOffsetY = 18;
    }
    // Left face (medium)
    ctx.fillStyle = props.fill;
    ctx.beginPath();
    ctx.moveTo(-s * 0.92, sideY - s * 0.48);
    ctx.lineTo(0, midY);
    ctx.lineTo(0, botY + s * 0.42);
    ctx.lineTo(-s * 0.92, sideY + s * 0.48);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    // Right face (dark)
    ctx.fillStyle = darkFill;
    ctx.beginPath();
    ctx.moveTo(0, midY);
    ctx.lineTo(s * 0.92, sideY - s * 0.48);
    ctx.lineTo(s * 0.92, sideY + s * 0.48);
    ctx.lineTo(0, botY + s * 0.42);
    ctx.closePath();
    ctx.fill();

    // Top face (bright)
    ctx.fillStyle = adjustHex(props.fill, 1.25);
    ctx.beginPath();
    ctx.moveTo(0, topY);
    ctx.lineTo(s * 0.92, sideY - s * 0.48);
    ctx.lineTo(0, midY);
    ctx.lineTo(-s * 0.92, sideY - s * 0.48);
    ctx.closePath();
    ctx.fill();

    if (props.highlight) {
      ctx.strokeStyle = 'rgba(255,255,255,0.55)';
      ctx.lineWidth = 4;
      ctx.stroke();
    }
  } else if (props.shapeType === 'staircase_3d') {
    const steps = 3;
    const gap = 16;
    const stepW = (width - gap * (steps - 1)) / steps;
    const labels = props.stepLabels ?? ['Step 1', 'Step 2', 'Step 3'];

    for (let i = 0; i < steps; i++) {
      const stag = computeStaggerItemState(elElapsed, i, 0.1, 0.38);
      if (!stag.visible) continue;
      const ratio = 0.45 + i * 0.27;
      const sh = Math.max(40, height * ratio * (0.28 + 0.72 * stag.progress));
      const sx = x + i * (stepW + gap);
      const sy = y + height - sh;

      ctx.save();
      ctx.globalAlpha *= stag.opacity;

      // Extruded depth
      if (depth > 0) {
        ctx.fillStyle = darkFill;
        drawRoundedRectPath(ctx, sx, sy + depth, stepW, sh, 18);
        ctx.fill();
      }
      fillCardWithShadow(ctx, sx, sy, stepW, sh, 18, props.fill, props.shadow ? 0.25 : 0);

      // Top highlight face
      if (props.highlight) {
        ctx.fillStyle = lightEdge;
        drawRoundedRectPath(ctx, sx + 4, sy + 2, stepW - 8, 14, 7);
        ctx.fill();
      }

      const label = labels[i];
      if (label) {
        const stepMaxW = Math.max(60, stepW - 22);
        const fitted = fitWrappedTextBlock(ctx, label, stepMaxW, Math.max(28, sh - 16), {
          fontWeight: 800,
          maxFontSize: 28,
          minFontSize: 15,
          maxLines: 2,
          lineHeightRatio: 1.2,
        });
        ctx.fillStyle = props.textColor || '#FFFFFF';
        ctx.font = `800 ${fitted.fontSize}px ${FONT_DISPLAY}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const ly = sy + sh / 2 - ((fitted.lines.length - 1) * fitted.lineHeight) / 2;
        fitted.lines.forEach((ln, li) =>
          ctx.fillText(ln, sx + stepW / 2, ly + li * fitted.lineHeight, stepMaxW),
        );
      }
      ctx.restore();
    }
    return;
  } else {
    const radius =
      props.shapeType === 'pill_3d'
        ? height / 2
        : props.shapeType === 'rect_3d'
          ? 12
          : Math.min(props.cornerRadius ?? 28, height / 2);

    if (props.shadow) {
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.45)';
      ctx.shadowBlur = 32;
      ctx.shadowOffsetX = 6;
      ctx.shadowOffsetY = 16 + depth;
      ctx.fillStyle = darkFill;
      drawRoundedRectPath(ctx, x, y + depth, width, height, radius);
      ctx.fill();
      ctx.restore();
    }

    if (depth > 0) {
      ctx.fillStyle = darkFill;
      drawRoundedRectPath(ctx, x, y + depth, width, height, radius);
      ctx.fill();
    }

    // Specular 3D face gradient for crisp depth
    const faceGrad = ctx.createLinearGradient(x, y, x, y + height);
    faceGrad.addColorStop(0, adjustHex(props.fill, 1.14));
    faceGrad.addColorStop(0.55, props.fill);
    faceGrad.addColorStop(1, adjustHex(props.fill, 0.88));
    ctx.fillStyle = faceGrad;
    drawRoundedRectPath(ctx, x, y, width, height, radius);
    ctx.fill();

    if (props.highlight) {
      ctx.save();
      ctx.strokeStyle = lightEdge;
      ctx.lineWidth = 4;
      drawRoundedRectPath(ctx, x + 2, y + 2, width - 4, height - 4, Math.max(4, radius - 2));
      ctx.stroke();
      ctx.restore();
    }
  }

  // Render attached text content
  if (props.textContent) {
    const sizeMap = {
      display: 64,
      headline: 48,
      body: 36,
      caption: 28,
      label: 24,
    };
    const weightMap = {
      regular: 400,
      medium: 500,
      bold: 700,
      black: 800,
    };
    const fSize = sizeMap[props.textSize ?? 'headline'];
    const fWeight = weightMap[props.textWeight ?? 'bold'];
    const textMaxW = Math.max(80, width - 52);
    const textMaxH = Math.max(40, height - 20);
    const fitted = fitWrappedTextBlock(ctx, props.textContent, textMaxW, textMaxH, {
      fontWeight: fWeight,
      maxFontSize: fSize,
      minFontSize: 18,
      maxLines: 5,
      lineHeightRatio: 1.22,
    });
    ctx.font = `${fWeight} ${fitted.fontSize}px ${FONT_DISPLAY}`;
    ctx.fillStyle = props.textColor || '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const startY = -((fitted.lines.length - 1) * fitted.lineHeight) / 2;
    fitted.lines.forEach((ln, idx) => {
      ctx.fillText(ln, 0, startY + idx * fitted.lineHeight, textMaxW);
    });
  }
}

function drawKaraokeCard(
  ctx: CanvasRenderingContext2D,
  props: KaraokeCardProps,
  width: number,
  time: number,
  renderOpts?: {
    subtitleConfig?: SubtitleDisplayConfig;
    stageW?: number;
    stageH?: number;
    compositionId?: LayoutCompositionId;
    hasDarkStage?: boolean;
  },
) {
  const words = props.words;
  if (words.length === 0) return;

  const stageW = renderOpts?.stageW ?? STAGE_WIDTH;
  const stageH = renderOpts?.stageH ?? STAGE_HEIGHT;
  const subCfg = renderOpts?.subtitleConfig;
  const isPlain = renderOpts?.compositionId === 'plain' || props.variant === 'plain-shadow';
  const isYellowPill = props.variant === 'yellow-pill';
  const boxStyle = subCfg?.boxStyle ?? (isPlain ? 'clean' : 'card');
  const isCleanBox = boxStyle === 'clean' && !isYellowPill;
  const isDarkBar = props.variant === 'dark-bar' || isPlain;

  const minDim = Math.min(stageW, stageH);
  const defaultSize = isPlain ? 'lg' : 'md';
  const sizeKey = subCfg?.size ?? defaultSize;
  const sizeMul =
    sizeKey === 'sm' ? 0.78 : sizeKey === 'lg' ? 1.24 : sizeKey === 'xl' ? 1.48 : 1.0;

  const maxAllowedW = Math.max(320, Math.round(stageW * (isCleanBox ? 0.88 : 0.92)));
  const safeWidth = Math.min(maxAllowedW, Math.max(width, isCleanBox ? Math.round(stageW * 0.82) : width));
  const maxLineW = Math.max(220, isCleanBox ? safeWidth - 36 : safeWidth - 104);

  const hasHelperNote = Boolean(props.helperText?.trim());
  const baseFont =
    stageW >= 1600
      ? Math.round(minDim * (hasHelperNote && (subCfg?.position ?? 'bottom') !== 'center' ? 0.041 : 0.046))
      : Math.round(minDim * 0.043);
  let fontSize = Math.max(26, Math.min(88, Math.round(baseFont * sizeMul)));

  while (fontSize > 24) {
    ctx.font = `700 ${fontSize}px ${FONT_DISPLAY}`;
    const hasWideWord = words.some((tok) => ctx.measureText(tok.word).width > maxLineW);
    if (!hasWideWord) break;
    fontSize -= 2;
  }
  ctx.font = `700 ${fontSize}px ${FONT_DISPLAY}`;
  const asciiSpaceW = Math.max(12, ctx.measureText(' ').width * 1.42);
  const isCjkOnly = (s: string) => /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/.test(s) && !/[A-Za-z0-9]/.test(s);
  const gapBetween = (a: string, b: string) => (isCjkOnly(a) && isCjkOnly(b) ? 3 : asciiSpaceW);

  // Build wrapped lines of WordTiming tokens
  const allLines: { tokens: typeof words; lineWidth: number }[] = [];
  let currentLine: typeof words = [];
  let currentW = 0;

  for (const token of words) {
    const wWidth = ctx.measureText(token.word).width;
    const prevWord = currentLine.length > 0 ? currentLine[currentLine.length - 1].word : null;
    const sep = prevWord ? gapBetween(prevWord, token.word) : 0;
    const nextW = currentLine.length === 0 ? wWidth : currentW + sep + wWidth;
    if (nextW > maxLineW && currentLine.length > 0) {
      allLines.push({ tokens: currentLine, lineWidth: currentW });
      currentLine = [token];
      currentW = wWidth;
    } else {
      currentLine.push(token);
      currentW = nextW;
    }
  }
  if (currentLine.length > 0) {
    allLines.push({ tokens: currentLine, lineWidth: currentW });
  }

  // Group into pages (up to 3 lines when centered/clean so multi-clause sentences breathe naturally)
  const linesPerPage = isPlain && (subCfg?.position ?? 'center') === 'center' ? 3 : 2;
  const pages: { tokens: typeof words; lineWidth: number }[][] = [];
  for (let i = 0; i < allLines.length; i += linesPerPage) {
    pages.push(allLines.slice(i, i + linesPerPage));
  }

  let activePageIdx = 0;
  if (pages.length > 1) {
    const foundIdx = pages.findIndex((page) => {
      const first = page[0]?.tokens[0];
      const lastLine = page[page.length - 1];
      const last = lastLine?.tokens[lastLine.tokens.length - 1];
      return first && last && time <= last.end + 0.02;
    });
    activePageIdx = foundIdx === -1 ? pages.length - 1 : foundIdx;
  }

  const lines = pages[activePageIdx] ?? allLines.slice(0, linesPerPage);
  const activeMaxLineW = Math.max(160, ...lines.map((l) => l.lineWidth));
  const pillW = Math.min(safeWidth, Math.max(300, Math.round(activeMaxLineW + 104)));
  const lineH = Math.round(fontSize * 1.38);

  // Optional helper text below the karaoke line (vocab meanings, grammar note, or source prompt in Plain mode)
  const helperLines: string[] = [];
  const helperFontSize = Math.max(20, Math.round(fontSize * 0.54));
  const helperLineH = Math.round(helperFontSize * 1.38);
  const helperGap = Math.max(28, Math.round(fontSize * 0.5));
  if (props.helperText?.trim()) {
    ctx.font = `600 ${helperFontSize}px ${FONT_SANS}`;
    const rawParas = props.helperText.trim().split(/\r?\n/);
    const maxHelperW = Math.max(240, maxLineW);
    for (const para of rawParas) {
      const pWords = para.trim().split(/\s+/).filter(Boolean);
      let lineBuf = '';
      for (const pw of pWords) {
        const candidate = lineBuf ? `${lineBuf} ${pw}` : pw;
        if (ctx.measureText(candidate).width <= maxHelperW) {
          lineBuf = candidate;
        } else {
          if (lineBuf) helperLines.push(lineBuf);
          lineBuf = pw;
        }
      }
      if (lineBuf) helperLines.push(lineBuf);
      if (helperLines.length >= 4) break;
    }
  }
  const helperBlockH =
    helperLines.length > 0 ? helperGap + helperLines.slice(0, 4).length * helperLineH : 0;

  const mainTextH = lines.length * lineH;
  const totalContentH = mainTextH + helperBlockH;
  const cardH = Math.max(112, totalContentH + (isCleanBox ? 32 : 56));
  const cardRadius = isYellowPill
    ? 28
    : boxStyle === 'pill' && lines.length === 1 && helperLines.length === 0
      ? Math.round(cardH / 2)
      : isDarkBar
        ? 28
        : lines.length === 1 && helperLines.length === 0
          ? Math.round(cardH / 2)
          : 34;
  const x = -pillW / 2;
  const y = -cardH / 2;

  if (!isCleanBox) {
    if (isYellowPill) {
      const yGrad = ctx.createLinearGradient(x, y, x, y + cardH);
      yGrad.addColorStop(0, '#FDE047');
      yGrad.addColorStop(1, '#FACC15');
      ctx.save();
      ctx.shadowColor = 'rgba(15, 23, 42, 0.18)';
      ctx.shadowBlur = 24;
      ctx.shadowOffsetY = 8;
      ctx.fillStyle = yGrad;
      drawRoundedRectPath(ctx, x, y, pillW, cardH, cardRadius);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = '#EAB308';
      ctx.lineWidth = 2.5;
      drawRoundedRectPath(ctx, x, y, pillW, cardH, cardRadius);
      ctx.stroke();
      ctx.restore();
    } else {
      fillCardWithShadow(
        ctx,
        x,
        y,
        pillW,
        cardH,
        cardRadius,
        isDarkBar ? 'rgba(15, 23, 42, 0.84)' : '#FFFFFF',
        isDarkBar ? 0.28 : 0.11,
      );
      ctx.save();
      ctx.strokeStyle = isDarkBar ? 'rgba(148, 163, 184, 0.28)' : '#E2E8F0';
      ctx.lineWidth = 2;
      drawRoundedRectPath(ctx, x, y, pillW, cardH, cardRadius);
      ctx.stroke();
      ctx.restore();
    }
  }

  ctx.font = `700 ${fontSize}px ${FONT_DISPLAY}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  const startY = -totalContentH / 2 + lineH / 2;

  const useDarkBackdropInk = renderOpts?.hasDarkStage ?? true;
  const isLightClean = isCleanBox && !useDarkBackdropInk;

  const activeWordColor = isCleanBox
    ? isLightClean
      ? props.activeColor === '#FACC15' || props.activeColor === '#93C5FD'
        ? '#4F46E5'
        : props.activeColor
      : props.activeColor === '#2563EB' || props.activeColor === '#16A34A'
        ? '#FACC15'
        : props.activeColor
    : props.activeColor;
  const spokenWordColor = isCleanBox
    ? isLightClean
      ? '#0F172A'
      : '#FFFFFF'
    : props.spokenColor;
  const inactiveWordColor = isCleanBox
    ? isLightClean
      ? 'rgba(51, 65, 85, 0.58)'
      : 'rgba(241, 245, 249, 0.82)'
    : props.inactiveColor;

  lines.forEach((line, lineIdx) => {
    let cursorX = -line.lineWidth / 2;
    const lineY = startY + lineIdx * lineH;

    line.tokens.forEach((token, tIdx) => {
      const isActive = time >= token.start && time <= token.end;
      const isSpoken = time > token.end;
      const tokenW = ctx.measureText(token.word).width;

      if (isCleanBox) {
        ctx.save();
        if (isLightClean) {
          ctx.shadowColor = 'rgba(255, 255, 255, 0.65)';
          ctx.shadowBlur = 8;
          ctx.shadowOffsetY = 1;
        } else {
          ctx.shadowColor = 'rgba(2, 6, 23, 0.85)';
          ctx.shadowBlur = 12;
          ctx.shadowOffsetY = 3;
          ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.065));
          ctx.strokeStyle = 'rgba(2, 6, 23, 0.62)';
        }
        if (isActive) {
          ctx.translate(cursorX + tokenW / 2, lineY);
          ctx.scale(1.06, 1.06);
          ctx.textAlign = 'center';
          if (!isLightClean) ctx.strokeText(token.word, 0, 0);
          ctx.fillStyle = token.highlightColor || activeWordColor;
          ctx.fillText(token.word, 0, 0);
        } else {
          if (!isLightClean) ctx.strokeText(token.word, cursorX, lineY);
          ctx.fillStyle = isSpoken ? spokenWordColor : inactiveWordColor;
          ctx.fillText(token.word, cursorX, lineY);
        }
        ctx.restore();
      } else if (isActive) {
        ctx.save();
        ctx.fillStyle = token.highlightColor || activeWordColor;
        ctx.translate(cursorX + tokenW / 2, lineY);
        ctx.scale(1.04, 1.04);
        ctx.textAlign = 'center';
        ctx.fillText(token.word, 0, 0);
        ctx.restore();
      } else {
        ctx.fillStyle = isSpoken ? spokenWordColor : inactiveWordColor;
        ctx.fillText(token.word, cursorX, lineY);
      }

      const nextTok = line.tokens[tIdx + 1];
      cursorX += tokenW + (nextTok ? gapBetween(token.word, nextTok.word) : 0);
    });
  });

  if (helperLines.length > 0) {
    ctx.save();
    ctx.font = `600 ${helperFontSize}px ${FONT_SANS}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const helperStartY =
      startY + (lines.length - 1) * lineH + lineH * 0.5 + helperGap + helperLineH / 2;
    helperLines.slice(0, 4).forEach((hl, hIdx) => {
      const hy = helperStartY + hIdx * helperLineH;
      if (isCleanBox) {
        if (isLightClean) {
          ctx.fillStyle = '#475569';
        } else {
          ctx.shadowColor = 'rgba(2, 6, 23, 0.88)';
          ctx.shadowBlur = 8;
          ctx.shadowOffsetY = 2;
          ctx.fillStyle = 'rgba(226, 232, 240, 0.94)';
        }
      } else {
        ctx.fillStyle = isDarkBar ? 'rgba(226, 232, 240, 0.88)' : '#475569';
      }
      ctx.fillText(hl, 0, hy, maxLineW);
    });
    ctx.restore();
  }
}

export function renderIllustrationVariantThumbnail(
  ctx: CanvasRenderingContext2D,
  variant: string,
  width: number,
  height: number,
  time = 0.6,
  primitivesOverride?: VectorPrimitive[],
): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = variant === 'cartoon-host' ? '#93DCFC' : '#F8FAFC';
  ctx.fillRect(0, 0, width, height);

  ctx.save();
  ctx.translate(width / 2, height / 2);
  const scale =
    variant === 'cartoon-host'
      ? Math.min(width / 460, height / 760)
      : Math.min(width / 920, height / 340);
  ctx.scale(scale, scale);

  if (primitivesOverride && primitivesOverride.length > 0) {
    drawVectorPrimitives(ctx, primitivesOverride, time, (icon) => drawSceneIcon(ctx, icon));
  } else {
    drawIllustrationProp(ctx, { kind: 'illustration-prop', variant }, time);
  }
  ctx.restore();
}

export function renderProjectFrame(
  ctx: CanvasRenderingContext2D,
  project: LessonProject,
  time: number,
  selectedElementId?: string | null,
) {
  const palette = CANVAS_THEMES[project.theme] || CANVAS_THEMES['pastel-sunrise'];
  const stage = getStageDimensionsForAspect(project.aspectRatio);
  const stageW = stage.width;
  const stageH = stage.height;

  // 1. Background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, stageH);
  bgGrad.addColorStop(0, palette.bgTop);
  bgGrad.addColorStop(1, palette.bgBottom);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, stageW, stageH);

  // Soft ambient radial glows
  const g1x = Math.round(stageW * 0.19);
  const g1y = Math.round(stageH * 0.17);
  const glow1 = ctx.createRadialGradient(g1x, g1y, 40, g1x, g1y, Math.round(Math.max(stageW, stageH) * 0.34));
  glow1.addColorStop(0, palette.glowA);
  glow1.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow1;
  ctx.fillRect(0, 0, stageW, stageH);

  const g2x = Math.round(stageW * 0.81);
  const g2y = Math.round(stageH * 0.74);
  const glow2 = ctx.createRadialGradient(g2x, g2y, 40, g2x, g2y, Math.round(Math.max(stageW, stageH) * 0.36));
  glow2.addColorStop(0, palette.glowB);
  glow2.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, stageW, stageH);

  // Determine whether learning content is currently on screen so background dims softly for readability
  const isLearningMomentActive = project.elements.some((el) => {
    if (time < el.startTime || time > el.endTime) return false;
    if (el.type === 'karaoke-card' || el.type === 'sentence-card') return true;
    return false;
  });

  // Optional preset / uploaded video / uploaded image background
  const bg = project.backgroundImage;
  if (bg) {
    let drewCustomBg = false;
    if ((bg.kind === 'preset' || (!bg.kind && bg.presetId && !bg.dataUrl && !bg.videoUrl)) && bg.presetId) {
      const presetMeta = getBackgroundPresetMeta(bg.presetId);
      const presetImg = presetMeta?.assetUrl ? getCachedBgImage(presetMeta.assetUrl) : null;
      if (presetImg) {
        const gentleZoom = 1 + 0.022 * (1 - Math.cos(Math.max(0, time) * 0.2));
        ctx.save();
        drawLoadedImageCover(
          ctx,
          presetImg,
          presetImg.naturalWidth || stageW,
          presetImg.naturalHeight || stageH,
          stageW,
          stageH,
          bg.fit || 'cover',
          gentleZoom,
        );
        ctx.restore();
        drawPresetBackground(ctx, bg.presetId, stageW, stageH, time, { overlayOnly: true });
      } else {
        drawPresetBackground(ctx, bg.presetId, stageW, stageH, time);
      }
      drewCustomBg = true;
    } else if (bg.kind === 'video' && bg.videoUrl) {
      const vid = getCachedBgVideo(bg.videoUrl);
      if (vid && vid.videoWidth > 0) {
        if (vid.readyState >= 2 && Number.isFinite(vid.duration) && vid.duration > 0.05) {
          const wrapped = ((Math.max(0, time) % vid.duration) + vid.duration) % vid.duration;
          if (Math.abs(vid.currentTime - wrapped) > 0.08 && !vid.seeking) {
            try {
              vid.currentTime = wrapped;
            } catch {
              // ignore seek throttle
            }
          }
        }
        ctx.save();
        drawLoadedImageCover(
          ctx,
          vid,
          vid.videoWidth,
          vid.videoHeight,
          stageW,
          stageH,
          bg.fit || 'cover',
        );
        ctx.restore();
        drewCustomBg = true;
      }
    } else if (bg.dataUrl) {
      const img = getCachedBgImage(bg.dataUrl);
      if (img) {
        ctx.save();
        drawLoadedImageCover(
          ctx,
          img,
          img.naturalWidth || stageW,
          img.naturalHeight || stageH,
          stageW,
          stageH,
          bg.fit || 'cover',
        );
        ctx.restore();
        drewCustomBg = true;
      }
    }

    if (drewCustomBg) {
      const baseScrim = bg.scrimOpacity ?? (bg.kind === 'preset' ? 0.16 : 0.22);
      const focusScrim =
        bg.learningScrimOpacity ??
        Math.min(0.85, Math.max(baseScrim, baseScrim + 0.2));
      const effectiveScrim = clamp01(isLearningMomentActive ? focusScrim : baseScrim);
      if (effectiveScrim > 0.01) {
        ctx.save();
        ctx.fillStyle = `rgba(10, 15, 28, ${effectiveScrim})`;
        ctx.fillRect(0, 0, stageW, stageH);
        ctx.restore();
      }
    }
  }

  if (project.compositionId === 'cartoon-host' && !project.backgroundImage) {
    // Crisp @Gimmys sky-blue diagonal gradient backdrop with soft ambient light bands
    const skyGrad = ctx.createLinearGradient(0, 0, stageW * 0.9, stageH);
    skyGrad.addColorStop(0, '#72CFF8');
    skyGrad.addColorStop(0.5, '#AEE5FD');
    skyGrad.addColorStop(1, '#DFF4FF');
    ctx.fillStyle = skyGrad;
    ctx.fillRect(0, 0, stageW, stageH);

    ctx.save();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
    ctx.beginPath();
    ctx.moveTo(0, stageH * 0.08);
    ctx.lineTo(stageW, stageH * -0.08);
    ctx.lineTo(stageW, stageH * 0.14);
    ctx.lineTo(0, stageH * 0.3);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.12)';
    ctx.beginPath();
    ctx.moveTo(0, stageH * 0.62);
    ctx.lineTo(stageW, stageH * 0.44);
    ctx.lineTo(stageW, stageH * 0.66);
    ctx.lineTo(0, stageH * 0.84);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  // 2. Sort elements by zIndex & resolve aspect layout
  const sorted = [...project.elements].sort((a, b) => a.layout.zIndex - b.layout.zIndex);
  const layoutMap = resolveElementLayoutForAspect(
    sorted,
    time,
    project.aspectRatio,
    project.subtitleConfig,
    project.compositionId,
  );

  for (const el of sorted) {
    const frame = computeElementFrameState(el, time);
    if (!frame.visible) continue;

    const activeLayout = layoutMap.get(el.id) || el.layout;
    const activeScale = frame.scale * ((activeLayout.scale || 1) / Math.max(0.1, el.layout.scale || 1));

    const clampedWidth = Math.min(stageW - 32, Math.max(120, activeLayout.width || 600));
    const halfBoundsW = (clampedWidth * activeScale) / 2;
    const drawX =
      halfBoundsW * 2 >= stageW - 32
        ? stageW / 2
        : Math.max(halfBoundsW + 16, Math.min(stageW - halfBoundsW - 16, activeLayout.x));

    ctx.save();
    ctx.globalAlpha = frame.opacity;
    ctx.translate(drawX, activeLayout.y + frame.translateY);
    ctx.scale(activeScale, activeScale);

    switch (el.props.kind) {
      case 'comparison-strip':
        drawComparisonStrip(ctx, el.props, clampedWidth, time, el.startTime);
        break;
      case 'topic-pill':
        drawTopicPill(ctx, el.props, clampedWidth);
        break;
      case 'illustration-prop': {
        const hasCustomPrims =
          Boolean(el.props.data?.customPrimitives?.length) ||
          Boolean(getCustomComponentByVariant(el.props.variant)?.primitives?.length);
        const fitScale = !hasCustomPrims && (clampedWidth < 840 || (activeLayout.height && activeLayout.height < 280))
          ? Math.max(
              0.45,
              Math.min(
                1,
                clampedWidth / 860,
                activeLayout.height ? activeLayout.height / 280 : 1,
              ),
            )
          : 1;
        if (fitScale < 0.999) {
          ctx.save();
          ctx.scale(fitScale, fitScale);
          drawIllustrationProp(ctx, el.props, time, el.startTime, project.cues);
          ctx.restore();
        } else {
          drawIllustrationProp(ctx, el.props, time, el.startTime, project.cues);
        }
        break;
      }
      case 'sentence-card':
        drawSentenceCard(ctx, el.props, clampedWidth, Math.max(0, time - el.startTime));
        break;
      case 'tone-meter':
        drawToneMeter(ctx, el.props, clampedWidth, time);
        break;
      case 'word-stack':
        drawWordStack(ctx, el.props, clampedWidth, time);
        break;
      case 'shape-3d':
        drawShape3D(ctx, el.props, clampedWidth, activeLayout.height ?? 200, Math.max(0, time - el.startTime));
        break;
      case 'karaoke-card':
        drawKaraokeCard(ctx, el.props, clampedWidth, time, {
          subtitleConfig: project.subtitleConfig,
          stageW,
          stageH,
          compositionId: project.compositionId,
          hasDarkStage:
            Boolean(project.backgroundImage) ||
            Boolean(CANVAS_THEMES[project.theme]?.isDark),
        });
        break;
    }

    // Optional crisp selection guide on canvas when editing in studio
    if (selectedElementId && el.id === selectedElementId) {
      ctx.save();
      ctx.strokeStyle = '#4F46E5';
      ctx.lineWidth = 4;
      ctx.setLineDash([12, 10]);
      const est = estimateElementBoxDimensions(el, activeLayout);
      const boxW = est.width + 26;
      const boxH = est.height + 26;
      drawRoundedRectPath(ctx, -boxW / 2, -boxH / 2, boxW, boxH, 24);
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore();
  }

  // 3. Optional Watermark & Outro overlay (shared across 9:16, 16:9, & English Reels)
  const wm = project.watermark;
  if (wm) {
    if (wm.watermarkEnabled && wm.watermarkText.trim()) {
      const wmText = wm.watermarkText.trim();
      ctx.save();
      ctx.globalAlpha = Math.max(0.15, Math.min(1, wm.watermarkOpacity ?? 0.65));
      ctx.font = '700 24px "Plus Jakarta Sans", "Inter", sans-serif';
      const tw = ctx.measureText(wmText).width;
      const boxW = Math.min(stageW - 80, tw + 36);
      const boxH = 48;
      const padX = 36;
      const padY = 44;
      const x =
        wm.watermarkCorner === 'top-left' || wm.watermarkCorner === 'bottom-left'
          ? padX
          : stageW - padX - boxW;
      const y =
        wm.watermarkCorner === 'top-left' || wm.watermarkCorner === 'top-right'
          ? padY
          : stageH - padY - boxH;
      ctx.fillStyle = 'rgba(15, 23, 42, 0.58)';
      drawRoundedRectPath(ctx, x, y, boxW, boxH, 14);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.textBaseline = 'middle';
      ctx.textAlign = 'left';
      ctx.fillText(wmText, x + 18, y + boxH / 2, boxW - 36);
      ctx.restore();
    }

    const outroLines = [wm.outroLine1?.trim() || '', wm.outroLine2?.trim() || ''].filter(Boolean);
    if (wm.outroSeconds > 0 && outroLines.length > 0 && project.duration > 0) {
      const outroStart = Math.max(0, project.duration - wm.outroSeconds);
      if (time >= outroStart) {
        const fadeDur = Math.min(0.55, wm.outroSeconds);
        const progress = fadeDur > 0 ? Math.min(1, (time - outroStart) / fadeDur) : 1;
        ctx.save();
        ctx.fillStyle = `rgba(15, 23, 42, ${(0.9 * progress).toFixed(3)})`;
        ctx.fillRect(0, 0, stageW, stageH);
        ctx.globalAlpha = progress;
        ctx.fillStyle = '#FFFFFF';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = '800 54px "Outfit", "Plus Jakarta Sans", sans-serif';
        const lineGap = 76;
        const baseLineY = stageH / 2 - ((outroLines.length - 1) * lineGap) / 2;
        outroLines.forEach((line, idx) => {
          ctx.fillText(line, stageW / 2, baseLineY + idx * lineGap, stageW * 0.84);
        });
        ctx.restore();
      }
    }
  }
}

function estimateElementBoxDimensions(
  el: SceneElement,
  activeLayout: ElementLayout,
): { width: number; height: number } {
  const width = Math.max(120, activeLayout.width || 600);
  if (el.props.kind === 'shape-3d') {
    return { width, height: activeLayout.height ?? 200 };
  }
  if (el.props.kind === 'word-stack') {
    return { width, height: Math.max(360, activeLayout.height ?? 450) };
  }
  if (el.props.kind === 'illustration-prop') {
    return { width, height: Math.max(220, activeLayout.height ?? 300) };
  }
  if (el.props.kind === 'comparison-strip') {
    const items = Array.isArray(el.props.items) ? el.props.items : [];
    const itemsLen = items.length;
    const isLongStack =
      el.id.startsWith('reel-quiz-opts-') ||
      items.some((item) => item.label.trim().length > 16) ||
      itemsLen > 4;
    const computedH = isLongStack ? Math.max(150, itemsLen * 88 + 20) : 124;
    return {
      width,
      height: isLongStack ? Math.max(activeLayout.height ?? 0, computedH) : (activeLayout.height ?? computedH),
    };
  }
  if (el.props.kind === 'sentence-card') {
    const subLen = (el.props.subtext || '').length;
    const textLen = (el.props.text || '').length;
    const extraLines = Math.floor(textLen / 46) + Math.floor(subLen / 52);
    return {
      width,
      height: Math.max(165, activeLayout.height ?? Math.min(340, 175 + extraLines * 26)),
    };
  }
  if (el.props.kind === 'topic-pill') {
    return { width, height: activeLayout.height ?? 84 };
  }
  return { width, height: activeLayout.height ?? 160 };
}

export function hitTestElementLayout(
  elements: SceneElement[],
  canvasX: number,
  canvasY: number,
  time: number,
  aspectRatio: ExportAspectRatioId = '9:16',
  subtitleConfig?: SubtitleDisplayConfig,
  compositionId?: LayoutCompositionId,
): { element: SceneElement; layout: ElementLayout } | null {
  const stage = getStageDimensionsForAspect(aspectRatio);
  const stageW = stage.width;
  const sorted = [...elements].sort((a, b) => b.layout.zIndex - a.layout.zIndex);
  const layoutMap = resolveElementLayoutForAspect(
    sorted,
    time,
    aspectRatio,
    subtitleConfig,
    compositionId,
  );
  for (const el of sorted) {
    const state = computeElementFrameState(el, time);
    if (!state.visible) continue;
    const activeLayout = layoutMap.get(el.id) || el.layout;
    const activeScale =
      state.scale * ((activeLayout.scale || 1) / Math.max(0.1, el.layout.scale || 1));
    const est = estimateElementBoxDimensions(el, activeLayout);
    const clampedWidth = Math.min(stageW - 32, Math.max(120, est.width));
    const halfW = (clampedWidth * activeScale) / 2;
    const halfH = (est.height * activeScale) / 2;
    const drawX =
      halfW * 2 >= stageW - 32
        ? stageW / 2
        : Math.max(halfW + 16, Math.min(stageW - halfW - 16, activeLayout.x));
    const drawY = activeLayout.y + state.translateY;
    if (
      canvasX >= drawX - halfW &&
      canvasX <= drawX + halfW &&
      canvasY >= drawY - halfH &&
      canvasY <= drawY + halfH
    ) {
      return { element: el, layout: activeLayout };
    }
  }
  return null;
}

export function hitTestElements(
  elements: SceneElement[],
  canvasX: number,
  canvasY: number,
  time: number,
  aspectRatio: ExportAspectRatioId = '9:16',
  subtitleConfig?: SubtitleDisplayConfig,
  compositionId?: LayoutCompositionId,
): SceneElement | null {
  return (
    hitTestElementLayout(elements, canvasX, canvasY, time, aspectRatio, subtitleConfig, compositionId)
      ?.element ?? null
  );
}
