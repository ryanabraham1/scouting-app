// Wheel and press routing over cards: panning must never stall on a widget
// (the "jittery board" bug), while a selected card keeps its own scrolling.
import { describe, it, expect, beforeAll } from 'vitest';
import { act, render } from '@testing-library/react';
import { BoardEditor } from '../editor';
import { BoardCanvas } from '../BoardCanvas';
import type { WidgetShape } from '../model';

beforeAll(() => {
  class RO {
    observe(): void {}
    disconnect(): void {}
  }
  (globalThis as unknown as { ResizeObserver: typeof RO }).ResizeObserver ??= RO;
});

function setup(): { editor: BoardEditor; body: HTMLElement } {
  const editor = new BoardEditor({ clientId: 'test' });
  editor.setViewport(1000, 800);
  editor.insertWidget('team', {}, { w: 300, h: 200 }, { x: 150, y: 100 });
  editor.setSelection([]);
  const renderWidget = (s: WidgetShape) => (
    <div data-board-interactive data-board-scroll data-testid={`body-${s.id}`} style={{ height: 100, overflow: 'auto' }}>
      <div style={{ height: 1000 }} />
    </div>
  );
  const { container } = render(<BoardCanvas editor={editor} renderWidget={renderWidget} onImages={() => {}} />);
  const body = container.querySelector('[data-board-scroll]') as HTMLElement;
  return { editor, body };
}

function wheel(el: HTMLElement, dy: number): void {
  act(() => {
    el.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true }));
  });
}

describe('BoardCanvas wheel routing over cards', () => {
  it('pans the board when the cursor crosses an unselected card', () => {
    const { editor, body } = setup();
    const y0 = editor.camera.y;
    wheel(body, 40);
    expect(editor.camera.y).toBe(y0 - 40);
  });

  it('lets a selected, scrollable card keep the wheel', () => {
    const { editor, body } = setup();
    const id = [...editor.shapes.keys()][0];
    act(() => editor.setSelection([id]));
    // jsdom has no layout: fake a scrollable box.
    Object.defineProperty(body, 'scrollHeight', { value: 1000 });
    Object.defineProperty(body, 'clientHeight', { value: 100 });
    const y0 = editor.camera.y;
    wheel(body, 40);
    expect(editor.camera.y).toBe(y0);
  });

  it('still pans over a selected card that cannot scroll that way', () => {
    const { editor, body } = setup();
    const id = [...editor.shapes.keys()][0];
    act(() => editor.setSelection([id]));
    Object.defineProperty(body, 'scrollHeight', { value: 100 });
    Object.defineProperty(body, 'clientHeight', { value: 100 });
    const y0 = editor.camera.y;
    wheel(body, 40);
    expect(editor.camera.y).toBe(y0 - 40);
  });

  it('ctrl+wheel (trackpad pinch) zooms even over a selected card', () => {
    const { editor, body } = setup();
    const id = [...editor.shapes.keys()][0];
    act(() => editor.setSelection([id]));
    const z0 = editor.camera.z;
    act(() => {
      body.dispatchEvent(new WheelEvent('wheel', { deltaY: 20, ctrlKey: true, bubbles: true, cancelable: true }));
    });
    expect(editor.camera.z).toBeLessThan(z0);
  });
});
