import { parseTranscriptAuto } from './transcriptParser';
import {
  TranscriptCue,
  WatermarkCorner,
  WatermarkOutroConfig,
  WordTiming,
} from './types';

export type EduWatermarkCorner = WatermarkCorner;
export type EduKaraokePosition = 'Dưới' | 'Giữa' | 'Trên';
export type EduKaraokeSize = 'Nhỏ' | 'Vừa' | 'Lớn';

export type EduWatermarkOutroConfig = WatermarkOutroConfig;

export interface KaraokeEffectSpec {
  id: string;
  description: string;
  mode: 'karaoke' | 'typewriter';
  activeColor: string;
  inactiveColor: string;
  outlineColor: string;
  border: number;
  shadow: number;
  blur: number;
  bold: number;
  box: boolean;
  pop: boolean;
}

export const KARAOKE_EFFECT_PRESETS: KaraokeEffectSpec[] = [
  {
    id: 'Classic Karaoke – tô màu từng từ',
    description: 'Chữ trắng, từ đang đọc chuyển tím theo tiến độ; viền tối rõ trên mọi nền.',
    mode: 'karaoke',
    activeColor: '#A78BFA',
    inactiveColor: '#FFFFFF',
    outlineColor: '#172033',
    border: 2.4,
    shadow: 1.2,
    blur: 0,
    bold: -1,
    box: false,
    pop: false,
  },
  {
    id: 'Neon Glow – phát sáng',
    description: 'Từ đang đọc chuyển xanh cyan, có viền và phát sáng nhẹ; hợp video tech/hiện đại.',
    mode: 'karaoke',
    activeColor: '#67E8F9',
    inactiveColor: '#F8FAFC',
    outlineColor: '#155E75',
    border: 3.2,
    shadow: 0.5,
    blur: 1.1,
    bold: -1,
    box: false,
    pop: false,
  },
  {
    id: 'Pop Bounce – bật nảy',
    description: 'Cả dòng bật nảy nhẹ khi xuất hiện; từ đang đọc chuyển vàng cam đậm nét.',
    mode: 'karaoke',
    activeColor: '#FBBF24',
    inactiveColor: '#FFFFFF',
    outlineColor: '#292014',
    border: 3.0,
    shadow: 1.0,
    blur: 0,
    bold: -1,
    box: false,
    pop: true,
  },
  {
    id: 'Soft Caption Card – thẻ nền mờ',
    description: 'Phụ đề nằm trên thẻ nền xanh đen bán trong suốt, bo kiểu caption cổ điển.',
    mode: 'karaoke',
    activeColor: '#C4B5FD',
    inactiveColor: '#FFFFFF',
    outlineColor: '#263449',
    border: 10.0,
    shadow: 0,
    blur: 0,
    bold: 0,
    box: true,
    pop: false,
  },
  {
    id: 'Minimal Outline – tối giản',
    description: 'Không thẻ nền; chữ trắng viền đen mảnh, từ đang đọc chuyển xanh lá nhẹ.',
    mode: 'karaoke',
    activeColor: '#86EFAC',
    inactiveColor: '#FFFFFF',
    outlineColor: '#000000',
    border: 1.5,
    shadow: 0.8,
    blur: 0,
    bold: 0,
    box: false,
    pop: false,
  },
  {
    id: 'Typewriter – hiện lần lượt',
    description: 'Câu hiện dần theo từng từ; từ mới xuất hiện được tô màu nhấn cho video từ vựng.',
    mode: 'typewriter',
    activeColor: '#FBBF24',
    inactiveColor: '#FFFFFF',
    outlineColor: '#172033',
    border: 2.2,
    shadow: 1.0,
    blur: 0,
    bold: -1,
    box: false,
    pop: false,
  },
];

function hexToAssBgr(hex: string, alpha = 0): string {
  const clean = hex.replace('#', '').trim();
  const a = Math.max(0, Math.min(255, Math.round(alpha)))
    .toString(16)
    .toUpperCase()
    .padStart(2, '0');
  if (clean.length === 6) {
    const r = clean.slice(0, 2);
    const g = clean.slice(2, 4);
    const b = clean.slice(4, 6);
    return `&H${a}${b}${g}${r}`.toUpperCase();
  }
  return `&H${a}FFFFFF`;
}

function toAssTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const hh = Math.floor(cs / 360000);
  const mm = Math.floor((cs % 360000) / 6000);
  const ss = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

function escAssText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')');
}

