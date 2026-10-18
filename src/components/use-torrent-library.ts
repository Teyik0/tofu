import { useMutation } from "@teyik0/furin/client";
import { useRouter } from "@teyik0/furin/link";
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { api } from "../lib/client";
import { errorMessage } from "../lib/errors";
import { selectedTorrentId, useRefresh } from "../lib/navigation";
import { armSoundCues } from "../lib/sound-cues";
import { modalAtom } from "../state/workspace";
import type { DashboardState, TorrentSummary } from "../types";

type Filter = "all" | "downloading" | "seeding" | "paused" | "error";
export const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All statuses" },
  { id: "downloading", label: "Downloading" },
  { id: "seeding", label: "Seeding" },
  { id: "paused", label: "Paused" },
  { id: "error", label: "With errors" },
];
export const statusFilters = filters.filter(
  (item): item is { id: Exclude<Filter, "all">; label: string } => item.id !== "all"
);
const matches = (torrent: TorrentSummary, filter: Filter) =>
  filter === "all" ||
  (filter === "downloading"
    ? ["downloading", "idle", "metadata", "checking"].includes(torrent.status)
    : torrent.status === filter);
export function useTorrentLibrary({
  dashboard: data,
  activeDestination,
  requested,
}: {
  activeDestination: string | null;
  dashboard: DashboardState;
  requested: string | undefined;
}) {
  useEffect(() => armSoundCues(window), []);
  const router = useRouter();
  const setModal = useSetAtom(modalAtom);
  const refresh = useRefresh();
  const bulk = useMutation(api.bulk.post);
  const pause = useMutation((id: string) => api.torrents({ id }).pause.post());
  const resume = useMutation((id: string) => api.torrents({ id }).resume.post());
  const repair = useMutation((id: string) => api.torrents({ id }).repair.post());
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"added" | "name" | "progress">("added");
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const scoped = useMemo(
    () =>
      data.torrents.filter(
        (torrent) => activeDestination === null || torrent.destinationId === activeDestination
      ),
    [data, activeDestination]
  );
  const counts = useMemo(() => {
    const totals: { [Id in (typeof statusFilters)[number]["id"]]: number } = {
      downloading: 0,
      error: 0,
      paused: 0,
      seeding: 0,
    };
    for (const torrent of scoped) {
      for (const { id } of statusFilters) {
        if (matches(torrent, id)) {
          totals[id] += 1;
        }
      }
    }
    return totals;
  }, [scoped]);
  const torrents = useMemo(() => {
    const query = search.toLocaleLowerCase("en-US");
    const locations = new Map(
      data.destinations.map((item) => [item.id, `${item.name} ${item.downloadPath}`])
    );
    return scoped
      .filter(
        (torrent) =>
          matches(torrent, filter) &&
          `${torrent.name} ${locations.get(torrent.destinationId) ?? ""}`
            .toLocaleLowerCase("en-US")
            .includes(query)
      )
      .sort((a, b) =>
        sort === "name"
          ? a.name.localeCompare(b.name, "en-US")
          : sort === "progress"
            ? (b.progress ?? -1) - (a.progress ?? -1)
            : b.addedAt - a.addedAt
      );
  }, [scoped, filter, search, sort, data.destinations]);
  const selectedId = selectedTorrentId(data.torrents, activeDestination, requested);
  const reveal = useEffectEvent((id: string) => {
    // A torrent opened from search or added elsewhere stays visible despite the current filter.
    if (!torrents.some((torrent) => torrent.id === id)) {
      setSearch("");
      setFilter("all");
    }
  });
  useEffect(() => {
    if (requested) {
      reveal(requested);
    }
  }, [requested]);
  const destination = data.destinations.find((item) => item.id === activeDestination);
  const add = () => setModal({ destinationId: activeDestination ?? "default", type: "add" });
  const act = useCallback(
    async (key: string, task: () => Promise<unknown>) => {
      setPending((previous) => new Set(previous).add(key));
      setError(null);
      try {
        await task();
        await refresh();
      } catch (cause) {
        setError(errorMessage(cause, "An error occurred"));
      } finally {
        setPending((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      }
    },
    [refresh]
  );

  return {
    act,
    activeDestination,
    add,
    bulk,
    counts,
    destination,
    destinations: data.destinations,
    error,
    filter,
    pause,
    pending,
    repair,
    resume,
    router,
    scoped,
    search,
    selectedId,
    setError,
    setFilter,
    setModal,
    setSearch,
    setSort,
    sort,
    torrents,
  };
}
