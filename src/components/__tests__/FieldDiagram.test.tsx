import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { FieldDiagram } from '../FieldDiagram';

beforeEach(() => {
  cleanup();
  // jsdom does not implement PointerEvent, so fireEvent.pointer* falls back to a
  // bare Event and drops clientX/clientY. Polyfill it (extending MouseEvent) so
  // pointer coordinates are carried through to the component under test.
  if (typeof window.PointerEvent === 'undefined') {
    class PointerEventPolyfill extends MouseEvent {
      constructor(type: string, params: PointerEventInit = {}) {
        super(type, params);
      }
    }
    // @ts-expect-error assigning a test-only polyfill
    window.PointerEvent = PointerEventPolyfill;
    // @ts-expect-error assigning a test-only polyfill
    globalThis.PointerEvent = PointerEventPolyfill;
  }
  // Stub getBoundingClientRect so normalization is deterministic (200x100 at origin).
  Element.prototype.getBoundingClientRect = vi.fn(() => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  })) as unknown as typeof Element.prototype.getBoundingClientRect;
});

describe('FieldDiagram', () => {
  it('renders the field image and default testid', () => {
    const { getByTestId, container } = render(<FieldDiagram mode="view" />);
    expect(getByTestId('field-diagram')).toBeTruthy();
    const img = container.querySelector('img');
    expect(img).toBeTruthy();
    expect(img?.getAttribute('src')).toBe('/assets/field/field.png');
  });

  it('honors a custom data-testid', () => {
    const { getByTestId } = render(
      <FieldDiagram mode="view" data-testid="auto-field" />
    );
    expect(getByTestId('auto-field')).toBeTruthy();
  });
});

describe('FieldDiagram pick-start', () => {
  it('emits normalized {x,y} in [0,1] on click', () => {
    const onStartChange = vi.fn();
    const { getByTestId } = render(
      <FieldDiagram mode="pick-start" onStartChange={onStartChange} />
    );
    // rect is 200x100 at origin; click at (50,25) -> {0.25, 0.25}
    fireEvent.pointerDown(getByTestId('field-diagram'), {
      clientX: 50,
      clientY: 25,
    });
    fireEvent.pointerUp(getByTestId('field-diagram'), {
      clientX: 50,
      clientY: 25,
    });
    expect(onStartChange).toHaveBeenCalledTimes(1);
    const p = onStartChange.mock.calls[0][0];
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(1);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeLessThanOrEqual(1);
    expect(p.x).toBeCloseTo(0.25, 5);
    expect(p.y).toBeCloseTo(0.25, 5);
  });

  it('mirrors x for the picked point when mirror is set', () => {
    const onStartChange = vi.fn();
    const { getByTestId } = render(
      <FieldDiagram mode="pick-start" mirror onStartChange={onStartChange} />
    );
    fireEvent.pointerUp(getByTestId('field-diagram'), {
      clientX: 50,
      clientY: 25,
    });
    const p = onStartChange.mock.calls[0][0];
    expect(p.x).toBeCloseTo(0.75, 5);
    expect(p.y).toBeCloseTo(0.25, 5);
  });
});

describe('FieldDiagram draw-path', () => {
  it('emits a path with >= 2 points on pointerdown..move..up', () => {
    const onPathChange = vi.fn();
    const { getByTestId } = render(
      <FieldDiagram mode="draw-path" onPathChange={onPathChange} />
    );
    const el = getByTestId('field-diagram');
    fireEvent.pointerDown(el, { clientX: 20, clientY: 10, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 60, clientY: 30, pointerId: 1 });
    fireEvent.pointerMove(el, { clientX: 100, clientY: 50, pointerId: 1 });
    fireEvent.pointerUp(el, { clientX: 100, clientY: 50, pointerId: 1 });
    expect(onPathChange).toHaveBeenCalled();
    const lastCall =
      onPathChange.mock.calls[onPathChange.mock.calls.length - 1];
    const pts = lastCall[0] as Array<{ x: number; y: number }>;
    expect(pts.length).toBeGreaterThanOrEqual(2);
    for (const pt of pts) {
      expect(pt.x).toBeGreaterThanOrEqual(0);
      expect(pt.x).toBeLessThanOrEqual(1);
      expect(pt.y).toBeGreaterThanOrEqual(0);
      expect(pt.y).toBeLessThanOrEqual(1);
    }
  });
});

describe('FieldDiagram view', () => {
  it('renders a marker at startPosition and a polyline through path', () => {
    const { container } = render(
      <FieldDiagram
        mode="view"
        startPosition={{ x: 0.2, y: 0.4 }}
        path={[
          { x: 0.1, y: 0.1 },
          { x: 0.5, y: 0.5 },
          { x: 0.9, y: 0.3 },
        ]}
      />
    );
    const marker = container.querySelector(
      '[data-testid="field-diagram-marker"]'
    ) as SVGCircleElement | null;
    expect(marker).toBeTruthy();
    expect(marker?.getAttribute('cx')).toBe('0.2');
    expect(marker?.getAttribute('cy')).toBe('0.4');
    const polyline = container.querySelector(
      '[data-testid="field-diagram-polyline"]'
    ) as SVGPolylineElement | null;
    expect(polyline).toBeTruthy();
    expect(polyline?.getAttribute('points')).toBe('0.1,0.1 0.5,0.5 0.9,0.3');
  });

  it('mirrors x for marker and polyline when mirror is set', () => {
    const { container } = render(
      <FieldDiagram
        mode="view"
        mirror
        startPosition={{ x: 0.2, y: 0.4 }}
        path={[
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.3 },
        ]}
      />
    );
    const marker = container.querySelector(
      '[data-testid="field-diagram-marker"]'
    ) as SVGCircleElement | null;
    expect(marker?.getAttribute('cx')).toBe('0.8');
    const polyline = container.querySelector(
      '[data-testid="field-diagram-polyline"]'
    ) as SVGPolylineElement | null;
    expect(polyline?.getAttribute('points')).toBe('0.9,0.1 0.1,0.3');
  });
});

