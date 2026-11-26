export type SupportedTtsLang = 'en' | 'vi' | 'ja' | 'zh' | 'ko' | 'fr' | 'es';

export interface TtsLanguageSpan {
  text: string;
  lang: SupportedTtsLang;
  voice: string;
}

const DEFAULT_EDGE_VOICE_BY_LANG: Record<SupportedTtsLang, string> = {
  en: 'en-US-JennyNeural',
  vi: 'vi-VN-HoaiMyNeural',
  ja: 'ja-JP-NanamiNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  ko: 'ko-KR-SunHiNeural',
  fr: 'fr-FR-DeniseNeural',
  es: 'es-ES-ElviraNeural',
};

const RE_HAS_KANA = /[\u3040-\u30ff\u31f0-\u31ff\uff65-\uff9f]/;
const RE_HAS_CJK = /[\u4e00-\u9faf\u3400-\u4dbf\u3005\u3006]/;
const RE_HAS_HANGUL = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;
const RE_HAS_VI_DIACRITIC =
  /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹĂÂĐÊÔƠƯÀÁẠẢÃẰẮẶẲẴẦẤẬẨẪÈÉẸẺẼỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕỒỐỘỔỖỜỚỢỞỠÙÚỤỦŨỪỨỰỬỮỲÝỴỶỸ]/;
const RE_HAS_FR_ES_DIACRITIC = /[çœæñ¿¡éèêëàâîïôùûüÿáíóú]/i;
const RE_HAS_SPOKEN_CHAR = /[A-Za-z0-9À-ỹ\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9faf\uac00-\ud7af]/;

const RE_HAS_PINYIN_TONE = /[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ]/;

// Unaccented lowercase tokens that exist in Vietnamese phrases and do not collide with standard English words.
const UNAMBIGUOUS_VI_ASCII = new Set([
  'khong',
  'duoc',
  'nguoi',
  'tieng',
  'viet',
  'nhung',
  'nhieu',
  'nhien',
  'nhau',
  'nhin',
  'ngay',
  'nghe',
  'nghi',
  'ngoi',
  'trong',
  'truoc',
  'chua',
  'chung',
  'chinh',
  'chuyen',
  'thay',
  'theo',
  'them',
  'thich',
  'thoi',
  'thong',
  'thuong',
  'khac',
  'khi',
  'khoe',
  'biet',
  'buoc',
  'buon',
  'duong',
  'dung',
  'giup',
  'giong',
  'giua',
  'huong',
  'hoac',
  'hieu',
  'hoc',
  'hom',
  'muon',
  'minh',
  'moi',
  'nay',
  'nao',
  'nen',
  'neu',
  'phai',
  'phan',
  'phat',
  'phuong',
  'quyen',
  'rieng',
  'sach',
  'sau',
  'sinh',
  'suy',
  'thanh',
  'thao',
  'thieu',
  'tinh',
  'toan',
  'toi',
  'tong',
  'tuy',
  'viec',
  'vong',
  'vui',
  'xem',
  'xong',
  'xuat',
  'yeu',
  'cua',
  'cho',
  'luon',
  'chac',
  'thuc',
  'dien',
  'dat',
  'giai',
  'xin',
  'chao',
  'vung',
  'phap',
  'ngu',
  'cau',
  'nghia',
  'nhe',
  'nha',
  'luyen',
  'nho',
  'chuan',
  'xac',
  'trinh',
  'cung',
  'deu',
  'sao',
  'chuc',
  'mung',
  'cac',
]);

// Words that overlap with English/French ("la", "tu", "ban", "day", "the", "hay", "doc", "cam", "rat", "lam", "noi")
// should ONLY be classified as Vietnamese when primary language is non-Latin (zh/ja/ko) or Vietnamese AND the text has Vietnamese diacritics.
const CONTEXTUAL_VI_ASCII = new Set([
  'la',
  'tu',
  'ban',
  'doc',
  'hay',
  'day',
  'sao',
  'the',
  'cam',
  'rat',
  'lam',
  'noi',
  'anh',
  'em',
  'chi',
  'con',
  'co',
  'di',
  've',
  'ra',
  'vao',
  'len',
  'xuong',
  'qua',
  'lai',
  'het',
  'roi',
  'nua',
  'dau',
  'gi',
  'ai',
  'ma',
  'thi',
  'de',
  'voi',
  'va',
  'nhu',
  'tai',
  'vi',
]);

export function normalizeTtsLangCode(raw?: string): SupportedTtsLang {
  const low = String(raw || '').trim().toLowerCase();
  if (!low) return 'en';
  if (low.startsWith('vi') || low.includes('viet')) return 'vi';
  if (low.startsWith('ja') || low === 'jp' || low.includes('japan') || low.includes('nhật') || low.includes('日本')) {
    return 'ja';
  }
  if (low.startsWith('zh') || low.includes('chin') || low.includes('trung') || low.includes('中文')) return 'zh';
  if (low.startsWith('ko') || low.includes('kor') || low.includes('hàn') || low.includes('한국')) return 'ko';
  if (low.startsWith('fr') || low.includes('fren') || low.includes('pháp') || low.includes('fran')) return 'fr';
  if (low.startsWith('es') || low.includes('span') || low.includes('tây ban nha') || low.includes('espa')) return 'es';
  return 'en';
}

