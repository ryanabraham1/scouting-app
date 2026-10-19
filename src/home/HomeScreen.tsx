// src/home/HomeScreen.tsx — launcher. One big "continue" for the last station
// used on this device, then a plain list of every station. Client-side links so
// it works offline (a full-page reload would depend on the service worker).
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronRight } from 'lucide-react';
import { STATIONS, readLastStation } from '@/components/StationMenu';

const TESTID: Record<string, string> = {
  scout: 'home-go-scout',
  analysis: 'home-go-analysis',
  lead: 'home-go-dashboard',
};

export default function HomeScreen(): JSX.Element {
  const last = readLastStation();
  const resume = STATIONS.find((s) => s.id === last) ?? null;

  return (
    <div
      data-testid="home-screen"
      className="mx-auto flex min-h-dvh w-full max-w-md flex-col gap-6 bg-background px-safe py-safe text-foreground"
    >
      <header className="mt-6 flex flex-col gap-1">
        <p className="text-xs text-muted-foreground">FRC 3256 · Rebuilt</p>
        <h1 className="text-[26px] font-medium leading-tight">Where to?</h1>
      </header>

      {resume ? (
        <Link
          to={resume.href}
          data-testid="home-continue"
          className="flex flex-col gap-3 rounded-2xl border border-border-strong bg-card p-4"
          style={{ borderColor: 'hsl(var(--ring) / 0.35)' }}
        >
          <span className="text-xs text-muted-foreground">Pick up where you left off</span>
          <span className="flex items-center justify-between">
            <span>
              <span className="block text-base font-medium">{resume.label}</span>
              <span className="block text-sm text-muted-foreground">{resume.blurb}</span>
            </span>
            <resume.icon className="size-6 text-muted-foreground" aria-hidden="true" />
          </span>
          <span className="flex h-11 items-center justify-center gap-2 rounded-xl bg-foreground text-sm font-medium text-background">
            Continue
            <ArrowRight className="size-[18px]" aria-hidden="true" />
          </span>
        </Link>
      ) : null}

      <section>
        <h2 className="mb-1 text-xs font-normal text-muted-foreground">All stations</h2>
        <ul>
          {STATIONS.map((s) => (
            <li key={s.id} className="border-t border-border first:border-t-0">
              <Link
                to={s.href}
                data-testid={TESTID[s.id]}
                className="flex min-h-[60px] items-center gap-3 py-3"
              >
                <span className="flex size-[34px] shrink-0 items-center justify-center rounded-[10px] bg-secondary text-muted-foreground [&_svg]:size-[17px]">
                  <s.icon aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{s.label}</span>
                  <span className="block text-xs text-muted-foreground">{s.blurb}</span>
                </span>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden="true" />
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <p className="mt-auto pb-2 text-center text-xs text-muted-foreground">
        Works offline. Your reports are saved on this device.
      </p>
    </div>
  );
}
