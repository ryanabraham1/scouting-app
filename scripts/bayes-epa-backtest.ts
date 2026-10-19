// Backtest the Bayesian EPA model over neutral season files, one JSON per year:
//   { scale: {mean, sd}, matches: [[event, elim, time, red[3], blue[3], redNoFoul, blueNoFoul, result]] }
// Matches must be in chronological order. Prints per-season accuracy / Brier,
// the 2023-2026 holdout, and throughput.
// Usage: npx vite-node scripts/bayes-epa-backtest.ts <dir-with-YEAR.json>
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { BayesEpaModel, type PriorZ } from '../src/dash/bayesEpa';

type Row = [string, number, number, number[], number[], number, number, number];

const dir = process.argv[2];
if (!dir) throw new Error('usage: bayes-epa-backtest.ts <dir>');
const years = [2016, 2017, 2018, 2019, 2020, 2022, 2023, 2024, 2025, 2026];
const hist = new Map<number, Map<number, number>>();
const hold = { n: 0, correct: 0, brier: 0 };
let total = 0;
let elapsed = 0;

for (const y of years) {
  const f = path.join(dir, `${y}.json`);
  if (!existsSync(f)) continue;
  const d = JSON.parse(readFileSync(f, 'utf8')) as { scale: { mean: number; sd: number }; matches: Row[] };
  const prev = [...hist.keys()].filter((py) => py < y && py >= y - 4).sort((a, b) => b - a);
  const teams = new Set<number>();
  for (const py of prev) for (const t of (hist.get(py) as Map<number, number>).keys()) teams.add(t);
  const priors = new Map<number, PriorZ>();
  for (const t of teams) {
    const zs = prev.map((py) => (hist.get(py) as Map<number, number>).get(t)).filter((z): z is number => z != null);
    priors.set(t, [zs[0] ?? null, zs[1] ?? null, zs[2] ?? null]);
  }
  const start = performance.now();
  const model = new BayesEpaModel(d.scale, priors);
  let n = 0;
  let correct = 0;
  let brier = 0;
  for (const [eventKey, elim, time, red, blue, redScore, blueScore, result] of d.matches) {
    const m = { eventKey, elim: !!elim, time, red, blue, redScore, blueScore, result };
    const p = model.predict(m).redWinProb;
    if (result !== 0.5) {
      const hit = (p > 0.5) === (result === 1) ? 1 : 0;
      n++;
      correct += hit;
      brier += (p - result) ** 2;
      if (y >= 2023) {
        hold.n++;
        hold.correct += hit;
        hold.brier += (p - result) ** 2;
      }
    }
    model.update(m);
    total++;
  }
  hist.set(y, model.seasonZ());
  elapsed += performance.now() - start;
  console.log(`${y}: n=${n} acc=${((100 * correct) / n).toFixed(2)}% brier=${(brier / n).toFixed(4)} c=${model.c.toFixed(3)}`);
}
console.log(`2023-2026 holdout: n=${hold.n} acc=${((100 * hold.correct) / hold.n).toFixed(2)}% brier=${(hold.brier / hold.n).toFixed(4)}`);
console.log(`${total} matches in ${elapsed.toFixed(0)} ms (${((1000 * elapsed) / total).toFixed(2)} us/match)`);
