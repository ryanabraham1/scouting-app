// Common REBUILT (2026) foul reasons a stands scout can recognize and tag onto a
// report, so a foul count isn't just a number — leads can see WHAT the fouls were
// for. These are advisory tags; the numeric minor/major counts remain the scoring
// source of truth. Ordering: the three most-frequently-called fouls first (the
// contact/pinning/damage cluster that dominates REBUILT match foul points), then a
// few other common ones. Rule numbers track the 2026 Game Manual (Game Rules §G)
// and may shift across Team Updates — treat the labels, not the codes, as the
// scout-facing contract.

export interface FoulReason {
  /** Stable key persisted with the report. Never rename — it's stored data. */
  key: string;
  /** Short, stands-readable label for the chip. */
  label: string;
  /** Rule pointer + plain-English description, shown as a tooltip/help text. */
  hint: string;
}

export const FOUL_REASONS: FoulReason[] = [
  {
    key: 'opponent_contact',
    label: 'Contact in opp. zone',
    hint: 'G415 — initiated contact inside an opponent’s robot perimeter / alliance zone',
  },
  {
    key: 'pinning',
    label: 'Pinning (>3s)',
    hint: 'G418 — pinned an opponent longer than 3 seconds (escalates to a major foul)',
  },
  {
    key: 'damage',
    label: 'Damaged opponent',
    hint: 'G416 — deliberately damaged or functionally impaired an opponent',
  },
  {
    key: 'over_expansion',
    label: 'Over-expansion',
    hint: 'G413 — extended beyond the horizontal / vertical size limits',
  },
  {
    key: 'fuel_violation',
    label: 'Illegal fuel handling',
    hint: 'G405 / G408 / G425 — ejected, controlled, or introduced fuel illegally',
  },
  {
    key: 'tower_contact',
    label: 'Endgame tower contact',
    hint: 'G420 — contacted an opponent at the tower during the final 30 seconds',
  },
];

const LABEL_BY_KEY = new Map(FOUL_REASONS.map((f) => [f.key, f.label]));

/** Human label for a stored key (falls back to the raw key for unknown/legacy). */
export function foulReasonLabel(key: string): string {
  return LABEL_BY_KEY.get(key) ?? key;
}
