// src/dash/board/measureText.ts
// Measures a text shape's wrapped height (page units) with one hidden mirror
// div, styled exactly like TextView, so the stored `h` matches what renders.
import { FONT_SIZE, TEXT_LINE_HEIGHT, type TextShape } from '@/dash/board/model';
import { defaultMeasureText } from '@/dash/board/editor';

let mirror: HTMLDivElement | null = null;

export const TEXT_FONT_FAMILY =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

export function measureTextHeight(s: TextShape): number {
  if (typeof document === 'undefined') return defaultMeasureText(s);
  if (!mirror) {
    mirror = document.createElement('div');
    mirror.setAttribute('aria-hidden', 'true');
    Object.assign(mirror.style, {
      position: 'absolute',
      visibility: 'hidden',
      pointerEvents: 'none',
      left: '-99999px',
      top: '0',
      whiteSpace: 'pre-wrap',
      overflowWrap: 'break-word',
      fontFamily: TEXT_FONT_FAMILY,
      fontWeight: '500',
      lineHeight: String(TEXT_LINE_HEIGHT),
    });
    document.body.appendChild(mirror);
  }
  mirror.style.width = `${s.w}px`;
  mirror.style.fontSize = `${FONT_SIZE[s.size]}px`;
  // A trailing newline needs a character to take up a line.
  mirror.textContent = s.text.endsWith('\n') || !s.text ? `${s.text} ` : s.text;
  const h = mirror.offsetHeight;
  // jsdom has no layout; fall back to the estimate.
  return h > 0 ? h : defaultMeasureText(s);
}
