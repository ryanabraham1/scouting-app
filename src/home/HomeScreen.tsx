// src/home/HomeScreen.tsx — landing page. Scouts capture data, anyone can inspect
// Analysis, and leads unlock Lead Dashboard controls. Uses client-side navigation
// so it works offline (a
// full-page reload would depend on the service worker re-serving the document).
// Built for phones in landscape — the three choices sit side by side there,
// stacked otherwise.
import { Link } from 'react-router-dom';
import { ClipboardList, LayoutDashboard, ArrowRight, ChartNoAxesCombined } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

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

export default function HomeScreen(): JSX.Element {
  return (
    <div
      data-testid="home-screen"
      className="flex min-h-screen flex-col items-center justify-center gap-10 overflow-y-auto bg-background px-safe py-safe text-foreground landscape:justify-start landscape:py-8"
    >
      <header className="flex flex-col items-center gap-2 text-center">
        <p className="font-mono text-xs uppercase tracking-[0.25em] text-muted-foreground">
          FRC Scouting
        </p>
        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Pick your station</h1>
        <p className="max-w-md text-sm text-muted-foreground">
          Capture data, study the field, or open the controls used by team leads.
        </p>
      </header>

      <div className="grid w-full max-w-5xl grid-cols-1 gap-4 landscape:grid-cols-3 sm:grid-cols-3">
        {CHOICES.map((c) => {
          const Icon = c.icon;
          return (
            <Link
              key={c.testid}
              data-testid={c.testid}
              to={c.href}
              className={`group flex min-h-[44px] flex-col gap-4 rounded-xl border border-border bg-card p-6 text-card-foreground shadow transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-1 ${TONE_CARD[c.tone]}`}
            >
              <span
                className={`flex size-12 items-center justify-center rounded-lg transition-colors ${TONE_TILE[c.tone]}`}
              >
                <Icon className="size-6" />
              </span>
              <span className="flex items-center justify-between">
                <span className="text-2xl font-semibold tracking-tight">{c.title}</span>
                <ArrowRight
                  className={`size-5 text-muted-foreground transition-transform group-hover:translate-x-1 ${TONE_ARROW[c.tone]}`}
                />
              </span>
              <span className="text-sm text-muted-foreground">{c.blurb}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
