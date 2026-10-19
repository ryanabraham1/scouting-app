// src/dash/board/images.ts
// Pasted/dropped images are downscaled (long side <= 1600px) and re-encoded as
// WebP before they enter the board, so a phone photo doesn't add megabytes to
// local storage and every sync. P2 moves the bytes to the board-assets bucket.

const MAX_SIDE = 1600;

export interface PreparedImage {
  src: string;
  width: number;
  height: number;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = url;
  });
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read failed'));
    r.readAsDataURL(blob);
  });
}

export async function prepareImage(file: Blob): Promise<PreparedImage> {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const width = Math.max(1, Math.round(img.naturalWidth * scale));
    const height = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.85));
    // Safari without WebP encode returns PNG; either way it's a data URL.
    const src = blob ? await blobToDataUrl(blob) : canvas.toDataURL('image/png');
    return { src, width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function imageFilesOf(list: DataTransferItemList | FileList | null | undefined): File[] {
  if (!list) return [];
  const out: File[] = [];
  if ('length' in list && typeof (list as FileList).item === 'function' && list instanceof FileList) {
    for (const f of Array.from(list)) if (f.type.startsWith('image/')) out.push(f);
    return out;
  }
  for (const item of Array.from(list as DataTransferItemList)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  return out;
}
