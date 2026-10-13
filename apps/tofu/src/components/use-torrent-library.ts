import { useMutation } from "@teyik0/furin/client";
import { useAtom, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/client";
import { errorMessage } from "../lib/errors";
import { useRefresh } from "../lib/navigation";
import { armSoundCues } from "../lib/sound-cues";
import { modalAtom, revealTorrentAtom, selectedTorrentAtom } from "../state/workspace";
import type { DashboardState, TorrentDetail, TorrentSummary } from "../types";

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
export interface TorrentLibraryProps {
  activeDestination: string | null;
  dashboard: DashboardState;
  initialDetail: Promise<TorrentDetail | null>;
  initialTorrentId: string | null;
}

export function useTorrentLibrary({
  dashboard: data,
  activeDestination,
  initialDetail,
}: Pick<TorrentLibraryProps, "dashboard" | "activeDestination" | "initialDetail">) {
  useEffect(() => {
    // Live details can replace this deferred snapshot before navigation cancels its stream.
    // Await still receives the original promise and displays errors when the snapshot is used.
    void initialDetail.catch(() => undefined);
  }, [initialDetail]);
  useEffect(() => armSoundCues(window), []);
  const setModal = useSetAtom(modalAtom);
  const [selected, setSelected] = useAtom(selectedTorrentAtom);
  const [reveal, setReveal] = useAtom(revealTorrentAtom);
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
  useEffect(() => {
    if (reveal && reveal.destinationId === activeDestination) {
      setSearch("");
      setFilter("all");
      setSelected(reveal.id);
      setReveal(null);
    }
  }, [reveal, activeDestination, setSelected, setReveal]);
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
  const torrents = useMemo(
    () =>
      scoped
        .filter(
          (torrent) =>
            matches(torrent, filter) &&
            torrent.name.toLocaleLowerCase("en-US").includes(search.toLocaleLowerCase("en-US"))
        )
        .sort((a, b) =>
          sort === "name"
            ? a.name.localeCompare(b.name, "en-US")
            : sort === "progress"
              ? (b.progress ?? -1) - (a.progress ?? -1)
              : b.addedAt - a.addedAt
        ),
    [scoped, filter, search, sort]
  );
  const currentId = scoped.find((torrent) => torrent.id === selected)?.id ?? scoped[0]?.id;
  const selectedId = torrents.find((torrent) => torrent.id === currentId)?.id ?? torrents[0]?.id;
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
    add,
    bulk,
    counts,
    destination,
    error,
    filter,
    pause,
    pending,
    repair,
    resume,
    scoped,
    search,
    selected,
    selectedId,
    setError,
    setFilter,
    setModal,
    setSearch,
    setSelected,
    setSort,
    sort,
    torrents,
  };
}
