export type ReadingCefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

export interface ReadingWebPromptOptions {
  mode: 'web-url' | 'topic';
  url?: string;
  sourceTitle?: string;
  sourceText?: string;
  topic?: string;
  level: ReadingCefrLevel;
  wordCount?: number;
  durationMinutes?: number;
}

export interface ParsedReadingPassage {
  title: string;
  topicBadge: string;
  level?: string;
  text: string;
}

const LEVEL_GUIDANCE: Record<ReadingCefrLevel, string> = {
  A1: 'CEFR A1 Beginner: câu ngắn rõ ràng (6-10 từ/câu), từ vựng thông dụng hằng ngày, thì hiện tại đơn / quá khứ đơn dễ đọc.',
  A2: 'CEFR A2 Elementary: câu đơn giản mạch lạc (8-13 từ/câu), từ vựng giao tiếp đời sống, liên từ tự nhiên.',
  B1: 'CEFR B1 Intermediate: tiếng Anh tự nhiên mượt mà (10-16 từ/câu), phù hợp kể chuyện và luyện phát âm.',
  B2: 'CEFR B2 Upper-Intermediate: cấu trúc đa dạng, có cụm từ tự nhiên/collocations hay, nhịp đọc cuốn hút.',
  C1: 'CEFR C1 Advanced: văn phong sắc sảo, từ vựng học thuật/tinh tế nhưng vẫn dễ đọc thành tiếng.',
};

export interface CleanedReadingWorksheet {
  title: string;
  bodyText: string;
  lines: string[];
}

