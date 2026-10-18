import { atom, createStore } from "jotai";
import type { DashboardState, ModalKind, ThemePreference } from "../types";

/**
 * Latest dashboard state, seeded from the root loader and replaced by live server snapshots.
 * Live snapshots carry the detail of the selected torrent.
 */
export const dashboardAtom = atom<DashboardState | null>(null);
export const modalAtom = atom<ModalKind | null>(null);
export const settingsBackPathAtom = atom("/");
export const themeAtom = atom<ThemePreference>("system");
export const globalSearchOpenAtom = atom(false);
export const recentSearchesAtom = atom<string[]>([]);
export const searchDestinationAtom = atom<string | null>(null);

export function createTofuStore(dashboard: DashboardState) {
  const store = createStore();
  store.set(dashboardAtom, dashboard);
  store.set(themeAtom, dashboard.settings.theme);
  return store;
}
