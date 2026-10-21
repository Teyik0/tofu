import { atom, createStore } from "jotai";
import type { LibraryState, LiveState } from "../api/modules/dashboard/projection";
import type { Destination } from "../api/modules/destinations/model";
import type { ThemePreference } from "../api/modules/settings/model";
import type { AutomationSection } from "../components/automation-center";
import type { FormModalKind } from "../components/modal";
import type { api } from "../lib/client";

/** Effective grants of this browser or window on the displayed server, read after mount. */
export type ServerSession = NonNullable<Awaited<ReturnType<typeof api.session.get>>["data"]>;

/**
 * Latest dashboard state, seeded from the root loader and replaced by live server snapshots.
 * Live snapshots carry the detail of the selected torrent and, for administrators, host state.
 */
export const dashboardAtom = atom<LiveState | null>(null);
/** Null until the browser confirms its session; privileged controls stay hidden meanwhile. */
export const sessionAtom = atom<ServerSession | null>(null);
/** Connection to the displayed server, owned by the single live state driver. */
export const connectionAtom = atom<"connecting" | "connected" | "reconnecting">("connecting");
export const modalAtom = atom<ModalKind | null>(null);
export const settingsBackPathAtom = atom("/");
export const themeAtom = atom<ThemePreference>("system");
export const globalSearchOpenAtom = atom(false);
export const recentSearchesAtom = atom<string[]>([]);
export const searchDestinationAtom = atom<string | null>(null);

export function createTofuStore(dashboard: LibraryState) {
  const store = createStore();
  store.set(dashboardAtom, { ...dashboard, detailHost: null, host: null });
  store.set(themeAtom, dashboard.appearance.theme);
  return store;
}

/** Appearance is a preference of this device for this server, never a server setting. */
export function themeStorageKey(serverId: string) {
  return `tofu-theme:${serverId}`;
}

export type ModalKind =
  | FormModalKind
  | { type: "automation"; destinationId: string; section: AutomationSection }
  | { type: "deleteDestination"; destination: Destination };