export function buildEduKaraokeAss(
  rawInput: string,
  options: {
    effectId?: string;
    activeColorOverride?: string;
    position?: EduKaraokePosition;
    size?: EduKaraokeSize;
    width?: number;
    height?: number;
  } = {},
): string {
  const spec =
    KARAOKE_EFFECT_PRESETS.find((e) => e.id === options.effectId) ?? KARAOKE_EFFECT_PRESETS[0];
  const width = options.width ?? 1080;
  const height = options.height ?? 1920;
  const position: EduKaraokePosition = options.position ?? 'Dưới';
  const size: EduKaraokeSize = options.size ?? 'Vừa';

  const sizeFactor = size === 'Nhỏ' ? 0.035 : size === 'Lớn' ? 0.056 : 0.045;
  const fontSize = Math.max(24, Math.min(92, Math.round(height * sizeFactor)));
  const align = position === 'Giữa' ? 5 : position === 'Trên' ? 8 : 2;
  const marginV = Math.max(36, Math.round(height * (position === 'Giữa' ? 0.0 : 0.065)));

  const activeBgr = hexToAssBgr(options.activeColorOverride || spec.activeColor);
  const inactiveBgr = hexToAssBgr(spec.inactiveColor);
  const outlineBgr = hexToAssBgr(spec.outlineColor);
  const backBgr = hexToAssBgr('#101827', 78);
  const borderStyle = spec.box ? 3 : 1;

  const parsedCues = parseTranscriptAuto(rawInput);
  const cues: TranscriptCue[] =
    parsedCues.length > 0
      ? parsedCues
      : rawInput
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean)
          .map((text, idx) => ({
            id: `k-${idx + 1}`,
            start: idx * 3.5,
            end: (idx + 1) * 3.5,
            text,
            words: [],
          }));

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Karaoke,Noto Sans,${fontSize},${activeBgr},${inactiveBgr},${outlineBgr},${backBgr},${spec.bold},0,0,0,100,100,0,0,${borderStyle},${spec.border.toFixed(1)},${spec.shadow.toFixed(1)},${align},${Math.round(width * 0.055)},${Math.round(width * 0.055)},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  for (const cue of cues) {
    const tokens = cue.text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
    if (tokens.length === 0) continue;
    const totalCs = Math.max(tokens.length * 4, Math.round((cue.end - cue.start) * 100));
    const weights = tokens.map((t) => Math.max(1, t.length));
    const weightSum = weights.reduce((a, b) => a + b, 0);
    const allocated: number[] = [];
    let remaining = totalCs;
    for (let i = 0; i < tokens.length; i++) {
      if (i === tokens.length - 1) {
        allocated.push(Math.max(2, remaining));
      } else {
        const cs = Math.max(2, Math.min(remaining - (tokens.length - i - 1) * 2, Math.round((totalCs * weights[i]) / weightSum)));
        allocated.push(cs);
        remaining -= cs;
      }
    }

    if (spec.mode === 'typewriter') {
      let cursor = cue.start;
      const prefix: string[] = [];
      for (let i = 0; i < tokens.length; i++) {
        const tokenStart = cursor;
        cursor += allocated[i] / 100;
        prefix.push(tokens[i]);
        const eventEnd = i === tokens.length - 1 ? cue.end : Math.min(cue.end, cursor + 0.005);
        const visible = prefix.map((tok, j) =>
          j === prefix.length - 1
            ? `{\\1c${activeBgr}}${escAssText(tok)}{\\1c${inactiveBgr}}`
            : escAssText(tok),
        );
        const popTag =
          spec.pop && i === 0 ? '\\t(0,120,\\fscx112\\fscy112)\\t(120,240,\\fscx100\\fscy100)' : '';
        lines.push(
          `Dialogue: 0,${toAssTime(tokenStart)},${toAssTime(eventEnd)},Karaoke,,0,0,0,,{\\an${align}\\q2\\fad(60,70)${popTag}}${visible.join(' ')}`,
        );
      }
    } else {
      const kBody = tokens
        .map((w, idx) => `{\\kf${allocated[idx]}}${escAssText(w)}`)
        .join(' ');
      const blurTag = spec.blur > 0 ? `\\blur${spec.blur.toFixed(1)}` : '';
      const popTag = spec.pop ? '\\t(0,120,\\fscx112\\fscy112)\\t(120,240,\\fscx100\\fscy100)' : '';
      lines.push(
        `Dialogue: 0,${toAssTime(cue.start)},${toAssTime(cue.end)},Karaoke,,0,0,0,,{\\an${align}\\q2${blurTag}${popTag}}${kBody}`,
      );
    }
  }

  return lines.join('\n') + '\n';
}

export interface ReadingBookPalette {
  id: 'Sunny Yellow' | 'Sky Blue' | 'Mint Green' | 'Warm Cream' | 'Lavender';
  bgTop: string;
  bgBottom: string;
  pageBg: string;
  pageBorder: string;
  spineColor: string;
  headerBg: string;
  headerText: string;
  bodyText: string;
  highlightBg: string;
  highlightText: string;
  spokenText: string;
  accent: string;
}

export const READING_BOOK_PALETTES: ReadingBookPalette[] = [
  {
    id: 'Sunny Yellow',
    bgTop: '#FEF3C7',
    bgBottom: '#FDE68A',
    pageBg: '#FFFDF7',
    pageBorder: '#F59E0B',
    spineColor: '#D97706',
    headerBg: '#FEF08A',
    headerText: '#92400E',
    bodyText: '#1E293B',
    highlightBg: '#F59E0B',
    highlightText: '#FFFFFF',
    spokenText: '#334155',
    accent: '#D97706',
  },
  {
    id: 'Sky Blue',
    bgTop: '#E0F2FE',
    bgBottom: '#BAE6FD',
    pageBg: '#F8FDFF',
    pageBorder: '#38BDF8',
    spineColor: '#0284C7',
    headerBg: '#BAE6FD',
    headerText: '#075985',
    bodyText: '#0F172A',
    highlightBg: '#0284C7',
    highlightText: '#FFFFFF',
    spokenText: '#334155',
    accent: '#0284C7',
  },
  {
    id: 'Mint Green',
    bgTop: '#DCFCE7',
    bgBottom: '#BBF7D0',
    pageBg: '#F7FEF9',
    pageBorder: '#34D399',
    spineColor: '#059669',
    headerBg: '#BBF7D0',
    headerText: '#065F46',
    bodyText: '#0F172A',
    highlightBg: '#059669',
    highlightText: '#FFFFFF',
    spokenText: '#334155',
    accent: '#059669',
  },
  {
    id: 'Warm Cream',
    bgTop: '#F5EFE6',
    bgBottom: '#E8DFCA',
    pageBg: '#FFFBF2',
    pageBorder: '#D4A373',
    spineColor: '#9C6644',
    headerBg: '#FAEDCD',
    headerText: '#6F4E37',
    bodyText: '#2B2118',
    highlightBg: '#BC6C25',
    highlightText: '#FFFFFF',
    spokenText: '#5C4738',
    accent: '#BC6C25',
  },
  {
    id: 'Lavender',
    bgTop: '#F3E8FF',
    bgBottom: '#E9D5FF',
    pageBg: '#FDFBFF',
    pageBorder: '#A78BFA',
    spineColor: '#7C3AED',
    headerBg: '#E9D5FF',
    headerText: '#5B21B6',
    bodyText: '#1E1B4B',
    highlightBg: '#7C3AED',
    highlightText: '#FFFFFF',
    spokenText: '#4338CA',
    accent: '#7C3AED',
  },
];

