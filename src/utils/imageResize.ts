import { getStageDimensionsForAspect } from '../engine/canvasRenderer';
import type { ExportAspectRatioId } from '../engine/mp4Config';
import { BackgroundFitMode, BackgroundImageConfig } from '../engine/types';

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string' && reader.result.startsWith('data:')) {
        resolve(reader.result);
      } else {
        reject(new Error('Không đọc được dữ liệu file ảnh.'));
      }
    };
    reader.onerror = () => reject(new Error('Lỗi đọc file ảnh từ thiết bị.'));
    reader.readAsDataURL(file);
  });
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = async () => {
      if (typeof img.decode === 'function') {
        await img.decode().catch(() => undefined);
      }
      if ((img.naturalWidth || img.width) > 0 && (img.naturalHeight || img.height) > 0) {
        resolve(img);
      } else {
        reject(new Error('Ảnh nền có kích thước 0px không hợp lệ.'));
      }
    };
    img.onerror = () => reject(new Error('Trình duyệt không giải mã được định dạng ảnh này.'));
    img.src = src;
  });
}

async function decodeImageSource(file: File): Promise<{
  source: CanvasImageSource;
  width: number;
  height: number;
  cleanup: () => void;
}> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      if (bitmap.width > 0 && bitmap.height > 0) {
        return {
          source: bitmap,
          width: bitmap.width,
          height: bitmap.height,
          cleanup: () => bitmap.close(),
        };
      }
      bitmap.close();
    } catch {
      // Fall through to HTMLImageElement loaders
    }
  }

  let objectUrl: string | null = null;
  try {
    objectUrl = URL.createObjectURL(file);
    const img = await loadImageElement(objectUrl);
    const urlToRevoke = objectUrl;
    objectUrl = null;
    return {
      source: img,
      width: img.naturalWidth || img.width,
      height: img.naturalHeight || img.height,
      cleanup: () => URL.revokeObjectURL(urlToRevoke),
    };
  } catch {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }

  const rawDataUrl = await readFileAsDataUrl(file);
  const img = await loadImageElement(rawDataUrl);
  return {
    source: img,
    width: img.naturalWidth || img.width,
    height: img.naturalHeight || img.height,
    cleanup: () => undefined,
  };
}

export async function resizeImageFileToStageDataUrl(
  file: File,
  options?: { fit?: BackgroundFitMode; scrimOpacity?: number; aspectRatio?: ExportAspectRatioId },
): Promise<BackgroundImageConfig> {
  const looksLikeImage =
    file.type.startsWith('image/') ||
    /\.(png|jpe?g|webp|gif|bmp|avif|svg)$/i.test(file.name || '');
  if (!looksLikeImage) {
    throw new Error('Vui lòng chọn đúng định dạng ảnh (PNG, JPG, WebP...).');
  }
  if (file.size === 0) {
    throw new Error('File ảnh rỗng.');
  }

  const decoded = await decodeImageSource(file);
  try {
    const fit: BackgroundFitMode = options?.fit ?? 'cover';
    const stage = getStageDimensionsForAspect(options?.aspectRatio);
    const canvas = document.createElement('canvas');
    canvas.width = stage.width;
    canvas.height = stage.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Không khởi tạo được Canvas để xử lý ảnh nền.');
    }

    const srcW = Math.max(1, decoded.width);
    const srcH = Math.max(1, decoded.height);
    const scale =
      fit === 'contain'
        ? Math.min(stage.width / srcW, stage.height / srcH)
        : Math.max(stage.width / srcW, stage.height / srcH);
    const dw = Math.max(1, Math.round(srcW * scale));
    const dh = Math.max(1, Math.round(srcH * scale));
    const dx = Math.round((stage.width - dw) / 2);
    const dy = Math.round((stage.height - dh) / 2);

    ctx.fillStyle = '#0F172A';
    ctx.fillRect(0, 0, stage.width, stage.height);
    ctx.drawImage(decoded.source, dx, dy, dw, dh);

    let dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      dataUrl = canvas.toDataURL('image/png');
    }
    if (!dataUrl || !dataUrl.startsWith('data:image/')) {
      throw new Error('Không xuất được dữ liệu ảnh nền.');
    }

    return {
      dataUrl,
      fileName: file.name,
      fit,
      scrimOpacity: options?.scrimOpacity ?? 0.22,
    };
  } finally {
    decoded.cleanup();
  }
}
