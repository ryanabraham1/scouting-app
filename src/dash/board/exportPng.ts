import type { BoardEditor } from './editor';
import { unionRects } from './model';

export function exportBounds(editor: BoardEditor): { x: number; y: number; w: number; h: number } | null {
  const shapes = editor.selection.size ? editor.order.filter((s) => editor.selection.has(s.id)) : editor.order;
  const b = unionRects(shapes);
  return b ? { x: b.x - 24, y: b.y - 24, w: b.w + 48, h: b.h + 48 } : null;
}

async function inlineElement(source: Element): Promise<Element> {
  const clone = source.cloneNode(false) as HTMLElement | SVGElement;
  const style = getComputedStyle(source);
  for (const prop of Array.from(style)) clone.style.setProperty(prop, style.getPropertyValue(prop));
  if (source instanceof HTMLImageElement) {
    const response = await fetch(source.src);
    if (!response.ok) throw new Error('An image could not be loaded for export.');
    const blob = await response.blob();
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    clone.setAttribute('src', data);
  }
  for (const child of Array.from(source.childNodes)) {
    clone.appendChild(child instanceof Element ? await inlineElement(child) : child.cloneNode());
  }
  return clone;
}

/** Rasterize the rendered card bodies as well as ink, images and comments.
 * The caller temporarily disables culling so offscreen shapes are included. */
export async function exportPng(editor: BoardEditor, root: HTMLElement, filename: string): Promise<void> {
  const b = exportBounds(editor);
  if (!b) throw new Error('Add something to the board before exporting.');
  // Avoid silently downscaling or exceeding browser canvas allocation limits.
  if (b.w * 2 > 16384 || b.h * 2 > 16384 || b.w * b.h * 4 > 64_000_000) {
    throw new Error('This board is too large for one PNG. Select a smaller area to export.');
  }
  await document.fonts.ready;
  const container = document.createElement('div');
  container.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  container.style.cssText = `position:relative;width:${b.w}px;height:${b.h}px;background:#0e0e0e;`;
  for (const s of editor.order) {
    if (editor.selection.size && !editor.selection.has(s.id)) continue;
    const el = Array.from(root.querySelectorAll<HTMLElement>('[data-shape-id]')).find((n) => n.dataset.shapeId === s.id);
    if (!el) throw new Error('A board item was not ready for export. Try again.');
    const clone = await inlineElement(el) as HTMLElement;
    clone.style.left = `${s.x - b.x}px`;
    clone.style.top = `${s.y - b.y}px`;
    clone.style.visibility = 'visible';
    clone.style.opacity = '1';
    container.appendChild(clone);
  }
  const markup = new XMLSerializer().serializeToString(container);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${b.w * 2}" height="${b.h * 2}" viewBox="0 0 ${b.w} ${b.h}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The browser could not render this export.'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(b.w * 2);
  canvas.height = Math.ceil(b.h * 2);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('PNG export is unavailable in this browser.');
  ctx.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('PNG export failed.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
