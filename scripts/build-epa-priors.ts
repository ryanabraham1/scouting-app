// Build the season-start priors for the Bayesian EPA model (src/dash/bayesEpa.ts).
//
// Replays every official (non-offseason) match of each season from TBA through
// the SAME model the app runs, chaining seasons so each one starts from the
// previous seasons' standardized strengths, and writes
//   src/dash/epaPriors/<TARGET>.json  =  { "<team>": [z(T-1), z(T-2), z(T-3)] }
// Run once per season (e.g. at kickoff, and again after champs for next year):
//   TBA_API_KEY=... npx vite-node scripts/build-epa-priors.ts 2026 2027
// Raw TBA responses are cached under .cache/tba/ (gitignored) so reruns are fast.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BayesEpaModel, type PriorZ } from '../src/dash/bayesEpa';
import { bayesMatchesFromRows, seasonScaleFromRows } from '../src/dash/bayesEpaRows';
import { tbaMatchesToRows } from '../src/dash/localEpa';

const KEY = process.env.TBA_API_KEY;
if (!KEY) throw new Error('TBA_API_KEY is required');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const CACHE = path.join(ROOT, '.cache', 'tba');
const OUT = path.join(ROOT, 'src', 'dash', 'epaPriors');
// Regional, district, district champs, champs division/final, district champs division.
const OFFICIAL_TYPES = new Set([0, 1, 2, 3, 4, 5]);
const FIRST_SEASON = 2016;

async function tba<T>(p: string, cacheable: boolean): Promise<T> {
  const file = path.join(CACHE, `${p.replace(/[^a-z0-9]+/gi, '_')}.json`);
  if (cacheable && existsSync(file)) return JSON.parse(readFileSync(file, 'utf8')) as T;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`https://www.thebluealliance.com/api/v3${p}`, {
        headers: { 'X-TBA-Auth-Key': KEY as string },
      });
      if (!res.ok) throw new Error(`${res.status} ${p}`);
      const json = (await res.json()) as T;
      if (cacheable) writeFileSync(file, JSON.stringify(json));
      return json;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]);
      }
    }),
  );
  return out;
}

interface TbaEvent {
  key: string;
  event_type: number;
  week: number | null;
}

/** Standardized end-of-season strength of every team in one season. */
async function seasonZ(year: number, priors: Map<number, PriorZ>, done: boolean): Promise<Map<number, number>> {
  const events = (await tba<TbaEvent[]>(`/events/${year}`, done)).filter((e) =>
    OFFICIAL_TYPES.has(e.event_type),
  );
  const week = new Map(events.map((e) => [e.key, e.week]));
  const raw = await pool(events, 12, (e) => tba<unknown[]>(`/event/${e.key}/matches`, done));
  const rows = tbaMatchesToRows(raw.flat());
  // Season scale from week-1 matches (as Statbotics does); whole season if none.
  const week1 = rows.filter((r) => week.get(r.event_key) === 0);
  const scale = seasonScaleFromRows(week1.length >= 50 ? week1 : rows);
  const model = new BayesEpaModel(scale, priors);
  for (const m of bayesMatchesFromRows(rows)) {
    model.predict(m);
    model.update(m);
  }
  console.log(`${year}: ${rows.length} matches, ${model.teams().length} teams, c=${model.refit().toFixed(3)}`);
  return model.seasonZ();
}

function priorsFor(target: number, hist: Map<number, Map<number, number>>): Map<number, PriorZ> {
  const prev = [...hist.keys()].filter((y) => y < target && y >= target - 4).sort((a, b) => b - a);
  const teams = new Set<number>();
  for (const y of prev) for (const t of (hist.get(y) as Map<number, number>).keys()) teams.add(t);
  const out = new Map<number, PriorZ>();
  for (const t of teams) {
    const zs = prev
      .map((y) => (hist.get(y) as Map<number, number>).get(t))
      .filter((z): z is number => z != null);
    out.set(t, [zs[0] ?? null, zs[1] ?? null, zs[2] ?? null]);
  }
  return out;
}

async function main(): Promise<void> {
  const targets = process.argv.slice(2).map(Number).filter(Number.isInteger);
  if (targets.length === 0) throw new Error('usage: build-epa-priors.ts <targetYear>...');
  mkdirSync(CACHE, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const status = await tba<{ current_season: number }>('/status', false);
  const last = Math.max(...targets) - 1;
  const hist = new Map<number, Map<number, number>>();
  for (let y = FIRST_SEASON; y <= last; y++) {
    if (y === 2021) continue; // no official matches
    // A season still in progress must not be cached forever.
    hist.set(y, await seasonZ(y, priorsFor(y, hist), y < status.current_season || y < last));
  }
  for (const target of targets) {
    const priors = priorsFor(target, hist);
    const obj: Record<string, Array<number | null>> = {};
    for (const [t, zs] of [...priors].sort((a, b) => a[0] - b[0])) {
      obj[t] = zs.map((z) => (z == null ? null : Math.round(z * 100) / 100));
    }
    const file = path.join(OUT, `${target}.json`);
    writeFileSync(file, JSON.stringify(obj) + '\n');
    console.log(`wrote ${path.relative(ROOT, file)} (${priors.size} teams)`);
  }
}

void main();