export type ReadingIllustrationStyle = 'Flat 2D' | '2.5D' | '3D Cartoon';

export type ReadingBookFrameId =
  | 'classic-page'
  | 'open-spread'
  | 'spiral-notebook'
  | 'textbook-card'
  | 'chalkboard';

export interface ReadingBookFrameMeta {
  id: ReadingBookFrameId;
  label: string;
  description: string;
}

export const READING_BOOK_FRAMES: ReadingBookFrameMeta[] = [
  { id: 'classic-page', label: 'Trang Sách Cổ Điển', description: 'Khung trang sách bo tròn có gáy nổi truyền thống' },
  { id: 'open-spread', label: 'Sách Mở Hai Trang', description: 'Mở trang đôi kèm dải ruy-băng đánh dấu trang' },
  { id: 'spiral-notebook', label: 'Sổ Lò Xo Dòng Kẻ', description: 'Gáy xoắn lò xo phía trên kèm dòng kẻ vở học tập' },
  { id: 'textbook-card', label: 'Giáo Trình Hiện Đại', description: 'Header dải màu toàn phần phong cách Oxford/Cambridge' },
  { id: 'chalkboard', label: 'Bảng Phấn Lớp Học', description: 'Bảng đen viền gỗ với chữ phấn trắng nổi bật' },
];

export type ReadingPointerStyleId =
  | 'hand-classic'
  | 'magic-wand'
  | 'highlighter'
  | 'laser-dot'
  | 'bouncing-arrow'
  | 'fountain-pen'
  | 'underline-only';

export interface ReadingPointerStyleMeta {
  id: ReadingPointerStyleId;
  label: string;
  description: string;
}

export const READING_POINTER_STYLES: ReadingPointerStyleMeta[] = [
  { id: 'hand-classic', label: 'Ngón Tay Chỉ Chữ', description: 'Bàn tay hoạt hình di chuyển mượt theo từng từ' },
  { id: 'magic-wand', label: 'Đũa Phép Ngôi Sao', description: 'Đũa sao phát sáng lướt nhẹ dưới từ đang đọc' },
  { id: 'highlighter', label: 'Bút Dạ Quang', description: 'Ngòi bút highlight kèm vệt sáng đánh dấu từ' },
  { id: 'laser-dot', label: 'Tia Laser Đỏ', description: 'Chấm laser kèm vầng hào quang sắc nét' },
  { id: 'bouncing-arrow', label: 'Mũi Tên Nhún Nhảy', description: 'Mũi tên chỉ lên nhịp nhàng theo tốc độ đọc' },
  { id: 'fountain-pen', label: 'Bút Máy Cổ Điển', description: 'Ngòi bút máy nghiêng theo nhịp từng chữ' },
  { id: 'underline-only', label: 'Gạch Chân Tối Giản', description: 'Thanh gạch chân động mượt mà, không che chữ' },
];

export interface ReadingAlongRenderOptions {
  width: number;
  height: number;
  title: string;
  topicBadge?: string;
  text: string;
  words: WordTiming[];
  currentTime: number;
  totalDuration: number;
  contentDuration?: number;
  introEnabled?: boolean;
  introSeconds?: number;
  introTitle?: string;
  introSubtitle?: string;
  paletteId: ReadingBookPalette['id'];
  illustrationStyle: ReadingIllustrationStyle;
  bookFrame?: ReadingBookFrameId;
  pointerStyle?: ReadingPointerStyleId;
  watermarkOutro: EduWatermarkOutroConfig;
}

export interface ReadingTimelineMetrics {
  introEnd: number;
  hasIntro: boolean;
  lastWordEnd: number;
  contentEnd: number;
  outroStart: number;
  effectiveTotalDuration: number;
  hasOutro: boolean;
}

/**
 * Guarantees Outro never overlaps active words by placing outroStart strictly
 * after both contentDuration and the last spoken word's end timestamp,
 * and accounts for optional spoken Intro window before words start.
 */
export function computeReadingTimelineMetrics(params: {
  words: WordTiming[];
  totalDuration?: number;
  contentDuration?: number;
  introEnabled?: boolean;
  introSeconds?: number;
  outroSeconds: number;
  outroText?: string;
}): ReadingTimelineMetrics {
  const introSec =
    params.introEnabled !== false && Number(params.introSeconds) > 0
      ? Number(params.introSeconds)
      : 0;
  const lastWordEnd = params.words.reduce((mx, w) => Math.max(mx, Number(w.end) || 0), 0);
  const contentEnd = Math.max(introSec + 1, Number(params.contentDuration) || 0, lastWordEnd);
  const outroSec = Math.max(0, Number(params.outroSeconds) || 0);
  const hasOutroText = params.outroText === undefined ? true : params.outroText.trim().length > 0;
  const hasOutro = outroSec > 0 && hasOutroText;
  const baseTotal = Math.max(Number(params.totalDuration) || 0, contentEnd);
  const outroStart = hasOutro
    ? Math.max(contentEnd, baseTotal - outroSec)
    : baseTotal;
  const effectiveTotalDuration = hasOutro
    ? Math.max(baseTotal, outroStart + outroSec)
    : baseTotal;
  return {
    introEnd: Number(introSec.toFixed(3)),
    hasIntro: introSec > 0.15,
    lastWordEnd: Number(lastWordEnd.toFixed(3)),
    contentEnd: Number(contentEnd.toFixed(3)),
    outroStart: Number(outroStart.toFixed(3)),
    effectiveTotalDuration: Number(effectiveTotalDuration.toFixed(3)),
    hasOutro,
  };
}

export interface PaginatedPositionedWord {
  item: WordTiming;
  x: number;
  y: number;
  w: number;
  index: number;
  pageIndex: number;
}

