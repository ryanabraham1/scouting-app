import { useEffect, useState } from 'react';

export type MobileCoachPlacement = 'top' | 'bottom';

interface TargetBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface CoachTargetState {
  box: TargetBox | null;
  mobilePlacement: MobileCoachPlacement;
}

const CLIPPING_OVERFLOW = new Set(['auto', 'clip', 'hidden', 'scroll']);

function visibleTargetBox(target: Element): TargetBox | null {
  const targetRect = target.getBoundingClientRect();
  if (targetRect.width === 0 && targetRect.height === 0) {
    return {
      top: targetRect.top,
      left: targetRect.left,
      width: 0,
      height: 0,
    };
  }
  let top = targetRect.top;
  let right = targetRect.right;
  let bottom = targetRect.bottom;
  let left = targetRect.left;
  let ancestor = target.parentElement;

  while (ancestor) {
    const style = window.getComputedStyle(ancestor);
    const ancestorRect = ancestor.getBoundingClientRect();
    if (CLIPPING_OVERFLOW.has(style.overflowX)) {
      left = Math.max(left, ancestorRect.left);
      right = Math.min(right, ancestorRect.right);
    }
    if (CLIPPING_OVERFLOW.has(style.overflowY)) {
      top = Math.max(top, ancestorRect.top);
      bottom = Math.min(bottom, ancestorRect.bottom);
    }
    ancestor = ancestor.parentElement;
  }

  top = Math.max(0, top);
  right = Math.min(window.innerWidth, right);
  bottom = Math.min(window.innerHeight, bottom);
  left = Math.max(0, left);
  if (right <= left || bottom <= top) return null;
  return {
    top,
    left,
    width: right - left,
    height: bottom - top,
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function useCoachTarget(
  selector: string | null,
  stepKey: string,
): CoachTargetState {
  const [target, setTarget] = useState<Element | null>(null);
  const [box, setBox] = useState<TargetBox | null>(null);
  const [mobilePlacement, setMobilePlacement] =
    useState<MobileCoachPlacement>('bottom');

  useEffect(() => {
    if (!selector) {
      setTarget(null);
      setBox(null);
      return;
    }
    const resolve = (): void => {
      const next = document.querySelector(selector);
      setTarget((current) => (current === next ? current : next));
    };
    resolve();
    const observer =
      typeof MutationObserver === 'function'
        ? new MutationObserver(resolve)
        : null;
    observer?.observe(document.body, { childList: true, subtree: true });
    return () => observer?.disconnect();
  }, [selector, stepKey]);

  useEffect(() => {
    if (!target) {
      setBox(null);
      return;
    }
    let animationFrame = 0;
    const measure = (): void => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        if (!target.isConnected) {
          setBox(null);
          return;
        }
        const rect = target.getBoundingClientRect();
        setBox(visibleTargetBox(target));
        setMobilePlacement(
          rect.top + rect.height / 2 > window.innerHeight / 2
            ? 'top'
            : 'bottom',
        );
      });
    };

    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    window.addEventListener('scroll', measure, true);
    window.visualViewport?.addEventListener('resize', measure);
    window.visualViewport?.addEventListener('scroll', measure);
    const resizeObserver =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(measure)
        : null;
    resizeObserver?.observe(target);

    const rect = target.getBoundingClientRect();
    const outsideSafeView =
      rect.top < 72 ||
      rect.bottom > window.innerHeight - 72 ||
      rect.left < 8 ||
      rect.right > window.innerWidth - 8;
    if (outsideSafeView && 'scrollIntoView' in target) {
      target.scrollIntoView({
        block: 'center',
        inline: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
      window.removeEventListener('scroll', measure, true);
      window.visualViewport?.removeEventListener('resize', measure);
      window.visualViewport?.removeEventListener('scroll', measure);
      resizeObserver?.disconnect();
    };
  }, [stepKey, target]);

  return {
    box,
    mobilePlacement,
  };
}

export function CoachTargetIndicator({
  box,
  targetSelector,
}: {
  box: TargetBox | null;
  targetSelector?: string;
}): JSX.Element | null {
  if (!box) return null;
  const padding = 6;
  const viewportWidth =
    typeof window === 'undefined' ? box.left + box.width + padding : window.innerWidth;
  const viewportHeight =
    typeof window === 'undefined' ? box.top + box.height + padding : window.innerHeight;
  const top = Math.max(2, Math.min(box.top - padding, viewportHeight - 4));
  const left = Math.max(2, Math.min(box.left - padding, viewportWidth - 4));
  const width = Math.max(
    2,
    Math.min(box.width + padding * 2, viewportWidth - left - 2),
  );
  const height = Math.max(
    2,
    Math.min(box.height + padding * 2, viewportHeight - top - 2),
  );
  const labelBelow = top < 34;
  return (
    <div
      data-testid="tutorial-target-indicator"
      data-target-selector={targetSelector}
      aria-hidden="true"
      className="pointer-events-none fixed z-50 rounded-xl border-2 border-warning ring-2 ring-black/70 motion-safe:transition-[top,left,width,height] motion-safe:duration-150 motion-reduce:transition-none"
      style={{
        top,
        left,
        width,
        height,
      }}
    >
      <span
        className={`pointer-events-none absolute left-0 flex h-6 max-w-[calc(100vw-4px)] items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-md border border-black/70 bg-warning px-2 text-[11px] font-bold text-warning-foreground shadow-md ${
          labelBelow ? 'top-full mt-1' : 'bottom-full mb-1'
        }`}
        style={{ maxWidth: Math.max(24, viewportWidth - left - 2) }}
      >
        {labelBelow ? 'USE THIS ↑' : 'USE THIS ↓'}
      </span>
    </div>
  );
}
