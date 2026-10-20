import { useRouter } from "@teyik0/furin/link";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { api } from "../lib/client";
import { destinationFromPath, isPreferencesPath, selectedTorrentId } from "../lib/navigation";
import {
  connectionAtom,
  dashboardAtom,
  sessionAtom,
  settingsBackPathAtom,
  themeAtom,
  themeStorageKey,
} from "../state/workspace";
import type { LibraryState, ThemePreference } from "../types";

const THEMES = new Set<string>(["system", "light", "dark"]);

/**
 * The single owner of this workspace's connection to its server: it confirms the session,
 * follows live snapshots, and retries with jittered backoff. Views only read its atoms.
 */
export function TofuStateSync({ dashboard, path }: { dashboard: LibraryState; path: string }) {
  const theme = useAtomValue(themeAtom);
  const setTheme = useSetAtom(themeAtom);
  const setBackPath = useSetAtom(settingsBackPathAtom);
  const setDashboard = useSetAtom(dashboardAtom);
  const setSession = useSetAtom(sessionAtom);
  const setConnection = useSetAtom(connectionAtom);
  const live = useAtomValue(dashboardAtom) ?? { ...dashboard, detailHost: null, host: null };
  const { currentPattern, search } = useRouter();
  const serverId = dashboard.server.id;
  const serverTheme = dashboard.appearance.theme;
  // Library pages show the detail of this torrent; snapshots carry it to keep the pane live.
  const selected =
    currentPattern === "/" || currentPattern === "/thread/:id"
      ? selectedTorrentId(
          live.torrents,
          destinationFromPath(path),
          typeof search.torrent === "string" ? search.torrent : undefined
        )
      : null;

  useEffect(() => {
    const stored = window.localStorage.getItem(themeStorageKey(serverId));
    setTheme(stored && THEMES.has(stored) ? (stored as ThemePreference) : serverTheme);
  }, [serverId, serverTheme, setTheme]);

  useEffect(() => {
    // Fresh loader data replaces the shared library until the stream sends the next snapshot.
    setDashboard((current) => ({
      ...dashboard,
      detailHost: current?.detailHost ?? null,
      host: current?.host ?? null,
    }));
  }, [dashboard, setDashboard]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let authorization: string | null = null;
    let wake: (() => void) | undefined;
    const retryNow = () => wake?.();
    const visible = () => {
      if (document.visibilityState === "visible") {
        retryNow();
      }
    };
    window.addEventListener("online", retryNow);
    document.addEventListener("visibilitychange", visible);
    const signedOut = () => {
      window.location.assign("/signed-out?reason=expired");
    };
    const confirmSession = async () => {
      const { data, error } = await api.session.get({ fetch: { signal } });
      if (error) {
        if (error.status === 401) {
          signedOut();
        }
        return false;
      }
      // New grants invalidate everything this page learned under the previous ones.
      if (authorization !== null && authorization !== data.caller.authorizationVersion) {
        window.location.reload();
        return false;
      }
      authorization = data.caller.authorizationVersion;
      setSession(data);
      return true;
    };
    const follow = async () => {
      let failures = 0;
      while (!signal.aborted) {
        let connected = false;
        try {
          // biome-ignore lint/performance/noAwaitInLoops: Each attempt waits for the previous stream to end.
          if (await confirmSession()) {
            const { data, error } = await api.live.get({
              fetch: { signal },
              query: { selected: selected ?? undefined },
            });
            if (error?.status === 401) {
              signedOut();
              return;
            }
            if (data) {
              for await (const event of data) {
                connected = true;
                failures = 0;
                setConnection("connected");
                setDashboard(event.data);
              }
            }
          }
        } catch {
          // Network failures fall through to the backoff below unless the layout unmounted.
        }
        if (signal.aborted) {
          return;
        }
        failures = connected ? 1 : failures + 1;
        setConnection("reconnecting");
        // Full jitter, capped at 30 seconds; network and foreground events retry at once.
        const delay = Math.random() * Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = undefined;
      }
    };
    void follow();
    return () => {
      controller.abort();
      window.removeEventListener("online", retryNow);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [selected, setConnection, setDashboard, setSession]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  useEffect(() => {
    if (!isPreferencesPath(path)) {
      setBackPath(path);
    }
  }, [path, setBackPath]);

  return null;
}
