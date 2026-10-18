import { useRouter } from "@teyik0/furin/link";
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";
import { api } from "../lib/client";
import { destinationFromPath, isPreferencesPath, selectedTorrentId } from "../lib/navigation";
import { dashboardAtom, settingsBackPathAtom, themeAtom } from "../state/workspace";
import type { DashboardState } from "../types";

export function TofuStateSync({ dashboard, path }: { dashboard: DashboardState; path: string }) {
  const theme = useAtomValue(themeAtom);
  const setTheme = useSetAtom(themeAtom);
  const setBackPath = useSetAtom(settingsBackPathAtom);
  const setDashboard = useSetAtom(dashboardAtom);
  const live = useAtomValue(dashboardAtom) ?? dashboard;
  const { currentPattern, search } = useRouter();
  const initialTheme = dashboard.settings.theme;
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
    setTheme(initialTheme);
  }, [initialTheme, setTheme]);

  useEffect(() => {
    // Fresh loader data replaces the live snapshot until the stream sends the next one.
    setDashboard(dashboard);
  }, [dashboard, setDashboard]);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const follow = async () => {
      while (!signal.aborted) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: Each reconnection waits for the previous stream to end.
          const { data } = await api.live.get({
            fetch: { signal },
            query: { selected: selected ?? undefined },
          });
          if (data) {
            for await (const event of data) {
              setDashboard(event.data);
            }
          }
        } catch {
          // The stream reconnects below unless the layout has unmounted.
        }
        if (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    };
    void follow();
    return () => controller.abort();
  }, [selected, setDashboard]);

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
