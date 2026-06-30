// Single source of truth for human-readable match labels. Scouting data stores
// raw keys like "2026casnv_qm1" and comp levels like "qm"/"sf"/"f"; users should
// never have to decipher those. Use formatMatchKey when you have comp_level +
// match_number, or formatMatchKeyRaw when all you have is the raw match key.

const LEVEL_LABEL: Record<string, string> = {
  qm: 'Qual',
  q: 'Qual',
  qual: 'Qual',
  ef: 'Eighth',
  qf: 'Quarter',
  sf: 'Semi',
  f: 'Final',
  final: 'Final',
};

/** "qm", 12 -> "Qual 12". Unknown levels fall back to a capitalized label. */
export function formatMatchKey(
  compLevel: string | null | undefined,
  matchNumber: number | null | undefined,
): string {
  const level = (compLevel ?? '').trim().toLowerCase();
  const label =
    LEVEL_LABEL[level] ??
    (level ? level.charAt(0).toUpperCase() + level.slice(1) : 'Match');
  const n = matchNumber == null || Number.isNaN(matchNumber) ? '' : ` ${matchNumber}`;
  return `${label}${n}`.trim();
}

/**
 * A qualification match is comp_level in {qm, q, qual} (case-insensitive);
 * everything else (sf, f, ef, qf, …) is a playoff. Single source of truth so
 * the quals-only rule (scouting assignments are created ONLY for quals) isn't
 * scattered as string literals across the codebase.
 */
const QUAL_LEVELS = new Set(['qm', 'q', 'qual']);

/** True iff the given comp level is a qualification level (case-insensitive). */
export function isQualLevel(compLevel: string | null | undefined): boolean {
  return QUAL_LEVELS.has((compLevel ?? '').trim().toLowerCase());
}

/**
 * True iff a raw match key (e.g. "2026casnv_qm1") is a qualification match.
 * Parses the trailing "<level><number>" token; anything unparseable is treated
 * as NOT a qual (so playoff/garbage keys are never assigned).
 */
export function isQualMatchKey(matchKey: string | null | undefined): boolean {
  if (!matchKey) return false;
  const tail = matchKey.includes('_') ? matchKey.slice(matchKey.lastIndexOf('_') + 1) : matchKey;
  const m = tail.match(/^([a-zA-Z]+)\d+/);
  if (!m) return false;
  return isQualLevel(m[1]);
}

/** Play order for comp levels: qual → playoffs → final. */
const LEVEL_SORT: Record<string, number> = { qm: 0, q: 0, qual: 0, ef: 1, qf: 2, sf: 3, f: 4, final: 4 };

/** Parse a raw match key into a [levelRank, matchNumber] sort key. */
function matchSortKey(matchKey: string): [number, number] {
  const tail = matchKey.includes('_') ? matchKey.slice(matchKey.lastIndexOf('_') + 1) : matchKey;
  const m = tail.match(/^([a-zA-Z]+)(\d+)/);
  if (!m) return [9, Number.MAX_SAFE_INTEGER];
  return [LEVEL_SORT[m[1].toLowerCase()] ?? 9, Number(m[2])];
}

/**
 * Compare two raw match keys in PLAY order (comp level, then match number).
 * A plain string compare orders "qm10" before "qm2"; this parses the trailing
 * "<level><number>" so "qm2" precedes "qm10" and quals precede playoffs.
 */
export function compareMatchKeys(a: string, b: string): number {
  const [la, na] = matchSortKey(a);
  const [lb, nb] = matchSortKey(b);
  return la !== lb ? la - lb : na - nb;
}

/**
 * "2026casnv_qm1" -> "Qual 1". Parses the trailing "<level><number>" token.
 * Falls back to the raw key if it can't be parsed.
 */
export function formatMatchKeyRaw(matchKey: string | null | undefined): string {
  if (!matchKey) return '';
  // Take the part after the event code, e.g. "2026casnv_qm1" -> "qm1".
  const tail = matchKey.includes('_') ? matchKey.slice(matchKey.lastIndexOf('_') + 1) : matchKey;
  // Parse "<level><set>" with an optional "m<match>" suffix (double-elim /
  // best-of-3 finals: "sf3m1", "f1m2"). Without the suffix-aware parse, "f1m1"
  // and "f1m2" (the THREE final games) all collapse to "Final 1", and double-elim
  // replays lose their identity.
  const m = tail.match(/^([a-zA-Z]+)(\d+)(?:m(\d+))?/);
  if (!m) return matchKey;
  const level = m[1];
  const setNum = Number(m[2]);
  const within = m[3] != null ? Number(m[3]) : null;
  const lvl = level.toLowerCase();
  // Finals are a best-of-N within a single set ("f1m1/f1m2/f1m3"): the match
  // number is the game number, so "f1m2" → "Final 2".
  if ((lvl === 'f' || lvl === 'final') && within != null) {
    return formatMatchKey(level, within);
  }
  // Other playoff rounds key off the set number ("sf3m1" → "Semi 3"); only
  // disambiguate when a set genuinely has more than one match ("sf3m2" → "Semi 3-2").
  if (within != null && within > 1) {
    return `${formatMatchKey(level, setNum)}-${within}`;
  }
  return formatMatchKey(level, setNum);
}
