import { useRouter } from "@teyik0/furin/link";
import { createSyncClient } from "@teyik0/furin/sync/client";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect, useRef } from "react";
import type { ThemePreference } from "../../../../package/plugins/src/settings-model";
import type { LibraryState } from "../api/modules/dashboard/projection";
import { api } from "../lib/client";
import { destinationFromPath, isPreferencesPath, selectedTorrentId } from "../lib/navigation";
import {
  anilistBackPathAtom,
  anilistHasUpdatesAtom,
  anilistNotificationRevisionAtom,
  connectionAtom,
  dashboardAtom,
  sessionAtom,
  settingsBackPathAtom,
  themeAtom,
  themeStorageKey,
} from "../state/workspace";

const THEMES = new Set<string>(["system", "light", "dark"]);

/**
 * The single owner of this workspace's connection to its server: it confirms the session,
 * follows Furin live queries. Views only read its atoms.
 */
export function TofuStateSync({ dashboard, path }: { dashboard: LibraryState; path: string }) {
  const authorization = useRef<string | null>(null);
  const theme = useAtomValue(themeAtom);
  const setTheme = useSetAtom(themeAtom);
  const setBackPath = useSetAtom(settingsBackPathAtom);
  const setAniListBackPath = useSetAtom(anilistBackPathAtom);
  const setAniListHasUpdates = useSetAtom(anilistHasUpdatesAtom);
  const setAniListNotificationRevision = useSetAtom(anilistNotificationRevisionAtom);
  const administer = useAtomValue(sessionAtom)?.capabilities.administer === true;
  const setDashboard = useSetAtom(dashboardAtom);
  const setSession = useSetAtom(sessionAtom);
  const setConnection = useSetAtom(connectionAtom);
  const live = useAtomValue(dashboardAtom) ?? { ...dashboard, detailHost: null, host: null };
  const { currentPattern, search } = useRouter();
  const serverId = dashboard.server.id;
  const inAniList = path === "/anilist" || path === "/anilist/notifications";
  const destination = destinationFromPath(path, serverId);
  const serverTheme = dashboard.appearance.theme;
  // Library pages show the detail of this torrent; snapshots carry it to keep the pane live.
  const selected =
    currentPattern === "/" ||
    (currentPattern === "/thread/:serverId/:threadId" && destination !== null)
      ? selectedTorrentId(
          live.torrents,
          destination,
          typeof search.torrent === "string" ? search.torrent : undefined
        )
      : null;

  useEffect(() => {
    const stored = window.localStorage.getItem(themeStorageKey(serverId));
    setTheme(stored && THEMES.has(stored) ? (stored as ThemePreference) : serverTheme);
  }, [serverId, serverTheme, setTheme]);

  useEffect(() => {
    // Fresh loader data replaces the shared library until the live query completes.
    setDashboard((current) => ({
      ...dashboard,
      detailHost: current?.detailHost ?? null,
      host: current?.host ?? null,
    }));
  }, [dashboard, setDashboard]);

  useEffect(() => {
    const client = createSyncClient({
      fetch: { cache: "no-store", credentials: "include" },
      url: window.location.origin,
    });
    const controller = new AbortController();
    let checkingNotifications = false;
    const checkNotifications = async () => {
      if (!administer || checkingNotifications || controller.signal.aborted) {
        return;
      }
      checkingNotifications = true;
      try {
        await api.anilist.notifications.check.post(undefined, {
          fetch: { signal: controller.signal },
        });
      } catch {
        // The server owns retries; a failed wake-up check leaves the last badge intact.
      } finally {
        checkingNotifications = false;
      }
    };
    const notifications = administer
      ? client.subscribe(api.anilist.notifications.status.get.live(), ({ data, error }) => {
          if (data && !error) {
            setAniListHasUpdates(data.hasUpdates);
            setAniListNotificationRevision(data.revision);
          }
        })
      : null;
    if (!administer) {
      setAniListHasUpdates(false);
      setAniListNotificationRevision(0);
    }
    void checkNotifications();
    const connection = client.subscribeConnection(({ status }) => {
      if (status === "unauthorized") {
        setSession(null);
        setDashboard(null);
        window.location.assign("/signed-out?reason=expired");
      } else if (status !== "closed") {
        setConnection(status === "connected" ? "connected" : "reconnecting");
        if (status === "connected") {
          void checkNotifications();
        }
      }
    });
    const subscription = client.subscribe(
      api.state.get.live({
        query: { detail: selected ? "true" : "false", selected: selected ?? undefined },
      }),
      ({ data, error }) => {
        if (error || !data?.viewer) {
          return;
        }
        const version = data.viewer.caller.authorizationVersion;
        if (authorization.current !== null && authorization.current !== version) {
          client.close();
          setSession(null);
          setDashboard(null);
          window.location.reload();
          return;
        }
        authorization.current = version;
        setSession(data.viewer);
        setDashboard(data);
      }
    );
    const reconnect = (event: Event) => {
      if (event.type === "online" || document.visibilityState === "visible") {
        client.reconnect();
        void checkNotifications();
      }
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", checkNotifications);
    document.addEventListener("visibilitychange", reconnect);
    return () => {
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", checkNotifications);
      document.removeEventListener("visibilitychange", reconnect);
      subscription();
      controller.abort();
      notifications?.();
      connection();
      client.close();
    };
  }, [
    administer,
    selected,
    setAniListHasUpdates,
    setAniListNotificationRevision,
    setConnection,
    setDashboard,
    setSession,
  ]);

  useEffect(() => {
    // A pending invitation kept by /pair for reloads is never needed once the library opens.
    try {
      window.sessionStorage.removeItem("tofu-invitation");
    } catch {
      // Storage is unavailable, so the pairing page kept nothing.
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!isPreferencesPath(path)) {
      setBackPath(path);
    }
  }, [path, setBackPath]);

  useEffect(() => {
    if (path === "/anilist" || path === "/anilist/notifications") {
      setAniListBackPath(path);
    }
  }, [path, setAniListBackPath]);

  useEffect(() => {
    if (inAniList) {
      return;
    }
    const timeout = window.setTimeout(() => setAniListBackPath("/anilist"), 3 * 60_000);
    return () => window.clearTimeout(timeout);
  }, [inAniList, setAniListBackPath]);

  return null;
}