const WORKSHEET_SCAFFOLDING_PATTERNS: RegExp[] = [
  /^(?:practice\s+)?reading\s+(?:english\s+)?exercises?(?:\s+for\s+(?:beginner|elementary|intermediate|advanced|kids|students))?(?:\s*[-–—:|].*)?$/i,
  /^english\s+reading\s+(?:exercises?|practice|comprehension|passages?)(?:\s+for\s+(?:beginner|elementary|intermediate|advanced))?(?:\s*[-–—:|].*)?$/i,
  /^(?:exercise|part|task|activity|unit|module|section|worksheet)\s*(?:#?\d+|[ivxlcdm]+)?(?:\s*[-–—:.].{0,40})?$/i,
  /^(?:reading\s+(?:comprehension|passage|exercise|task)|true\s*\/\s*false(?:\s+quiz)?|multiple\s+choice|comprehension(?:\s+quiz)?|vocabulary(?:\s+list)?|answer\s*key|warm[\s-]*up|before\s+reading|after\s+reading)\s*:?$/i,
  /^(?:level|cefr)\s*[:\-]?\s*(?:a1|a2|b1|b2|c1|c2|beginner|elementary|intermediate)\b.*$/i,
  /^(?:read\s+the\s+(?:text|passage|article|story)\s+(?:below|carefully)?(?:\s+and\s+answer.*)?)[.:]?$/i,
];

export function isWorksheetScaffoldingLine(line: string): boolean {
  const cleaned = line
    .replace(/^#+\s*/, '')
    .replace(/^[-*•>\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return true;
  if (/^[-_=*~]{3,}$/.test(cleaned)) return true;
  return WORKSHEET_SCAFFOLDING_PATTERNS.some((re) => re.test(cleaned));
}

export function cleanReadingWorksheetInput(
  rawText: string,
  suggestedTitle?: string,
): CleanedReadingWorksheet {
  const normalized = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/\\n/g, '\n')
    .trim();

  if (!normalized) {
    return {
      title: (suggestedTitle || 'Reading Practice').trim() || 'Reading Practice',
      bodyText: '',
      lines: [],
    };
  }

  const rawLines = normalized
    .split(/\n+/)
    .map((l) => l.replace(/^#+\s*/, '').replace(/^[-*•]\s+/, '').trim())
    .filter(Boolean);

  const filteredLines = rawLines.filter((line) => !isWorksheetScaffoldingLine(line));

  let detectedTitle = '';
  let bodyLines = [...filteredLines];

  // If the first non-scaffolding line looks like a passage title (e.g., "Outside the COMFORT ZONE")
  // rather than a full sentence ending in . ! ? (or short <= 68 chars before prose), extract as title.
  if (bodyLines.length >= 2) {
    const first = bodyLines[0];
    const wordCount = first.split(/\s+/).filter(Boolean).length;
    const isVocabEntryLine = /\/[^/\n]{2,}\/\s*[-–—:=→]?|^\S+(?:\s+\S+){0,3}\s+(?:[-–—→:=])\s+\S+/i.test(first);
    const looksLikeTitle =
      first.length <= 72 &&
      wordCount <= 10 &&
      !isVocabEntryLine &&
      !/[.!?…]$/.test(first) &&
      !/^(?:Q?\d+[.)]|\([A-Da-d]\)|[A-Da-d][.)])\s+/.test(first);
    if (looksLikeTitle) {
      detectedTitle = first;
      bodyLines = bodyLines.slice(1);
    }
  }

  const cleanSuggested = (suggestedTitle || '').replace(/^#+\s*/, '').trim();
  const useSuggested =
    cleanSuggested && !isWorksheetScaffoldingLine(cleanSuggested) ? cleanSuggested : '';

  const title = detectedTitle || useSuggested || 'Reading Practice';

  // Drop duplicate title if still at top of bodyLines
  if (
    bodyLines.length > 1 &&
    bodyLines[0].toLowerCase() === title.toLowerCase()
  ) {
    bodyLines = bodyLines.slice(1);
  }

  return {
    title,
    bodyText: bodyLines.join('\n'),
    lines: bodyLines,
  };
}

export function buildReadingWebAiPrompt(opts: ReadingWebPromptOptions): string {
  const level = opts.level || 'B1';
  const durationMinutes =
    typeof opts.durationMinutes === 'number' &&
    Number.isFinite(opts.durationMinutes) &&
    opts.durationMinutes > 0
      ? Math.max(0.5, Math.min(15, Number(opts.durationMinutes.toFixed(1))))
      : undefined;
  const fallbackWords = durationMinutes ? Math.round(durationMinutes * 125) : 110;
  const wordCount = Math.max(40, Math.min(1500, Math.round(opts.wordCount || fallbackWords)));
  const estimatedMinutesLabel = durationMinutes
    ? `${durationMinutes} phút (~${Math.round(durationMinutes * 60)} giây)`
    : `~${Math.max(0.5, Number((wordCount / 125).toFixed(1)))} phút`;
  const cleanUrl = (opts.url || '').trim();
  const cleanSource = (opts.sourceText || '').trim().slice(0, 8500);
  const cleanTopic = (opts.topic || '').trim();

  const sourceBlock =
    opts.mode === 'web-url'
      ? cleanSource
        ? `NGUỒN BÀI VIẾT TỪ WEB${cleanUrl ? ` (${cleanUrl})` : ''}:
Tiêu đề gốc: ${opts.sourceTitle || 'Web Article'}
Nội dung đã trích xuất:
"""
${cleanSource}
"""
Hãy loại bỏ toàn bộ tiêu đề khung bài tập/worksheet (như "Practice Reading...", "English Reading Exercises...", "Exercise 1", "Part 1", menu web) và biên tập lại thành bài đọc tiếng Anh hay nhất từ nội dung chính trên.`
        : `HÃY TRUY CẬP / ĐỌC NỘI DUNG TỪ ĐƯỜNG LINK SAU VÀ BIÊN TẬP THÀNH BÀI ĐỌC:
URL: ${cleanUrl || '(người dùng sẽ dán URL)'}
(Nếu bạn không truy cập trực tiếp được link, hãy dựa theo chủ đề trong URL "${cleanUrl}" hoặc nội dung liên quan để viết bài đọc chuẩn xác).`
      : `CHỦ ĐỀ BÀI ĐỌC: "${cleanTopic || 'Morning habits for better focus'}"`;

  return `# VAI TRÒ
Bạn là Chuyên gia thiết kế giáo trình luyện đọc tiếng Anh (Reading Along Karaoke Video).

# NHIỆM VỤ
${sourceBlock}

# YÊU CẦU TRÌNH ĐỘ & ĐỘ DÀI
- Trình độ: ${LEVEL_GUIDANCE[level]}
- Thời lượng render mục tiêu: **${estimatedMinutesLabel}** → Độ dài mục tiêu khoảng **${wordCount} từ tiếng Anh**${durationMinutes && durationMinutes >= 2 ? ' (mở rộng câu chuyện/bài phân tích đủ sâu và phong phú kiến thức cho đúng số phút mong muốn)' : ''}.
- TUYỆT ĐỐI KHÔNG đưa các dòng nhãn bài tập ("Practice Reading English Exercises...", "Exercise 1", "Part 1") hoặc tiêu đề markdown \`##\` vào trường \`text\`. Chỉ giữ các câu đọc tiếng Anh hoàn chỉnh.
- Mỗi câu viết trên **1 dòng riêng** (ngăn cách bằng \\n), KHÔNG đánh số thứ tự, KHÔNG gắn timestamp, KHÔNG markdown (\`**\`, \`*\`), KHÔNG emoji, để app đọc TTS & chạy bàn tay chỉ chữ chính xác từng từ.

# ĐỊNH DẠNG ĐẦU RA BẮT BUỘC (CHỈ TRẢ VỀ 1 KHỐI JSON)
\`\`\`json
{
  "title": "Tiêu đề tiếng Anh ngắn gọn, thu hút",
  "topicBadge": "CEFR ${level} · READING",
  "level": "${level}",
  "text": "Sentence one goes here.\\nSentence two goes here.\\nSentence three continues the story."
}
\`\`\``;
}

export function parseReadingWebAiResponse(
  rawInput: string,
  fallbackLevel: ReadingCefrLevel = 'B1',
): ParsedReadingPassage | null {
  const raw = rawInput.trim();
  if (!raw) return null;

  // 1. Try stripping markdown fences and parsing JSON
  const cleanedJson = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();

  const jsonMatch = cleanedJson.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const obj = JSON.parse(jsonMatch[0]) as {
        title?: string;
        topicBadge?: string;
        level?: string;
        text?: string;
        content?: string;
        passage?: string;
      };
      const rawPassage = String(obj.text || obj.content || obj.passage || '').trim();
      if (rawPassage) {
        const cleanedWorksheet = cleanReadingWorksheetInput(rawPassage, obj.title);
        const cleanLines = cleanedWorksheet.lines
          .map((l) => l.replace(/^\s*[-*•\d.)]+\s*/, '').trim())
          .filter(Boolean);
        return {
          title: (obj.title ? String(obj.title).replace(/^#+\s*/, '').trim() : cleanedWorksheet.title)
            .slice(0, 90) || 'Reading Practice',
          topicBadge: String(obj.topicBadge || `CEFR ${obj.level || fallbackLevel} · READING`)
            .trim()
            .slice(0, 48),
          level: obj.level ? String(obj.level) : fallbackLevel,
          text: cleanLines.join('\n'),
        };
      }
    } catch {
      // Fall through to plain-text mode
    }
  }

  // 2. Plain text fallback: strip worksheet scaffolding & split sentences cleanly
  const cleanedPlain = cleanReadingWorksheetInput(
    raw.replace(/^```[a-z]*\s*/gim, '').replace(/```$/gm, ''),
  );
  if (cleanedPlain.lines.length === 0) return null;

  let bodyLines = cleanedPlain.lines;
  // If a single dense paragraph was pasted, split cleanly by sentence boundaries
  if (bodyLines.length === 1 && bodyLines[0].length > 90) {
    const splitSentences = bodyLines[0]
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (splitSentences.length > 1) bodyLines = splitSentences;
  }

  return {
    title: cleanedPlain.title || 'Custom Web Reading',
    topicBadge: `CEFR ${fallbackLevel} · WEB READING`,
    level: fallbackLevel,
    text: bodyLines.join('\n'),
  };
}
