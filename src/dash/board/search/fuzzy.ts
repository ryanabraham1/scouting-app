// src/dash/board/search/fuzzy.ts
// Typo-tolerant word matching for spotlight: exact, prefix (while typing),
// and Damerau-Levenshtein (adjacent transpositions count as one edit).

/** Edit distance with an early exit once it exceeds `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  let prev2: number[] = new Array(m + 1).fill(0);
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i += 1) {
    const cur: number[] = [i];
    let rowMin = i;
    for (let j = 1; j <= m; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2] + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[m];
}

/**
 * How well `token` (what was typed) matches `term` (a known word), 0..1.
 * `allowPrefix` is for the word still being typed.
 */
export function fuzzyScore(token: string, term: string, allowPrefix = false): number {
  if (!token || !term) return 0;
  if (token === term) return 1;
  if (allowPrefix && token.length >= 2 && term.startsWith(token)) return 0.8 + 0.15 * (token.length / term.length);
  if (term.length < 4 || token.length < 3) return 0;
  const max = term.length >= 7 ? 2 : 1;
  const d = editDistance(token, term, max);
  if (d > max) return 0;
  if (d === 1) return 0.72;
  if (d === 2) return 0.58;
  return 0;
}

/** Best fuzzy match of `token` among `terms`. */
export function bestTerm<T extends string>(
  token: string,
  terms: Iterable<T>,
  allowPrefix = false,
): { term: T; score: number } | null {
  let best: { term: T; score: number } | null = null;
  for (const t of terms) {
    const s = fuzzyScore(token, t, allowPrefix);
    if (s > 0 && (!best || s > best.score)) best = { term: t, score: s };
    if (s === 1) break;
  }
  return best;
}
