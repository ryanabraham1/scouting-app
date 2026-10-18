// src/home/HomeScreen.tsx — landing page. Scouts capture data, anyone can inspect
// Analysis, and leads unlock Lead Dashboard controls. Uses client-side navigation
// so it works offline (a
// full-page reload would depend on the service worker re-serving the document).
// Content is vertically centered at every size; only very short viewports (a
// phone held sideways) pin it to the top so nothing clips. The three choices
// sit side by side from `sm`/landscape up, and stack as compact rows on
// portrait phones. A decorative auto-path backdrop
// (FieldPaths) and a staggered entrance give it motion without any assets.
import { Link } from 'react-router-dom';
import { ClipboardList, LayoutDashboard, ArrowRight, ChartNoAxesCombined } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import FieldPaths from './FieldPaths';
import { useScoutOrigin } from '@/scout/ScoutBottomNav';

// Semantic tone per role: brand (cyan) = capture, success (green) = insight,
// and energy (orange) = lead controls.
type Tone = 'brand' | 'analysis' | 'energy';

interface Choice {
  testid: string;
  href: string;
  icon: LucideIcon;
  title: string;
  blurb: string;
  tone: Tone;
}

// Static class maps so Tailwind keeps the utilities (no dynamic interpolation).
const TONE_TILE: Record<Tone, string> = {
  brand: 'bg-brand/10 text-brand group-hover:bg-brand group-hover:text-brand-foreground',
  analysis: 'bg-success/10 text-success group-hover:bg-success group-hover:text-success-foreground',
  energy: 'bg-energy/10 text-energy group-hover:bg-energy group-hover:text-energy-foreground',
};
const TONE_CARD: Record<Tone, string> = {
  brand: 'hover:border-brand focus-visible:ring-brand',
  analysis: 'hover:border-success focus-visible:ring-success',
  energy: 'hover:border-energy focus-visible:ring-energy',
};
const TONE_ARROW: Record<Tone, string> = {
  brand: 'group-hover:text-brand',
  analysis: 'group-hover:text-success',
  energy: 'group-hover:text-energy',
};

const CHOICES: Choice[] = [
  {
    testid: 'home-go-scout',
    href: '/scout',
    icon: ClipboardList,
    title: 'Scout',
    blurb: 'Capture match data from the stands.',
    tone: 'brand',
  },
  {
    testid: 'home-go-analysis',
    href: '/analysis',
    icon: ChartNoAxesCombined,
    title: 'Analysis',
    blurb: 'Explore teams, matches, rankings and alliance combinations.',
    tone: 'analysis',
  },
  {
    testid: 'home-go-dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    title: 'Lead Dashboard',
    blurb: 'Strategy, scouters, picklist, draft and settings for leads.',
    tone: 'energy',
  },
];

// Entrance choreography: header first, then each card ~110ms apart. Gated on
// motion-safe so reduced-motion users get the page instantly. The entrance runs
// on a wrapper so it never fights the card's own hover/press transform.
const ENTER = 'motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-bottom-3 motion-safe:fill-mode-both motion-safe:duration-700 motion-safe:ease-out';
const CARD_DELAY_MS = 220;
const CARD_STAGGER_MS = 110;

export default function HomeScreen(): JSX.Element {
  useScoutOrigin(false);
  return (
    <div
      data-testid="home-screen"
      className="relative isolate flex min-h-screen min-h-[100dvh] flex-col items-center justify-center gap-10 overflow-y-auto overflow-x-hidden bg-background px-safe py-safe text-foreground sm:gap-14 [@media(max-height:540px)]:justify-start [@media(max-height:540px)]:gap-6 [@media(max-height:540px)]:py-6"
    >
      <FieldPaths />

      <header className={`relative flex flex-col items-center gap-3 text-center ${ENTER}`}>
        <p className="eyebrow">FRC 3256 · Rebuilt</p>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl [@media(max-height:540px)]:text-3xl">Pick your station</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Capture data, study the field, or open the controls used by team leads.
        </p>
      </header>

      <div className="relative grid w-full max-w-5xl grid-cols-1 gap-3 sm:grid-cols-3 sm:gap-4 landscape:grid-cols-3 landscape:gap-4">
        {CHOICES.map((c, i) => {
          const Icon = c.icon;
          return (
            <div
              key={c.testid}
              className={ENTER}
              style={{ animationDelay: `${CARD_DELAY_MS + i * CARD_STAGGER_MS}ms` }}
            >
              <Link
                data-testid={c.testid}
                to={c.href}
                className={`group grid h-full min-h-[44px] grid-cols-[auto_1fr_auto] items-center gap-x-4 gap-y-1 rounded-xl border border-border bg-card/85 p-4 text-card-foreground shadow-sm backdrop-blur-sm transition-[transform,border-color,background-color,box-shadow] duration-200 ease-out hover:-translate-y-0.5 hover:bg-accent/90 hover:shadow-md focus-visible:outline-none focus-visible:ring-1 active:translate-y-0 active:scale-[0.98] sm:flex sm:flex-col sm:items-stretch sm:gap-4 sm:p-6 landscape:flex landscape:flex-col landscape:items-stretch landscape:gap-4 landscape:p-6 [@media(max-height:540px)]:gap-2 [@media(max-height:540px)]:p-4 ${TONE_CARD[c.tone]}`}
              >
                <span
                  className={`row-span-2 flex size-11 items-center justify-center rounded-lg transition-colors duration-200 sm:size-12 ${TONE_TILE[c.tone]}`}
                >
                  <Icon className="size-6" />
                </span>
                <span className="flex items-center justify-between gap-2">
                  <span className="text-xl font-semibold tracking-tight sm:text-2xl">{c.title}</span>
                  <ArrowRight
                    className={`hidden size-5 text-muted-foreground transition-[transform,color] duration-200 group-hover:translate-x-1 sm:block landscape:block ${TONE_ARROW[c.tone]}`}
                  />
                </span>
                <ArrowRight
                  className={`row-span-2 size-5 text-muted-foreground transition-[transform,color] duration-200 group-hover:translate-x-1 sm:hidden landscape:hidden ${TONE_ARROW[c.tone]}`}
                />
                <span className="text-sm text-muted-foreground">{c.blurb}</span>
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