export function paginateReadingWords(
  wordsList: WordTiming[],
  measureWidth: (word: string) => number,
  bounds: {
    startX: number;
    maxW: number;
    startY: number;
    maxY: number;
    lineHeight: number;
    wordGap: number;
  },
): PaginatedPositionedWord[][] {
  const pages: PaginatedPositionedWord[][] = [[]];
  let curPageIdx = 0;
  let curX = bounds.startX;
  let curY = bounds.startY;

  for (let i = 0; i < wordsList.length; i++) {
    const item = wordsList[i];
    const w = measureWidth(item.word);
    if (curX + w > bounds.startX + bounds.maxW && curX > bounds.startX) {
      curX = bounds.startX;
      curY += bounds.lineHeight;
    }
    if (curY > bounds.maxY && pages[curPageIdx].length > 0) {
      curPageIdx += 1;
      pages.push([]);
      curX = bounds.startX;
      curY = bounds.startY;
    }
    pages[curPageIdx].push({
      item,
      x: curX,
      y: curY,
      w,
      index: i,
      pageIndex: curPageIdx,
    });
    curX += w + bounds.wordGap;
  }
  return pages;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rad, y + h);
  ctx.lineTo(x + rad, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rad);
  ctx.lineTo(x, y + rad);
  ctx.quadraticCurveTo(x, y, x + rad, y);
  ctx.closePath();
}

export function buildEstimatedReadingWords(text: string, totalDuration = 12): WordTiming[] {
  const tokens = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length === 0) return [];
  const weights = tokens.map((t) => Math.max(2, t.replace(/[^a-zA-Z0-9\u00C0-\u024F\u3040-\u30FF\u4E00-\u9FFF]/g, '').length + (/[,.!?]$/.test(t) ? 2.5 : 0)));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const safeDur = Math.max(tokens.length * 0.25, totalDuration);
  let cursor = 0.15;
  const usable = Math.max(0.5, safeDur - 0.3);
  return tokens.map((word, idx) => {
    const dur = (weights[idx] / totalWeight) * usable;
    const start = Number(cursor.toFixed(3));
    const end = Number((cursor + dur).toFixed(3));
    cursor += dur;
    return { word, start, end };
  });
}

