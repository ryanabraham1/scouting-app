// src/home/FieldPaths.tsx — decorative home backdrop: a faint top-down field
// outline with alliance-colored auto paths that trace themselves on a loop.
// Pure inline SVG + two CSS keyframes (`animate-path-trace` draws the line,
// `animate-path-dot` rides its tip), so it costs no network and ships offline.
// The dot is a single round-capped zero-length dash on the same path, so both
// share one CSS clock and stay locked together (SMIL would run on its own).
// Dash math uses each path's measured length (`--len`), not `pathLength`:
// Safari doesn't scale dashes by pathLength, which froze the lines there.
// Two layouts: a wide field for laptops / landscape phones and a tall one for
// portrait phones. Reduced motion: paths render statically drawn and the dots
// are hidden.
import { useLayoutEffect, useRef } from "react";

interface Trace {
  d: string;
  alliance: "red" | "blue";
  /** Seconds into the loop this trace starts; staggers the paths. */
  delay: number;
  faint?: boolean;
}

interface Layout {
  viewBox: string;
  outline: JSX.Element;
  traces: Trace[];
}

const WIDE: Layout = {
  viewBox: "0 0 640 360",
  outline: (
    <>
      <rect x="20" y="20" width="600" height="320" rx="14" />
      <line x1="320" y1="20" x2="320" y2="340" />
      <line x1="170" y1="20" x2="170" y2="340" strokeDasharray="3 6" />
      <line x1="470" y1="20" x2="470" y2="340" strokeDasharray="3 6" />
      <polygon points="170,162 186,171 186,189 170,198 154,189 154,171" />
      <polygon points="470,162 486,171 486,189 470,198 454,189 454,171" />
    </>
  ),
  traces: [
    {
      d: "M40 280 C120 280 120 214 170 204 S280 132 300 74",
      alliance: "blue",
      delay: 0,
    },
    {
      d: "M600 80 C520 80 520 156 470 166 S380 262 330 294",
      alliance: "red",
      delay: 1.4,
    },
    {
      d: "M40 124 C100 144 130 176 160 174 S240 252 290 262",
      alliance: "blue",
      delay: 2.8,
      faint: true,
    },
    {
      d: "M600 236 C540 220 512 196 482 198 S402 112 352 96",
      alliance: "red",
      delay: 4.2,
      faint: true,
    },
  ],
};

const TALL: Layout = {
  viewBox: "0 0 220 420",
  outline: (
    <>
      <rect x="12" y="12" width="196" height="396" rx="12" />
      <line x1="12" y1="210" x2="208" y2="210" />
      <polygon points="110,96 124,104 124,120 110,128 96,120 96,104" />
      <polygon points="110,292 124,300 124,316 110,324 96,316 96,300" />
    </>
  ),
  traces: [
    {
      d: "M30 395 C30 330 90 340 100 300 S170 240 175 190",
      alliance: "blue",
      delay: 0,
    },
    {
      d: "M190 25 C190 90 130 80 120 120 S50 180 45 230",
      alliance: "red",
      delay: 1.6,
    },
    {
      d: "M190 392 C176 350 150 344 132 312 S96 262 70 250",
      alliance: "blue",
      delay: 3.2,
      faint: true,
    },
  ],
};

// Static class maps so Tailwind keeps the utilities.
const STROKE: Record<Trace["alliance"], string> = {
  red: "stroke-red-500",
  blue: "stroke-blue-500",
};
const DOT: Record<Trace["alliance"], string> = {
  red: "stroke-red-400",
  blue: "stroke-blue-400",
};

function FieldSvg({
  layout,
  className,
}: {
  layout: Layout;
  className: string;
}): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  // Measure before first paint so a trace never flashes fully drawn.
  useLayoutEffect(() => {
    svgRef.current?.querySelectorAll<SVGGElement>("g[data-trace]").forEach((g) => {
      const len = g.querySelector("path")?.getTotalLength?.();
      if (len) g.style.setProperty("--len", `${Math.ceil(len)}px`);
    });
  }, []);
  return (
    <svg
      ref={svgRef}
      viewBox={layout.viewBox}
      preserveAspectRatio="xMidYMid slice"
      className={`absolute inset-0 size-full ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      <g
        fill="none"
        className="stroke-foreground"
        strokeOpacity={0.07}
        strokeWidth={1}
      >
        {layout.outline}
      </g>
      {layout.traces.map((t) => (
        <g key={t.d} data-trace="">
          <path
            d={t.d}
            fill="none"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeOpacity={t.faint ? 0.4 : 0.65}
            className={`${STROKE[t.alliance]} motion-safe:animate-path-trace`}
            style={{ strokeDasharray: "var(--len)", animationDelay: `${t.delay}s` }}
          />
          <path
            d={t.d}
            fill="none"
            strokeWidth={6}
            strokeLinecap="round"
            strokeOpacity={t.faint ? 0.6 : 1}
            className={`${DOT[t.alliance]} hidden motion-safe:inline motion-safe:animate-path-dot`}
            style={{
              strokeDasharray: "0 calc(var(--len) * 2)",
              animationDelay: `${t.delay}s`,
            }}
          />
        </g>
      ))}
    </svg>
  );
}

export default function FieldPaths(): JSX.Element {
  // The radial mask dims the backdrop behind the centered title and cards so
  // the traces frame the content instead of crossing the text.
  return (
    <div
      className="pointer-events-none absolute inset-0 overflow-hidden [mask-image:radial-gradient(ellipse_50%_42%_at_50%_45%,rgb(0_0_0/0.18),#000)]"
      data-testid="home-field-paths"
    >
      <FieldSvg layout={TALL} className="sm:hidden landscape:hidden" />
      <FieldSvg layout={WIDE} className="hidden sm:block landscape:block" />
    </div>
  );
}
