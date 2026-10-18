import { useMutation, useQuery } from "@teyik0/furin/client";
import { useRouter } from "@teyik0/furin/link";
import { useAtom } from "jotai";
import { useMemo, useState } from "react";
import { useAsyncAction } from "../hooks/use-async-action";
import { useSourceSearch } from "../hooks/use-source-search";
import { api } from "../lib/client";
import { errorMessage } from "../lib/errors";
import { groupSearchReleases, searchTorrents } from "../lib/global-search";
import { isSupersededNavigation, useRefresh } from "../lib/navigation";
import { playSoundCue } from "../lib/sound-cues";
import { recentSearchesAtom, searchDestinationAtom } from "../state/workspace";
import type {
  DashboardState,
  GlobalSearchScope,
  SearchReleaseGroup,
  SourcePluginId,
  TorrentSummary,
} from "../types";

export type SearchItem =
  | { kind: "torrent"; torrent: TorrentSummary }
  | { kind: "release"; group: SearchReleaseGroup };
export interface GlobalSearchProps {
  activeDestination: string | null;
  close: () => void;
  dashboard: DashboardState;
  inputRef: React.RefObject<HTMLInputElement | null>;
}

export function useGlobalSearch({
  dashboard,
  activeDestination,
  close,
}: Pick<GlobalSearchProps, "dashboard" | "activeDestination" | "close">) {
  const router = useRouter();
  const refresh = useRefresh();
  const [recent, setRecent] = useAtom(recentSearchesAtom);
  const [lastDestination, setLastDestination] = useAtom(searchDestinationAtom);
  const [destinationId, setDestinationId] = useState(
    () =>
      dashboard.destinations.find((thread) => thread.id === activeDestination)?.id ??
      dashboard.destinations.find((thread) => thread.id === lastDestination)?.id ??
      dashboard.destinations[0]?.id ??
      ""
  );
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<GlobalSearchScope>("all");
  const [review, setReview] = useState<SearchReleaseGroup | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, setError, run } = useAsyncAction("Unable to download the release");
  const { data: automation, error: pluginError } = useQuery(api.automation.get);
  const add = useMutation(api.discover.add.post);
  const sourceIds =
    automation && "plugins" in automation
      ? automation.plugins
          .filter((plugin) => plugin.enabled && ["nyaa", "tsundere", "c411"].includes(plugin.id))
          .map((plugin) => plugin.id as SourcePluginId)
      : [];
  const { sources, retry } = useSourceSearch(scope === "torrents" ? "" : query.trim(), sourceIds);
  const grouped = useMemo(
    () => groupSearchReleases(sources.flatMap((source) => source.releases)),
    [sources]
  );
  const found = useMemo(
    () => searchTorrents(dashboard.torrents, query),
    [dashboard.torrents, query]
  );
  const local = query.trim()
    ? found
    : found.filter((torrent) => !["paused", "error"].includes(torrent.status)).slice(0, 6);
  const localItems: SearchItem[] =
    scope === "sources" ? [] : local.map((torrent) => ({ kind: "torrent", torrent }));
  const releaseItems: SearchItem[] =
    scope === "torrents" ? [] : grouped.map((group) => ({ group, kind: "release" }));
  const items = [...localItems, ...releaseItems];
  const destination = dashboard.destinations.find((item) => item.id === destinationId);
  const currentReview = review ? (grouped.find((group) => group.key === review.key) ?? null) : null;
  const enabledSources = new Set(sourceIds);
  const release = currentReview?.releases.find((item) => enabledSources.has(item.sourceId));
  const existing = currentReview
    ? dashboard.torrents.find((torrent) => torrent.id.toLowerCase() === currentReview.key)
    : null;
  const loading = sources.some((source) => source.loading);
  const remember = () => {
    const text = query.trim();
    if (text) {
      setRecent((previous) => [text, ...previous.filter((item) => item !== text)].slice(0, 6));
    }
  };
  const updateQuery = (value: string) => {
    setQuery(value);
    setReview(null);
    setNotice(null);
    setError(null);
  };
  const openTorrent = async (torrent: TorrentSummary) => {
    setError(null);
    remember();
    try {
      await router.navigate({
        params: { id: torrent.destinationId },
        resetScroll: false,
        search: { torrent: torrent.id },
        to: "/thread/:id",
      });
      close();
    } catch (cause) {
      if (!isSupersededNavigation(cause)) {
        setError(errorMessage(cause, "Unable to open the torrent"));
      }
    }
  };
  const choose = (item: SearchItem) => {
    if (item.kind === "torrent") {
      void openTorrent(item.torrent);
    } else {
      remember();
      setReview(item.group);
      setNotice(null);
      setError(null);
    }
  };
  const download = () => {
    if (!(release && destination) || existing) {
      return;
    }
    return run(async () => {
      await add.mutateAsync({
        destinationId: destination.id,
        id: release.id,
        paused: false,
        sourceId: release.sourceId,
      });
      playSoundCue("added");
      setLastDestination(destination.id);
      setNotice(`Added to ${destination.name}.`);
      setReview(null);
      await refresh();
    });
  };

  return {
    automation,
    busy,
    choose,
    currentReview,
    data: dashboard,
    destination,
    destinationId,
    download,
    error,
    existing,
    found,
    items,
    loading,
    localItems,
    notice,
    openTorrent,
    pluginError,
    query,
    recent,
    release,
    releaseItems,
    retry,
    review,
    router,
    scope,
    setDestinationId,
    setReview,
    setScope,
    sourceIds,
    sources,
    updateQuery,
  };
}