describe('FieldDiagram overlays', () => {
  it('renders one polyline per overlay with >= 2 points, in the given colors', () => {
    const { container } = render(
      <FieldDiagram
        mode="view"
        overlays={[
          {
            color: '#ff0000',
            path: [
              { x: 0.1, y: 0.1 },
              { x: 0.5, y: 0.5 },
            ],
            startPosition: { x: 0.1, y: 0.1 },
          },
          {
            color: '#00ff00',
            path: [
              { x: 0.2, y: 0.2 },
              { x: 0.4, y: 0.6 },
              { x: 0.8, y: 0.3 },
            ],
          },
        ]}
      />
    );
    const o0 = container.querySelector(
      '[data-testid="field-diagram-overlay-0"]'
    ) as SVGPolylineElement | null;
    const o1 = container.querySelector(
      '[data-testid="field-diagram-overlay-1"]'
    ) as SVGPolylineElement | null;
    expect(o0).toBeTruthy();
    expect(o1).toBeTruthy();
    expect(o0?.getAttribute('stroke')).toBe('#ff0000');
    expect(o1?.getAttribute('stroke')).toBe('#00ff00');
    expect(o0?.getAttribute('points')).toBe('0.1,0.1 0.5,0.5');
    expect(o1?.getAttribute('points')).toBe('0.2,0.2 0.4,0.6 0.8,0.3');
    // exactly two overlay polylines, no third
    expect(
      container.querySelector('[data-testid="field-diagram-overlay-2"]')
    ).toBeNull();
  });

  it('renders an overlay start circle in the overlay color when startPosition is set', () => {
    const { container } = render(
      <FieldDiagram
        mode="view"
        overlays={[{ color: '#0000ff', startPosition: { x: 0.3, y: 0.7 } }]}
      />
    );
    const circle = container.querySelector(
      '[data-testid="field-diagram-overlay-start-0"]'
    ) as SVGCircleElement | null;
    expect(circle).toBeTruthy();
    expect(circle?.getAttribute('fill')).toBe('#0000ff');
    expect(circle?.getAttribute('cx')).toBe('0.3');
    expect(circle?.getAttribute('cy')).toBe('0.7');
    // No polyline for a single-point overlay (no path).
    expect(
      container.querySelector('[data-testid="field-diagram-overlay-0"]')
    ).toBeNull();
  });

  it('does not render overlay polylines for fewer than 2 path points', () => {
    const { container } = render(
      <FieldDiagram
        mode="view"
        overlays={[{ color: '#abcdef', path: [{ x: 0.1, y: 0.1 }] }]}
      />
    );
    expect(
      container.querySelector('[data-testid="field-diagram-overlay-0"]')
    ).toBeNull();
  });

  it('keeps the existing single path/startPosition rendering unchanged alongside overlays', () => {
    const { container } = render(
      <FieldDiagram
        mode="view"
        startPosition={{ x: 0.2, y: 0.4 }}
        path={[
          { x: 0.1, y: 0.1 },
          { x: 0.9, y: 0.3 },
        ]}
        overlays={[
          {
            color: '#123456',
            path: [
              { x: 0.5, y: 0.5 },
              { x: 0.6, y: 0.6 },
            ],
          },
        ]}
      />
    );
    const marker = container.querySelector(
      '[data-testid="field-diagram-marker"]'
    ) as SVGCircleElement | null;
    expect(marker?.getAttribute('cx')).toBe('0.2');
    const polyline = container.querySelector(
      '[data-testid="field-diagram-polyline"]'
    ) as SVGPolylineElement | null;
    expect(polyline?.getAttribute('points')).toBe('0.1,0.1 0.9,0.3');
    const overlay = container.querySelector(
      '[data-testid="field-diagram-overlay-0"]'
    ) as SVGPolylineElement | null;
    expect(overlay?.getAttribute('stroke')).toBe('#123456');
  });

  it('mirrors overlay coordinates when mirror is set', () => {
    const { container } = render(
      <FieldDiagram
        mode="view"
        mirror
        overlays={[
          {
            color: '#ff0000',
            startPosition: { x: 0.2, y: 0.4 },
            path: [
              { x: 0.1, y: 0.1 },
              { x: 0.9, y: 0.3 },
            ],
          },
        ]}
      />
    );
    const overlay = container.querySelector(
      '[data-testid="field-diagram-overlay-0"]'
    ) as SVGPolylineElement | null;
    expect(overlay?.getAttribute('points')).toBe('0.9,0.1 0.1,0.3');
    const circle = container.querySelector(
      '[data-testid="field-diagram-overlay-start-0"]'
    ) as SVGCircleElement | null;
    expect(circle?.getAttribute('cx')).toBe('0.8');
  });
});
