import { atom, createStore } from "jotai";
import type { ModalKind, ThemePreference } from "../types";

export const modalAtom = atom<ModalKind | null>(null);
export const selectedTorrentAtom = atom<string | null>(null);
export const settingsBackPathAtom = atom("/");
export const themeAtom = atom<ThemePreference>("system");

export function createTofuStore(initialTheme: ThemePreference) {
  const store = createStore();
  store.set(themeAtom, initialTheme);
  return store;
}
