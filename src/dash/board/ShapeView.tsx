// src/dash/board/ShapeView.tsx
// One absolutely positioned element per shape, in PAGE units inside the
// camera-transformed world layer. Memoized per shape object (shapes are
// immutable), so a drag re-renders only the shapes that moved.
import { memo, type ReactNode } from 'react';
import {
  COLORS,
  FONT_SIZE,
  HIGHLIGHTER_OPACITY,
  TEXT_LINE_HEIGHT,
  type ImageShape,
  type InkShape,
  type Shape,
  type TextShape,
  type WidgetShape,
} from '@/dash/board/model';
import { inkToPathD } from '@/dash/board/inkPath';
import { TEXT_FONT_FAMILY } from '@/dash/board/measureText';

export interface ShapeViewProps {
  shape: Shape;
  /** Crossed by the eraser (renders faded until the eraser lifts). */
  erasing: boolean;
  /** Hidden while its text is being edited in the overlay. */
  editing: boolean;
  renderWidget: (shape: WidgetShape) => ReactNode;
}

function InkView({ shape }: { shape: InkShape }): JSX.Element {
  return (
    <svg
      width={shape.w}
      height={shape.h}
      viewBox={`0 0 ${shape.w} ${shape.h}`}
      style={{ overflow: 'visible', display: 'block' }}
      aria-hidden
    >
      <path
        d={inkToPathD(shape)}
        fill={COLORS[shape.color]}
        opacity={shape.highlighter ? HIGHLIGHTER_OPACITY : 1}
      />
    </svg>
  );
}

function TextView({ shape }: { shape: TextShape }): JSX.Element {
  return (
    <div
      style={{
        width: shape.w,
        fontSize: FONT_SIZE[shape.size],
        lineHeight: TEXT_LINE_HEIGHT,
        color: COLORS[shape.color],
        fontFamily: TEXT_FONT_FAMILY,
        fontWeight: 500,
        whiteSpace: 'pre-wrap',
        overflowWrap: 'break-word',
        textAlign: shape.align === 'middle' ? 'center' : shape.align === 'end' ? 'right' : 'left',
      }}
    >
      {shape.text}
    </div>
  );
}

function ImageView({ shape }: { shape: ImageShape }): JSX.Element {
  return (
    <img
      src={shape.src}
      alt=""
      draggable={false}
      style={{ width: '100%', height: '100%', display: 'block', borderRadius: 6, objectFit: 'fill' }}
    />
  );
}

export const ShapeView = memo(function ShapeView({
  shape,
  erasing,
  editing,
  renderWidget,
}: ShapeViewProps): JSX.Element {
  return (
    <div
      data-shape-id={shape.id}
      style={{
        position: 'absolute',
        left: shape.x,
        top: shape.y,
        width: shape.w,
        height: shape.type === 'text' ? undefined : shape.h,
        opacity: erasing ? 0.3 : 1,
        visibility: editing ? 'hidden' : undefined,
        pointerEvents: 'none',
      }}
    >
      {shape.type === 'ink' && <InkView shape={shape} />}
      {shape.type === 'text' && <TextView shape={shape} />}
      {shape.type === 'image' && <ImageView shape={shape} />}
      {shape.type === 'widget' && renderWidget(shape)}
    </div>
  );
});
