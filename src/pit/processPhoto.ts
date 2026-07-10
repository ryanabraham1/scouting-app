export const MAX_PIT_PHOTOS = 6;
export const MAX_PIT_PHOTO_BYTES = 5 * 1024 * 1024;
const MAX_DIMENSION = 2048;

export interface ProcessedPitPhoto {
  blob: Blob;
  width: number;
  height: number;
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This image format could not be read. Choose a JPEG, PNG, or WebP image.'));
    };
    image.src = url;
  });
}

function canvasBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error('The image could not be processed.')),
      'image/jpeg',
      quality,
    );
  });
}

export async function processPitPhoto(file: Blob): Promise<ProcessedPitPhoto> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Choose an image file.');
  }
  const image = await loadImage(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Image processing is not available on this device.');
  context.drawImage(image, 0, 0, width, height);

  let blob = await canvasBlob(canvas, 0.86);
  if (blob.size > MAX_PIT_PHOTO_BYTES) blob = await canvasBlob(canvas, 0.68);
  if (blob.size > MAX_PIT_PHOTO_BYTES) {
    throw new Error('This photo is still over 5 MB after resizing. Choose a smaller image.');
  }
  return { blob, width, height };
}
