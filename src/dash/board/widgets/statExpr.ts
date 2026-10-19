// src/dash/board/widgets/statExpr.ts
// Tiny arithmetic parser for the stat tile: numbers, `team.metric` refs
// (e.g. `1678.bsr`, `our.auto`), + - * /, unary minus and parentheses.
// Pure and safe (no eval). Returns null for anything unresolvable.
import { METRIC_KEYS, type MetricKey } from '@/dash/board/widgets/data';

export type Resolve = (team: number | 'our', metric: MetricKey) => number | null;

type Tok = { t: 'num'; v: number } | { t: 'ref'; team: number | 'our'; metric: MetricKey } | { t: 'op'; v: string };

function tokenize(src: string): Tok[] | null {
  const out: Tok[] = [];
  const re = /\s*(?:(\d+|our|us)\.([a-z]+)|(\d+(?:\.\d+)?)|([-+*/()]))/iy;
  let i = 0;
  const s = src.trim();
  while (i < s.length) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (!m) return null;
    i = re.lastIndex;
    if (m[1]) {
      const metric = m[2].toLowerCase() === 'epa' ? 'bsr' : (m[2].toLowerCase() as MetricKey);
      if (!METRIC_KEYS.includes(metric)) return null;
      const team = /^(our|us)$/i.test(m[1]) ? 'our' : Number(m[1]);
      out.push({ t: 'ref', team, metric });
    } else if (m[3]) out.push({ t: 'num', v: Number(m[3]) });
    else out.push({ t: 'op', v: m[4] });
    while (i < s.length && s[i] === ' ') i += 1;
  }
  return out;
}

/** Evaluate an expression; null when it doesn't parse or a ref has no value. */
export function evalStat(src: string, resolve: Resolve): number | null {
  const toks = tokenize(src);
  if (!toks || !toks.length) return null;
  let pos = 0;
  let missing = false;
  const peek = (): Tok | undefined => toks[pos];
  const expr = (): number | null => {
    let v = term();
    while (v != null && peek()?.t === 'op' && ['+', '-'].includes((peek() as { v: string }).v)) {
      const op = (toks[pos++] as { v: string }).v;
      const r = term();
      if (r == null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const term = (): number | null => {
    let v = factor();
    while (v != null && peek()?.t === 'op' && ['*', '/'].includes((peek() as { v: string }).v)) {
      const op = (toks[pos++] as { v: string }).v;
      const r = factor();
      if (r == null) return null;
      if (op === '/' && r === 0) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const factor = (): number | null => {
    const tok = toks[pos++];
    if (!tok) return null;
    if (tok.t === 'num') return tok.v;
    if (tok.t === 'ref') {
      const v = resolve(tok.team, tok.metric);
      if (v == null) missing = true;
      return v ?? 0;
    }
    if (tok.v === '-') {
      const v = factor();
      return v == null ? null : -v;
    }
    if (tok.v === '(') {
      const v = expr();
      if (toks[pos++]?.t !== 'op' || (toks[pos - 1] as { v: string }).v !== ')') return null;
      return v;
    }
    return null;
  };
  const v = expr();
  if (pos !== toks.length || missing || v == null || !Number.isFinite(v)) return null;
  return v;
}
