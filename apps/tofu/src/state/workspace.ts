import { atom, createStore } from "jotai";
import type { ModalKind, ThemePreference, TorrentSummary } from "../types";

export const modalAtom = atom<ModalKind | null>(null);
export const selectedTorrentAtom = atom<string | null>(null);
export const revealTorrentAtom = atom<Pick<TorrentSummary, "id" | "destinationId"> | null>(null);
export const settingsBackPathAtom = atom("/");
export const themeAtom = atom<ThemePreference>("system");
export const globalSearchOpenAtom = atom(false);
export const recentSearchesAtom = atom<string[]>([]);
export const searchDestinationAtom = atom<string | null>(null);

export function createTofuStore(initialTheme: ThemePreference) {
  const store = createStore();
  store.set(themeAtom, initialTheme);
  return store;
}