export function detectVoiceLangCode(voiceId?: string): SupportedTtsLang | null {
  const v = String(voiceId || '').trim();
  if (!v) return null;
  const low = v.toLowerCase();
  if (low.startsWith('vi-') || low === 'vi') return 'vi';
  if (low.startsWith('ja-') || low === 'ja' || low === 'mizuki' || low === 'takumi') return 'ja';
  if (low.startsWith('zh-') || low.startsWith('zh')) return 'zh';
  if (low.startsWith('ko-') || low === 'ko') return 'ko';
  if (low.startsWith('fr-') || low === 'fr') return 'fr';
  if (low.startsWith('es-') || low === 'es') return 'es';
  if (low.startsWith('en-') || low === 'en' || low === 'joanna' || low === 'matthew' || low === 'amy' || low === 'brian') {
    return 'en';
  }
  return null;
}

export function pickVoiceForLangCode(langCode: SupportedTtsLang, requestedVoice?: string): string {
  const req = String(requestedVoice || '').trim();
  if (req) {
    const reqLang = detectVoiceLangCode(req);
    if (reqLang === langCode) {
      return req;
    }
    const looksRegional = reqLang !== null || req.includes('Neural') || /^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(req);
    if (!looksRegional) {
      return req;
    }
  }
  return DEFAULT_EDGE_VOICE_BY_LANG[langCode] || DEFAULT_EDGE_VOICE_BY_LANG.en;
}

export function pickLearningDefaultVoice(learningLang: string): string {
  return DEFAULT_EDGE_VOICE_BY_LANG[normalizeTtsLangCode(learningLang)] || 'en-US-JennyNeural';
}

export function pickExplanationDefaultVoice(targetExplainLang: string): string {
  const code = normalizeTtsLangCode(targetExplainLang);
  return DEFAULT_EDGE_VOICE_BY_LANG[code] || 'vi-VN-HoaiMyNeural';
}

interface RawPiece {
  raw: string;
  kind: 'word' | 'cjk' | 'hangul' | 'num' | 'punct';
  langHint: SupportedTtsLang | null;
}