function drawReadingPointer(
  ctx: CanvasRenderingContext2D,
  style: ReadingPointerStyleId,
  x: number,
  y: number,
  wordW: number,
  fontSize: number,
  palette: ReadingBookPalette,
  scale: number,
  timeSec: number,
  isChalkboard: boolean,
) {
  const bob = Math.sin(timeSec * 7.5) * 2.2;
  ctx.save();

  switch (style) {
    case 'underline-only': {
      const barY = y - 2;
      ctx.fillStyle = isChalkboard ? '#FACC15' : palette.highlightBg;
      roundRectPath(ctx, x - wordW / 2 - 4, barY, wordW + 8, Math.max(4, Math.round(fontSize * 0.14)), 4);
      ctx.fill();
      ctx.restore();
      return;
    }

    case 'laser-dot': {
      const dotX = x;
      const dotY = y + 4 + bob * 0.4;
      const r = Math.max(7, 10 * scale);
      const glow = ctx.createRadialGradient(dotX, dotY, 1, dotX, dotY, r * 2.6);
      glow.addColorStop(0, 'rgba(239, 68, 68, 0.95)');
      glow.addColorStop(0.45, 'rgba(239, 68, 68, 0.35)');
      glow.addColorStop(1, 'rgba(239, 68, 68, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(dotX, dotY, r * 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.beginPath();
      ctx.arc(dotX, dotY, r * 0.45, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      return;
    }

    case 'bouncing-arrow': {
      const arrY = y + 2 + Math.abs(bob) * 1.4;
      ctx.translate(x, arrY);
      ctx.scale(scale, scale);
      ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 3;
      ctx.fillStyle = isChalkboard ? '#38BDF8' : palette.accent;
      ctx.strokeStyle = '#FFFFFF';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.lineTo(18, 22);
      ctx.lineTo(7, 22);
      ctx.lineTo(7, 46);
      ctx.lineTo(-7, 46);
      ctx.lineTo(-7, 22);
      ctx.lineTo(-18, 22);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }

    case 'highlighter': {
      ctx.translate(x + 6, y + 6 + bob * 0.5);
      ctx.scale(scale, scale);
      ctx.rotate(-0.42);
      ctx.shadowColor = 'rgba(15, 23, 42, 0.24)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 3;
      // Glowing marker tip
      ctx.fillStyle = '#FACC15';
      ctx.beginPath();
      ctx.moveTo(-8, -2);
      ctx.lineTo(8, -2);
      ctx.lineTo(5, 12);
      ctx.lineTo(-5, 12);
      ctx.closePath();
      ctx.fill();
      // Marker body
      ctx.fillStyle = '#FEF08A';
      ctx.strokeStyle = '#CA8A04';
      ctx.lineWidth = 2.5;
      roundRectPath(ctx, -11, 10, 22, 46, 5);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = palette.accent;
      roundRectPath(ctx, -11, 38, 22, 18, 4);
      ctx.fill();
      ctx.restore();
      return;
    }

    case 'magic-wand': {
      ctx.translate(x, y + 8 + bob * 0.6);
      ctx.scale(scale, scale);
      ctx.shadowColor = 'rgba(250, 204, 21, 0.55)';
      ctx.shadowBlur = 12;
      // Wand stick angled down-right
      ctx.strokeStyle = '#7C3AED';
      ctx.lineWidth = 7;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(2, 6);
      ctx.lineTo(26, 52);
      ctx.stroke();
      ctx.strokeStyle = '#DDD6FE';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.moveTo(5, 12);
      ctx.lineTo(24, 48);
      ctx.stroke();
      // 5-point Star tip
      ctx.fillStyle = '#FACC15';
      ctx.strokeStyle = '#D97706';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 === 0 ? 15 : 6.5;
        const a = -Math.PI / 2 + (i * Math.PI) / 5 + Math.sin(timeSec * 3) * 0.08;
        const px = Math.cos(a) * r;
        const py = Math.sin(a) * r;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
      return;
    }

    case 'fountain-pen': {
      ctx.translate(x + 4, y + 6 + bob * 0.4);
      ctx.scale(scale, scale);
      ctx.rotate(-0.35);
      ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
      ctx.shadowBlur = 8;
      // Gold nib
      ctx.fillStyle = '#F59E0B';
      ctx.strokeStyle = '#78350F';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(0, -4);
      ctx.lineTo(9, 14);
      ctx.lineTo(-9, 14);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      // Pen barrel
      ctx.fillStyle = '#1E293B';
      roundRectPath(ctx, -8, 13, 16, 48, 5);
      ctx.fill();
      ctx.fillStyle = '#F59E0B';
      ctx.fillRect(-8, 15, 16, 4);
      ctx.restore();
      return;
    }

    case 'hand-classic':
    default: {
      ctx.translate(x, y + 4 + bob * 0.6);
      ctx.scale(scale, scale);
      ctx.shadowColor = 'rgba(15, 23, 42, 0.25)';
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 4;
      ctx.fillStyle = '#FDBA74';
      ctx.strokeStyle = '#7C2D12';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(-6, 4);
      ctx.lineTo(-6, 22);
      ctx.quadraticCurveTo(-18, 22, -18, 34);
      ctx.lineTo(-18, 48);
      ctx.quadraticCurveTo(-18, 62, 0, 62);
      ctx.quadraticCurveTo(22, 62, 22, 46);
      ctx.lineTo(22, 30);
      ctx.quadraticCurveTo(22, 20, 12, 20);
      ctx.lineTo(12, 4);
      ctx.quadraticCurveTo(12, -4, 3, -4);
      ctx.quadraticCurveTo(-6, -4, -6, 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = palette.accent;
      roundRectPath(ctx, -14, 58, 32, 16, 6);
      ctx.fill();
      ctx.restore();
      return;
    }
  }
}

export function renderReadingAlongFrame(
  ctx: CanvasRenderingContext2D,
  opts: ReadingAlongRenderOptions,
): void {
  const { width, height } = opts;
  const isLandscape = width > height;
  const refH = isLandscape ? Math.round(height * 1.28) : height;
  const palette =
    READING_BOOK_PALETTES.find((p) => p.id === opts.paletteId) ?? READING_BOOK_PALETTES[0];
  const bookFrame: ReadingBookFrameId = opts.bookFrame ?? 'classic-page';
  const pointerStyle: ReadingPointerStyleId = opts.pointerStyle ?? 'hand-classic';
  const isChalkboard = bookFrame === 'chalkboard';

  // Background gradient
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  if (isChalkboard) {
    grad.addColorStop(0, '#1E293B');
    grad.addColorStop(1, '#0F172A');
  } else {
    grad.addColorStop(0, palette.bgTop);
    grad.addColorStop(1, palette.bgBottom);
  }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // Decorative floating circles
  ctx.save();
  ctx.globalAlpha = opts.illustrationStyle === '3D Cartoon' ? 0.32 : 0.2;
  ctx.fillStyle = isChalkboard ? '#38BDF8' : palette.pageBorder;
  ctx.beginPath();
  ctx.arc(width * 0.14, height * 0.1, Math.min(width, height) * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(width * 0.88, height * 0.86, Math.min(width, height) * 0.14, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const bookX = width * (isLandscape ? 0.045 : 0.065);
  const bookY = height * (isLandscape ? 0.065 : 0.085);
  const bookW = width * (isLandscape ? 0.91 : 0.87);
  const bookH = height * (isLandscape ? 0.86 : 0.81);
  const frameRadius = bookFrame === 'textbook-card' ? Math.min(width, height) * 0.024 : Math.min(width, height) * 0.034;

  // Frame outer cover / stacked pages
  if (bookFrame === 'open-spread') {
    ctx.save();
    ctx.fillStyle = palette.spineColor;
    roundRectPath(ctx, bookX - 10, bookY + 6, bookW + 20, bookH + 8, frameRadius + 6);
    ctx.fill();
    // Stacked side paper layers
    ctx.fillStyle = '#E2E8F0';
    roundRectPath(ctx, bookX - 5, bookY + 3, bookW + 10, bookH + 3, frameRadius + 2);
    ctx.fill();
    ctx.restore();
  } else if (opts.illustrationStyle !== 'Flat 2D' || isChalkboard) {
    ctx.save();
    ctx.fillStyle = isChalkboard ? '#78350F' : palette.spineColor;
    roundRectPath(
      ctx,
      bookX + Math.min(width, height) * (isChalkboard ? 0.008 : 0.014),
      bookY + Math.min(width, height) * (isChalkboard ? 0.01 : 0.012),
      bookW,
      bookH,
      frameRadius,
    );
    ctx.fill();
    ctx.restore();
  }

  // Book main surface
  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.18)';
  ctx.shadowBlur = Math.min(width, height) * 0.04;
  ctx.shadowOffsetY = Math.min(width, height) * 0.01;
  ctx.fillStyle = isChalkboard ? '#14332B' : palette.pageBg;
  roundRectPath(ctx, bookX, bookY, bookW, bookH, frameRadius);
  ctx.fill();
  ctx.lineWidth = isChalkboard ? Math.max(8, Math.min(width, height) * 0.014) : Math.max(2, Math.min(width, height) * 0.004);
  ctx.strokeStyle = isChalkboard ? '#92400E' : palette.pageBorder;
  ctx.stroke();
  ctx.restore();

  // Frame-specific chrome accents
  if (bookFrame === 'textbook-card') {
    ctx.save();
    roundRectPath(ctx, bookX, bookY, bookW, bookH, frameRadius);
    ctx.clip();
    ctx.fillStyle = palette.accent;
    ctx.fillRect(bookX, bookY, bookW, Math.max(12, Math.round(bookH * 0.022)));
    ctx.restore();
  } else if (bookFrame === 'open-spread') {
    // Satin bookmark ribbon hanging from top right
    ctx.save();
    const ribX = bookX + bookW * 0.82;
    const ribW = Math.max(16, Math.round(width * 0.02));
    const ribH = Math.max(38, Math.round(bookH * 0.095));
    ctx.fillStyle = palette.accent;
    ctx.beginPath();
    ctx.moveTo(ribX, bookY - 2);
    ctx.lineTo(ribX + ribW, bookY - 2);
    ctx.lineTo(ribX + ribW, bookY + ribH);
    ctx.lineTo(ribX + ribW / 2, bookY + ribH - 10);
    ctx.lineTo(ribX, bookY + ribH);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  } else if (bookFrame === 'spiral-notebook') {
    ctx.save();
    const ringCount = isLandscape ? 14 : 10;
    const ringSpan = bookW * 0.84;
    const ringStart = bookX + bookW * 0.08;
    for (let r = 0; r < ringCount; r++) {
      const rx = ringStart + (r / Math.max(1, ringCount - 1)) * ringSpan;
      ctx.fillStyle = '#475569';
      ctx.beginPath();
      ctx.arc(rx, bookY + 12, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#94A3B8';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(rx, bookY + 2, 10, Math.PI * 0.9, Math.PI * 2.1);
      ctx.stroke();
    }
    // Red vertical notebook margin
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.35)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(bookX + bookW * 0.042, bookY + 28);
    ctx.lineTo(bookX + bookW * 0.042, bookY + bookH - 18);
    ctx.stroke();
    ctx.restore();
  }

  // Book header banner & illustration badge
  const padX = bookX + bookW * (bookFrame === 'spiral-notebook' ? 0.07 : 0.06);
  const contentW = bookW * (bookFrame === 'spiral-notebook' ? 0.86 : 0.88);
  const pillY = bookY + bookH * (bookFrame === 'spiral-notebook' ? 0.068 : 0.048);
  const pillH = Math.max(24, refH * 0.03);

  if (opts.topicBadge) {
    const badgeW = Math.min(contentW * 0.72, Math.max(200, width * 0.42));
    ctx.save();
    ctx.fillStyle = isChalkboard ? 'rgba(255,255,255,0.12)' : palette.headerBg;
    roundRectPath(ctx, padX, pillY, badgeW, pillH, pillH / 2);
    ctx.fill();
    ctx.fillStyle = isChalkboard ? '#FDE68A' : palette.headerText;
    ctx.font = `700 ${Math.round(refH * 0.0155)}px "Plus Jakarta Sans", sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(opts.topicBadge, padX + 14, pillY + pillH / 2, Math.max(80, badgeW - 28));
    ctx.restore();
  }

  // Mini book/chalk icon on top right of page
  if (bookFrame !== 'open-spread') {
    ctx.save();
    const iconS = Math.min(54, Math.min(width, height) * 0.065);
    const iconX = bookX + bookW - padX * 0.35 - iconS - 12;
    const iconY = pillY - 2;
    ctx.fillStyle = isChalkboard ? '#F59E0B' : palette.accent;
    if (opts.illustrationStyle === '3D Cartoon') {
      ctx.shadowColor = 'rgba(0,0,0,0.22)';
      ctx.shadowBlur = 8;
      ctx.shadowOffsetY = 4;
    }
    roundRectPath(ctx, iconX, iconY, iconS, iconS * 0.78, 10);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(iconX + iconS * 0.48, iconY + 6, 2.5, iconS * 0.78 - 12);
    ctx.restore();
  }

  // Title
  const titleY = pillY + pillH + refH * 0.022;
  ctx.save();
  ctx.fillStyle = isChalkboard ? '#F8FAFC' : palette.headerText;
  ctx.font = `800 ${Math.round(refH * 0.026)}px "Outfit", "Plus Jakarta Sans", sans-serif`;
  ctx.textBaseline = 'top';
  ctx.fillText(opts.title || 'Reading Practice', padX, titleY, contentW - 70);
  ctx.restore();

  // Divider line
  const dividerY = titleY + refH * 0.044;
  ctx.strokeStyle = isChalkboard ? 'rgba(255,255,255,0.2)' : palette.headerBg;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(padX, dividerY);
  ctx.lineTo(padX + contentW, dividerY);
  ctx.stroke();

  // Layout words with automatic multi-page pagination
  const wm = opts.watermarkOutro;
  const outroText = [wm.outroLine1.trim(), wm.outroLine2.trim()].filter(Boolean).join('\n');
  const timeline = computeReadingTimelineMetrics({
    words: opts.words,
    totalDuration: opts.totalDuration,
    contentDuration: opts.contentDuration,
    introEnabled: opts.introEnabled,
    introSeconds: opts.introSeconds,
    outroSeconds: wm.outroSeconds,
    outroText,
  });

  const startBodyY = dividerY + refH * 0.026;
  const maxBodyY = bookY + bookH - refH * 0.075;
  const inIntroPhase = timeline.hasIntro && opts.currentTime < timeline.introEnd;

  if (inIntroPhase) {
    // Dedicated Intro card ("Hôm nay học gì?") inside the book before words start
    ctx.save();
    const introProgress = Math.max(
      0,
      Math.min(1, opts.currentTime / Math.max(0.25, timeline.introEnd)),
    );
    const introFade = Math.min(1, opts.currentTime / 0.35 + 0.15);
    ctx.globalAlpha = introFade;

    const cardPad = Math.max(18, contentW * 0.05);
    const introBoxY = startBodyY + Math.max(8, (maxBodyY - startBodyY) * 0.06);
    const introBoxH = Math.max(160, (maxBodyY - startBodyY) * 0.78);
    ctx.fillStyle = isChalkboard ? 'rgba(15, 23, 42, 0.55)' : palette.headerBg;
    roundRectPath(ctx, padX, introBoxY, contentW, introBoxH, 20);
    ctx.fill();
    ctx.strokeStyle = isChalkboard ? 'rgba(253, 230, 138, 0.35)' : palette.pageBorder;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Intro header pill
    const introKicker = (opts.introTitle || 'HÔM NAY HỌC GÌ? · TODAY GOAL').trim();
    const kickerFs = Math.max(13, Math.round(refH * 0.016));
    ctx.font = `800 ${kickerFs}px "Plus Jakarta Sans", sans-serif`;
    const kickerW = Math.min(contentW - cardPad * 2, ctx.measureText(introKicker).width + 28);
    const kickerH = Math.max(28, Math.round(refH * 0.032));
    const kickerX = padX + (contentW - kickerW) / 2;
    const kickerY = introBoxY + cardPad;
    ctx.fillStyle = isChalkboard ? '#F59E0B' : palette.accent;
    roundRectPath(ctx, kickerX, kickerY, kickerW, kickerH, kickerH / 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(introKicker, padX + contentW / 2, kickerY + kickerH / 2, kickerW - 18);

    // Big lesson title
    const heroTitleFs = Math.max(22, Math.round(refH * 0.032));
    ctx.font = `800 ${heroTitleFs}px "Outfit", "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = isChalkboard ? '#F8FAFC' : palette.headerText;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const titleStartY = kickerY + kickerH + Math.max(16, refH * 0.024);
    ctx.fillText(opts.title || 'Reading Practice', padX + contentW / 2, titleStartY, contentW - cardPad * 2);

    // Wrapped intro subtitle / goal
    const introSub =
      (opts.introSubtitle || `Today we are going to read "${opts.title || 'this story'}". Listen carefully and follow word by word!`).trim();
    const subFs = Math.max(15, Math.round(refH * 0.019));
    ctx.font = `600 ${subFs}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = isChalkboard ? '#CBD5E1' : palette.bodyText;
    const maxSubW = contentW - cardPad * 2.2;
    const wordsArr = introSub.split(/\s+/).filter(Boolean);
    const wrappedSubLines: string[] = [];
    let curLine = '';
    for (const word of wordsArr) {
      const candidate = curLine ? `${curLine} ${word}` : word;
      if (ctx.measureText(candidate).width <= maxSubW) {
        curLine = candidate;
      } else {
        if (curLine) wrappedSubLines.push(curLine);
        curLine = word;
      }
    }
    if (curLine) wrappedSubLines.push(curLine);

    const subLineH = Math.round(subFs * 1.48);
    const subStartY = titleStartY + heroTitleFs + Math.max(16, refH * 0.022);
    wrappedSubLines.slice(0, 4).forEach((ln, idx) => {
      ctx.fillText(ln, padX + contentW / 2, subStartY + idx * subLineH, maxSubW);
    });

    // Progress bar at bottom of Intro card
    const barW = Math.min(contentW * 0.68, 460);
    const barH = 10;
    const barX = padX + (contentW - barW) / 2;
    const barY = introBoxY + introBoxH - cardPad - 24;
    ctx.fillStyle = isChalkboard ? 'rgba(255,255,255,0.16)' : 'rgba(15,23,42,0.1)';
    roundRectPath(ctx, barX, barY, barW, barH, barH / 2);
    ctx.fill();
    ctx.fillStyle = isChalkboard ? '#FACC15' : palette.accent;
    roundRectPath(ctx, barX, barY, Math.max(16, barW * introProgress), barH, barH / 2);
    ctx.fill();

    ctx.font = `700 ${Math.max(12, Math.round(refH * 0.014))}px "Plus Jakarta Sans", sans-serif`;
    ctx.fillStyle = isChalkboard ? '#FDE68A' : palette.spokenText;
    ctx.fillText('Chuẩn bị bắt đầu đọc...', padX + contentW / 2, barY + barH + 10);
    ctx.restore();
  } else {
    const bodyDuration = Math.max(1, timeline.contentEnd - timeline.introEnd);
    const wordsList =
      opts.words.length > 0
        ? opts.words
        : buildEstimatedReadingWords(opts.text, bodyDuration).map((w) => ({
            ...w,
            start: Number((w.start + timeline.introEnd).toFixed(3)),
            end: Number((w.end + timeline.introEnd).toFixed(3)),
          }));

    const fontSize = Math.max(15, Math.round(refH * 0.0235));
    const lineHeight = Math.round(fontSize * 1.72);
    const wordGap = Math.round(fontSize * 0.34);
    ctx.font = `600 ${fontSize}px "Plus Jakarta Sans", sans-serif`;

    const pages = paginateReadingWords(
      wordsList,
      (w) => ctx.measureText(w).width,
      {
        startX: padX,
        maxW: contentW,
        startY: startBodyY,
        maxY: maxBodyY,
        lineHeight,
        wordGap,
      },
    );

    // Spiral notebook ruled lines
    if (bookFrame === 'spiral-notebook') {
      ctx.save();
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.25)';
      ctx.lineWidth = 1.5;
      for (let ly = startBodyY + fontSize + 8; ly <= maxBodyY + fontSize; ly += lineHeight) {
        ctx.beginPath();
        ctx.moveTo(padX, ly);
        ctx.lineTo(padX + contentW, ly);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Find global active word index
    const clampedWordTime = Math.max(
      timeline.introEnd,
      Math.min(opts.currentTime, Math.max(timeline.introEnd, timeline.contentEnd - 0.001)),
    );
    let globalActiveIdx = wordsList.findIndex(
      (w) => clampedWordTime >= w.start && clampedWordTime <= w.end,
    );
    if (globalActiveIdx === -1 && wordsList.length > 0) {
      for (let i = wordsList.length - 1; i >= 0; i--) {
        if (clampedWordTime >= wordsList[i].start) {
          globalActiveIdx = i;
          break;
        }
      }
      if (globalActiveIdx === -1) globalActiveIdx = 0;
    }

    // Pick page holding globalActiveIdx
    const activePageIdx = Math.max(
      0,
      pages.findIndex((pg) => pg.some((p) => p.index === globalActiveIdx)),
    );
    const activePageWords = pages[activePageIdx] ?? pages[0] ?? [];

    // Draw words on current page
    for (let i = 0; i < activePageWords.length; i++) {
      const p = activePageWords[i];
      const isActive = p.index === globalActiveIdx;
      const isSpoken = p.index < globalActiveIdx;

      if (isActive) {
        ctx.save();
        ctx.fillStyle =
          pointerStyle === 'highlighter'
            ? 'rgba(250, 204, 21, 0.9)'
            : isChalkboard
              ? '#F59E0B'
              : palette.highlightBg;
        roundRectPath(
          ctx,
          p.x - 8,
          p.y - 6,
          p.w + 16,
          fontSize + 12,
          10,
        );
        ctx.fill();
        ctx.restore();
        ctx.fillStyle =
          pointerStyle === 'highlighter'
            ? '#0F172A'
            : isChalkboard
              ? '#0F172A'
              : palette.highlightText;
      } else if (isSpoken) {
        ctx.fillStyle = isChalkboard ? '#CBD5E1' : palette.spokenText;
      } else {
        ctx.fillStyle = isChalkboard ? '#F8FAFC' : palette.bodyText;
      }
      ctx.font = `${isActive ? 700 : 600} ${fontSize}px "Plus Jakarta Sans", sans-serif`;
      ctx.textBaseline = 'top';
      ctx.fillText(p.item.word, p.x, p.y);
    }

    // Multi-page indicator if >= 2 pages
    if (pages.length > 1) {
      ctx.save();
      const pgLabel = `Trang ${activePageIdx + 1}/${pages.length}`;
      ctx.font = `700 ${Math.max(12, Math.round(refH * 0.014))}px "Plus Jakarta Sans", sans-serif`;
      ctx.fillStyle = isChalkboard ? 'rgba(255,255,255,0.65)' : palette.spokenText;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'bottom';
      ctx.fillText(pgLabel, bookX + bookW - bookW * 0.05, bookY + bookH - Math.max(14, bookH * 0.026));
      ctx.restore();
    }

    // Pointer cursor smoothly glided toward next word on the same page
    const activePosIdx = activePageWords.findIndex((p) => p.index === globalActiveIdx);
    if (activePosIdx >= 0 && activePageWords[activePosIdx]) {
      const target = activePageWords[activePosIdx];
      const nextTarget =
        activePosIdx + 1 < activePageWords.length ? activePageWords[activePosIdx + 1] : null;
      let handX = target.x + target.w / 2;
      let handY = target.y + fontSize + 10;
      let interpW = target.w;

      if (nextTarget) {
        const wordDur = Math.max(0.08, target.item.end - target.item.start);
        const transitionWindow = Math.min(0.14, wordDur * 0.34);
        const timeRemaining = target.item.end - clampedWordTime;
        if (timeRemaining >= 0 && timeRemaining < transitionWindow) {
          const rawT = 1 - timeRemaining / transitionWindow;
          const ease = rawT * rawT * (3 - 2 * rawT);
          const nextX = nextTarget.x + nextTarget.w / 2;
          const nextY = nextTarget.y + fontSize + 10;
          handX = handX + (nextX - handX) * ease;
          handY = handY + (nextY - handY) * ease;
          interpW = target.w + (nextTarget.w - target.w) * ease;
        }
      }

      const scale = Math.max(0.6, Math.min(width, height) / 1080);
      drawReadingPointer(
        ctx,
        pointerStyle,
        handX,
        handY,
        interpW,
        fontSize,
        palette,
        scale,
        opts.currentTime,
        isChalkboard,
      );
    }
  }

  // Watermark overlay (always visible if enabled & non-empty)
  if (wm.watermarkEnabled && wm.watermarkText.trim()) {
    ctx.save();
    ctx.globalAlpha = Math.max(0.15, Math.min(1, wm.watermarkOpacity));
    const wmFontSize = Math.max(14, Math.round(height * 0.02));
    ctx.font = `700 ${wmFontSize}px "Plus Jakarta Sans", sans-serif`;
    const wmText = wm.watermarkText.trim();
    const tw = ctx.measureText(wmText).width;
    const pad = Math.round(width * 0.032);
    const boxW = tw + 22;
    const boxH = wmFontSize + 14;
    const x =
      wm.watermarkCorner === 'top-left' || wm.watermarkCorner === 'bottom-left'
        ? pad
        : width - pad - boxW;
    const y =
      wm.watermarkCorner === 'top-left' || wm.watermarkCorner === 'top-right'
        ? pad
        : height - pad - boxH;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.52)';
    roundRectPath(ctx, x, y, boxW, boxH, 10);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.textBaseline = 'middle';
    ctx.fillText(wmText, x + 11, y + boxH / 2);
    ctx.restore();
  }

  // Outro screen strictly after all content & words have completed
  if (timeline.hasOutro && outroText && opts.currentTime >= timeline.outroStart) {
    const progress = Math.min(
      1,
      (opts.currentTime - timeline.outroStart) / Math.min(0.55, Math.max(0.25, wm.outroSeconds)),
    );
    ctx.save();
    ctx.fillStyle = `rgba(15, 23, 42, ${(0.9 * progress).toFixed(3)})`;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = progress;
    ctx.fillStyle = '#FFFFFF';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const lines = outroText.split('\n');
    const outroSize = Math.max(24, Math.round(height * 0.036));
    ctx.font = `800 ${outroSize}px "Outfit", "Plus Jakarta Sans", sans-serif`;
    const baseLineY = height / 2 - ((lines.length - 1) * outroSize * 1.4) / 2;
    lines.forEach((line, idx) => {
      ctx.fillText(line, width / 2, baseLineY + idx * outroSize * 1.4, width * 0.85);
    });
    ctx.restore();
  }
}
