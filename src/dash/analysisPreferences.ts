/** Device-only preferences: storage failure must never prevent scouting. */
export function readPreference(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

export function writePreference(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Preferences are optional, including in private browsing or full storage.
  }
}

export function teamList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((n): n is number => Number.isSafeInteger(n) && n > 0))].slice(0, 12);
}
