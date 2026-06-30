// src/dash/printWindow.ts
// Tiny isolated side-effect: open a new window with a self-contained HTML
// document and invoke the browser print dialog. Kept separate so presetExports
// stays a pure string builder and this can be mocked in unit tests.

/**
 * Open a new tab/window, write the given (self-contained) HTML document, and
 * trigger the browser print dialog ("Save as PDF"). Degrades silently when the
 * popup is blocked (returns without throwing).
 */
export function openPrintWindow(html: string): void {
  const w = window.open('', '_blank');
  if (!w) return; // popup blocked → degrade silently (caller may surface a note)
  w.document.open();
  w.document.write(html);
  w.document.close();
  w.focus();
  w.print();
}
