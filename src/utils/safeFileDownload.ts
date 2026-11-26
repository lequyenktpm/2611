export function isHtmlPayload(textOrPrefix: string, contentType?: string | null): boolean {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) {
    return true;
  }
  const sample = (textOrPrefix || '').trimStart().slice(0, 600).toLowerCase();
  if (!sample) return false;
  if (
    sample.startsWith('<!doctype html') ||
    sample.startsWith('<html') ||
    sample.startsWith('<head') ||
    sample.startsWith('<body') ||
    sample.startsWith('<meta ') ||
    sample.startsWith('<script')
  ) {
    return true;
  }
  if (/^\s*<!--[\s\S]*?-->\s*(<!doctype html|<html)/i.test(sample)) {
    return true;
  }
  return false;
}

export function resolveOutputMimeType(fileName: string): string {
  const lower = (fileName || '').toLowerCase();
  if (lower.endsWith('.txt') || lower.endsWith('.srt') || lower.endsWith('.md')) {
    return 'text/plain; charset=utf-8';
  }
  if (lower.endsWith('.vtt')) {
    return 'text/vtt; charset=utf-8';
  }
  if (lower.endsWith('.json')) {
    return 'application/json; charset=utf-8';
  }
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) {
    return 'video/mp4';
  }
  if (lower.endsWith('.webm')) {
    return 'video/webm';
  }
  if (lower.endsWith('.mov')) {
    return 'video/quicktime';
  }
  if (lower.endsWith('.mp3')) {
    return 'audio/mpeg';
  }
  if (lower.endsWith('.wav')) {
    return 'audio/wav';
  }
  if (lower.endsWith('.m4a')) {
    return 'audio/mp4';
  }
  if (lower.endsWith('.zip')) {
    return 'application/zip';
  }
  return 'application/octet-stream';
}

export function ensureExpectedExtension(fileName: string, expectedExt?: string): string {
  const clean = (fileName || 'output').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'output';
  if (!expectedExt) return clean;
  const normalizedExt = expectedExt.startsWith('.') ? expectedExt : `.${expectedExt}`;
  if (clean.toLowerCase().endsWith(normalizedExt.toLowerCase())) {
    return clean;
  }
  return `${clean.replace(/\.[^.]+$/, '')}${normalizedExt}`;
}

export function triggerSafeBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function downloadTextAsPlainFile(text: string, fileName: string): void {
  const safeName = ensureExpectedExtension(
    fileName,
    /\.(txt|srt|vtt|md|json)$/i.test(fileName) ? undefined : '.txt',
  );
  const mime = resolveOutputMimeType(safeName);
  const blob = new Blob([text], { type: mime });
  triggerSafeBlobDownload(blob, safeName);
}

export function isTextBasedOutputName(fileName: string): boolean {
  return /\.(txt|srt|vtt|md|json)$/i.test(fileName || '');
}

export async function downloadServerOutputFile(
  relativePath: string,
  fallbackFileName?: string,
): Promise<{ ok: boolean; fileName: string; error?: string }> {
  const baseName =
    fallbackFileName ||
    relativePath.split('/').filter(Boolean).pop() ||
    'output';

  try {
    const res = await fetch(`/api/output/download?path=${encodeURIComponent(relativePath)}`, {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return {
        ok: false,
        fileName: baseName,
        error: errText && !isHtmlPayload(errText) ? errText : `Không tải được file (HTTP ${res.status}).`,
      };
    }

    const contentType = res.headers.get('content-type');
    if (isTextBasedOutputName(baseName)) {
      const text = await res.text();
      if (isHtmlPayload(text, contentType)) {
        return {
          ok: false,
          fileName: baseName,
          error: 'Phản hồi tải file bị chuyển hướng sang HTML thay vì nội dung văn bản.',
        };
      }
      downloadTextAsPlainFile(text, baseName);
      return { ok: true, fileName: baseName };
    }

    if (contentType && contentType.toLowerCase().includes('text/html')) {
      return {
        ok: false,
        fileName: baseName,
        error: 'Phản hồi tải file trả về HTML thay vì file media.',
      };
    }

    const rawBlob = await res.blob();
    const mime = resolveOutputMimeType(baseName);
    const typedBlob =
      rawBlob.type && !rawBlob.type.toLowerCase().includes('text/html')
        ? rawBlob
        : new Blob([rawBlob], { type: mime });
    triggerSafeBlobDownload(typedBlob, baseName);
    return { ok: true, fileName: baseName };
  } catch (err) {
    return {
      ok: false,
      fileName: baseName,
      error: err instanceof Error ? err.message : 'Lỗi kết nối khi tải file.',
    };
  }
}