export function splitMixedLanguageTtsSpans(
  text: string,
  opts: {
    primaryLang?: string;
    secondaryLang?: string;
    primaryVoice?: string;
    secondaryVoice?: string;
    autoSplit?: boolean;
  } = {},
): TtsLanguageSpan[] {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];

  const primary = normalizeTtsLangCode(opts.primaryLang || detectVoiceLangCode(opts.primaryVoice) || 'en');
  const secondary = normalizeTtsLangCode(
    opts.secondaryLang ||
      detectVoiceLangCode(opts.secondaryVoice) ||
      (primary === 'vi' ? 'en' : 'vi'),
  );

  const voiceForLang = (lang: SupportedTtsLang): string => {
    if (lang === primary && opts.primaryVoice) {
      return pickVoiceForLangCode(lang, opts.primaryVoice);
    }
    if (lang === secondary && opts.secondaryVoice) {
      return pickVoiceForLangCode(lang, opts.secondaryVoice);
    }
    return pickVoiceForLangCode(lang);
  };

  if (opts.autoSplit === false) {
    return [{ text: clean, lang: primary, voice: voiceForLang(primary) }];
  }

  // Strip parenthesized Pinyin (containing tone marks like nǐ hǎo / xǐ shǒu jiān) when speaking Mandarin
  const spokenPrepared =
    primary === 'zh' || secondary === 'zh' || RE_HAS_CJK.test(clean)
      ? clean
          .replace(/\s*\([^)]*[āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ][^)]*\)/g, '')
          .replace(/\s+/g, ' ')
          .trim() || clean
      : clean;

  // Tokenize into script-homogeneous pieces + separators
  const regex =
    /([\u3040-\u30ff\u31f0-\u31ff\uff65-\uff9f\u3400-\u4dbf\u4e00-\u9faf\u3005\u3006ー々]+)|([\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]+)|([A-Za-zÀ-ỹāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ][A-Za-zÀ-ỹāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜĀÁǍÀĒÉĚÈĪÍǏÌŌÓǑÒŪÚǓÙǕǗǙǛ'’-]*)|(\d+(?:[.,:/-]\d+)*%?)|(\s+|[^\sA-Za-zÀ-ỹ0-9\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9faf\uac00-\ud7af]+)/g;

  const pieces: RawPiece[] = [];
  let match: RegExpExecArray | null;
  const textContainsViDiacritics = RE_HAS_VI_DIACRITIC.test(spokenPrepared);
  const textContainsKana = RE_HAS_KANA.test(spokenPrepared);
  const primaryIsNonLatin = primary === 'zh' || primary === 'ja' || primary === 'ko';
  const secondaryIsVi = secondary === 'vi' || primary === 'vi';

  while ((match = regex.exec(spokenPrepared)) !== null) {
    const raw = match[0];
    if (match[1]) {
      const lang: SupportedTtsLang =
        RE_HAS_KANA.test(raw) || primary === 'ja' || secondary === 'ja' || textContainsKana
          ? 'ja'
          : 'zh';
      pieces.push({ raw, kind: 'cjk', langHint: lang });
    } else if (match[2]) {
      pieces.push({ raw, kind: 'hangul', langHint: 'ko' });
    } else if (match[3]) {
      let langHint: SupportedTtsLang | null = null;
      if (RE_HAS_VI_DIACRITIC.test(raw)) {
        langHint = 'vi';
      } else if (RE_HAS_PINYIN_TONE.test(raw)) {
        langHint = primary === 'zh' || secondary === 'zh' ? 'zh' : 'en';
      } else {
        const lower = raw.toLowerCase();
        if (
          (textContainsViDiacritics || secondaryIsVi) &&
          (UNAMBIGUOUS_VI_ASCII.has(lower) ||
            ((primaryIsNonLatin || primary === 'vi' || (pieces.length > 0 && RE_HAS_VI_DIACRITIC.test(pieces.slice(-4).map((p) => p.raw).join('')))) &&
              textContainsViDiacritics &&
              CONTEXTUAL_VI_ASCII.has(lower)))
        ) {
          langHint = 'vi';
        } else if ((primary === 'fr' || primary === 'es') && (RE_HAS_FR_ES_DIACRITIC.test(raw) || secondary !== 'en')) {
          langHint = primary;
        } else if ((secondary === 'fr' || secondary === 'es') && RE_HAS_FR_ES_DIACRITIC.test(raw)) {
          langHint = secondary;
        } else if (primary === 'fr' || primary === 'es') {
          langHint = primary;
        } else {
          langHint = 'en';
        }
      }
      pieces.push({ raw, kind: 'word', langHint });
    } else if (match[4]) {
      pieces.push({ raw, kind: 'num', langHint: null });
    } else {
      pieces.push({ raw, kind: 'punct', langHint: null });
    }
  }

  if (pieces.length === 0) {
    return [{ text: spokenPrepared, lang: primary, voice: voiceForLang(primary) }];
  }

  // Resolve unassigned Latin ambiguous tokens between strong VI neighbors only if primary is VI and secondary is VI
  // Resolve numbers & punctuation by inheriting nearest spoken neighbor (prefer left for trailing punct, right for leading punct)
  const resolvedLangs: Array<SupportedTtsLang | null> = pieces.map((p) => p.langHint);

  let lastKnown: SupportedTtsLang | null = null;
  for (let i = 0; i < pieces.length; i++) {
    if (resolvedLangs[i]) {
      lastKnown = resolvedLangs[i];
    } else if (pieces[i].kind === 'num' || pieces[i].kind === 'punct') {
      if (lastKnown) {
        resolvedLangs[i] = lastKnown;
      }
    }
  }

  let nextKnown: SupportedTtsLang | null = primary;
  for (let i = pieces.length - 1; i >= 0; i--) {
    if (resolvedLangs[i]) {
      nextKnown = resolvedLangs[i];
    } else {
      resolvedLangs[i] = nextKnown;
    }
  }

  // Merge contiguous pieces with same language
  const merged: Array<{ text: string; lang: SupportedTtsLang }> = [];
  for (let i = 0; i < pieces.length; i++) {
    const lang = resolvedLangs[i] || primary;
    const raw = pieces[i].raw;
    const last = merged[merged.length - 1];
    if (last && last.lang === lang) {
      last.text += raw;
    } else {
      merged.push({ text: raw, lang });
    }
  }

  // Clean up whitespace & discard pure punctuation-only fragments (merging into adjacent spoken span)
  const spokenSpans: Array<{ text: string; lang: SupportedTtsLang }> = [];
  for (const item of merged) {
    const trimmed = item.text.trim();
    if (!trimmed) continue;
    if (!RE_HAS_SPOKEN_CHAR.test(trimmed)) {
      if (spokenSpans.length > 0) {
        spokenSpans[spokenSpans.length - 1].text = `${spokenSpans[spokenSpans.length - 1].text}${trimmed}`;
      }
      continue;
    }
    const prev = spokenSpans[spokenSpans.length - 1];
    if (prev && prev.lang === item.lang) {
      prev.text = `${prev.text} ${trimmed}`.replace(/\s+/g, ' ').trim();
    } else {
      spokenSpans.push({ text: trimmed, lang: item.lang });
    }
  }

  if (spokenSpans.length === 0) {
    return [{ text: clean, lang: primary, voice: voiceForLang(primary) }];
  }

  return spokenSpans.map((span) => ({
    text: span.text,
    lang: span.lang,
    voice: voiceForLang(span.lang),
  }));
}
