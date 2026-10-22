// src/search/openAppSearch.ts
// Kept apart from GlobalSearch so header buttons can open the palette without
// importing the router (GlobalSearch imports it; the router imports screens).
export const OPEN_APP_SEARCH = 'app-search:open';

export function openAppSearch(): void {
  window.dispatchEvent(new Event(OPEN_APP_SEARCH));
}
