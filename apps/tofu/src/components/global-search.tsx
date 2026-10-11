import { Autocomplete } from "@base-ui/react/autocomplete";
import { useMutation, useQuery } from "@teyik0/furin/client";
import { useRouter } from "@teyik0/furin/link";
import { Alert, AlertDescription } from "@tofu/ui/alert";
import { sourceNames } from "@tofu/ui/automation-fields";
import { Badge } from "@tofu/ui/badge";
import { Button } from "@tofu/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@tofu/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@tofu/ui/empty";
import { Field, FieldLabel } from "@tofu/ui/field";
import { bytes, percent, statusLabels } from "@tofu/ui/format";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@tofu/ui/input-group";
import { OptionSelect } from "@tofu/ui/option-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@tofu/ui/tabs";
import { useAtom, useSetAtom } from "jotai";
import {
  ArrowUpRightIcon,
  DownloadIcon,
  HistoryIcon,
  LoaderCircleIcon,
  SearchIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSourceSearch } from "../hooks/use-source-search";
import { api } from "../lib/client";
import { groupSearchReleases, searchTorrents } from "../lib/global-search";
import { isSupersededNavigation, useRefresh } from "../lib/navigation";
import { playSoundCue } from "../lib/sound-cues";
import {
  globalSearchOpenAtom,
  recentSearchesAtom,
  revealTorrentAtom,
  searchDestinationAtom,
  selectedTorrentAtom,
} from "../state/workspace";
import type {
  DashboardState,
  GlobalSearchScope,
  SearchReleaseGroup,
  SourcePluginId,
  TorrentSummary,
} from "../types";
import { StatusGlyph } from "./status-glyph";

export function GlobalSearchTrigger() {
  const setOpen = useSetAtom(globalSearchOpenAtom);
  return (
    <Button
      aria-keyshortcuts="Meta+k Control+k"
      aria-label="Search everything"
      className="global-search-trigger"
      onClick={() => setOpen(true)}
      variant="outline"
    >
      <SearchIcon data-icon="inline-start" />
      <span>Search everything…</span>
      <kbd>⌘ K</kbd>
    </Button>
  );
}

export function GlobalSearch({
  dashboard,
  activeDestination,
}: {
  dashboard: DashboardState;
  activeDestination: string | null;
}) {
  const [open, setOpen] = useAtom(globalSearchOpenAtom);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        event.altKey ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "k"
      ) {
        return;
      }
      const otherDialog = document.querySelector(
        '[role="dialog"][data-open]:not(.global-search-dialog), [role="alertdialog"][data-open]'
      );
      if (otherDialog) {
        return;
      }
      event.preventDefault();
      setOpen((value) => !value);
    };
    window.addEventListener("keydown", shortcut);
    return () => window.removeEventListener("keydown", shortcut);
  }, [setOpen]);
  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogContent className="global-search-dialog" initialFocus={inputRef} showCloseButton>
        <DialogTitle className="sr-only">Search everything</DialogTitle>
        <DialogDescription className="sr-only">
          Find torrents across every thread and search your enabled sources. Review a release before
          downloading.
        </DialogDescription>
        {!!open && (
          <SearchContent
            activeDestination={activeDestination}
            close={() => setOpen(false)}
            dashboard={dashboard}
            inputRef={inputRef}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

type SearchItem =
  | { kind: "torrent"; torrent: TorrentSummary }
  | { kind: "release"; group: SearchReleaseGroup };

function itemLabel(item: SearchItem) {
  return item.kind === "torrent" ? item.torrent.name : (item.group.releases[0]?.title ?? "Release");
}

function SearchContent({
  dashboard,
  activeDestination,
  close,
  inputRef,
}: {
  dashboard: DashboardState;
  activeDestination: string | null;
  close: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const router = useRouter();
  const refresh = useRefresh();
  const setSelectedTorrent = useSetAtom(selectedTorrentAtom);
  const setRevealTorrent = useSetAtom(revealTorrentAtom);
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const { data: live } = useQuery(api.state.get, { query: { detail: "false" } });
  const data = live && "torrents" in live ? live : dashboard;
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
  const found = useMemo(() => searchTorrents(data.torrents, query), [data.torrents, query]);
  const local = query.trim()
    ? found
    : found.filter((torrent) => !["paused", "error"].includes(torrent.status)).slice(0, 6);
  const localItems: SearchItem[] =
    scope === "sources" ? [] : local.map((torrent) => ({ kind: "torrent", torrent }));
  const releaseItems: SearchItem[] =
    scope === "torrents" ? [] : grouped.map((group) => ({ group, kind: "release" }));
  const items = [...localItems, ...releaseItems];
  const destination = data.destinations.find((item) => item.id === destinationId);
  const currentReview = review ? (grouped.find((group) => group.key === review.key) ?? null) : null;
  const release = currentReview?.releases.find((item) => sourceIds.includes(item.sourceId));
  const existing = currentReview
    ? data.torrents.find((torrent) => torrent.id.toLowerCase() === currentReview.key)
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
    setSelectedTorrent(torrent.id);
    remember();
    try {
      await router.navigate({
        params: { id: torrent.destinationId },
        resetScroll: false,
        to: "/thread/:id",
      });
      setRevealTorrent({ destinationId: torrent.destinationId, id: torrent.id });
      close();
    } catch (cause) {
      if (!isSupersededNavigation(cause)) {
        setError(cause instanceof Error ? cause.message : "Unable to open the torrent");
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
  const download = async () => {
    if (!(release && destination) || existing || busyRef.current) {
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
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
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to download the release");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Autocomplete.Root<SearchItem>
      autoHighlight="always"
      filter={null}
      inline
      items={items}
      itemToStringValue={itemLabel}
      mode="none"
      onValueChange={(value, details) => {
        if (details.reason === "item-press") {
          details.cancel();
        } else {
          updateQuery(value);
        }
      }}
      open
      value={query}
    >
      <div className="global-search-heading">
        <Field>
          <FieldLabel className="sr-only" htmlFor="global-search-input">
            Search everything
          </FieldLabel>
          <InputGroup>
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <Autocomplete.Input
              aria-label="Search everything"
              disabled={busy}
              id="global-search-input"
              maxLength={1000}
              placeholder="Search torrents and sources…"
              ref={inputRef}
              render={<InputGroupInput />}
            />
            <InputGroupAddon align="inline-end">
              <kbd>Esc</kbd>
            </InputGroupAddon>
          </InputGroup>
        </Field>
      </div>
      <Tabs
        className="global-search-tabs"
        onValueChange={(value) => {
          if (value === "all" || value === "torrents" || value === "sources") {
            setScope(value);
            setReview(null);
          }
        }}
        value={scope}
      >
        <TabsList aria-label="Search scope" className="global-search-scopes" variant="line">
          <TabsTrigger value="all">All</TabsTrigger>
          <TabsTrigger value="torrents">My torrents</TabsTrigger>
          <TabsTrigger value="sources">Sources</TabsTrigger>
        </TabsList>
        <TabsContent className="global-search-body" value={scope}>
          {!query && recent.length > 0 && (
            <div className="global-search-recent">
              <span>
                <HistoryIcon /> Recent searches
              </span>
              <div>
                {recent.map((text) => (
                  <Button key={text} onClick={() => updateQuery(text)} size="sm" variant="ghost">
                    {text}
                  </Button>
                ))}
              </div>
            </div>
          )}
          <Autocomplete.List aria-label="Search results" className="global-search-results">
            {localItems.length > 0 && (
              <Autocomplete.Group items={localItems}>
                <Autocomplete.GroupLabel className="global-search-group-heading">
                  {query ? "My torrents" : "Active torrents"}
                  <span>All threads · {localItems.length}</span>
                </Autocomplete.GroupLabel>
                {localItems.map(
                  (item) =>
                    item.kind === "torrent" && (
                      <Autocomplete.Item
                        className="global-search-result"
                        disabled={busy}
                        key={item.torrent.id}
                        onClick={() => choose(item)}
                        value={item}
                      >
                        <StatusGlyph
                          progress={item.torrent.progress}
                          size={32}
                          status={item.torrent.status}
                        />
                        <div className="global-search-result-copy">
                          <strong>{item.torrent.name}</strong>
                          <span>
                            {data.destinations.find(
                              (thread) => thread.id === item.torrent.destinationId
                            )?.name ?? "Unknown thread"}{" "}
                            · {statusLabels[item.torrent.status]} · {percent(item.torrent.progress)}
                          </span>
                        </div>
                        <span className="global-search-result-action">
                          Open <ArrowUpRightIcon />
                        </span>
                      </Autocomplete.Item>
                    )
                )}
              </Autocomplete.Group>
            )}
            {releaseItems.length > 0 && (
              <Autocomplete.Group items={releaseItems}>
                <Autocomplete.GroupLabel className="global-search-group-heading">
                  Sources<span>{releaseItems.length} releases</span>
                </Autocomplete.GroupLabel>
                {releaseItems.map((item) => {
                  if (item.kind !== "release") {
                    return null;
                  }
                  const [first] = item.group.releases;
                  if (!first) {
                    return null;
                  }
                  const duplicate = data.torrents.find(
                    (torrent) => torrent.id.toLowerCase() === item.group.key
                  );
                  return (
                    <Autocomplete.Item
                      className="global-search-result"
                      data-reviewed={currentReview?.key === item.group.key || undefined}
                      disabled={busy}
                      key={item.group.key}
                      onClick={() => choose(item)}
                      value={item}
                    >
                      <span className="global-search-release-icon">
                        <DownloadIcon />
                      </span>
                      <div className="global-search-result-copy">
                        <strong>{first.title}</strong>
                        <span>
                          {[
                            ...new Set(
                              item.group.releases.map((entry) => sourceNames[entry.sourceId])
                            ),
                          ].join(" / ")}{" "}
                          · {first.language ?? "—"} · {bytes(first.size)} · {first.seeders ?? "—"}{" "}
                          seeds
                        </span>
                      </div>
                      <span className="global-search-result-action">
                        {duplicate
                          ? `Already in ${data.destinations.find((thread) => thread.id === duplicate.destinationId)?.name ?? "a thread"}`
                          : "Review"}
                      </span>
                    </Autocomplete.Item>
                  );
                })}
              </Autocomplete.Group>
            )}
          </Autocomplete.List>
          {items.length === 0 && !loading && (
            <Empty className="global-search-empty">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <SearchIcon />
                </EmptyMedia>
                <EmptyTitle>{query ? "No matches found" : "One search, every thread"}</EmptyTitle>
                <EmptyDescription>
                  {query
                    ? "Try another title or different keywords."
                    : "Find your downloads or discover a release from your enabled sources."}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {scope !== "torrents" && (
            <div aria-live="polite" className="global-search-source-status">
              {automation || pluginError ? (
                pluginError ? (
                  <Alert>
                    <AlertDescription>
                      Unable to load sources. Reopen search to retry.
                    </AlertDescription>
                  </Alert>
                ) : sourceIds.length ? null : (
                  <span>
                    Enable a source in{" "}
                    <Button
                      onClick={() => {
                        close();
                        void router.navigate({ to: "/plugins/sources" });
                      }}
                      size="sm"
                      variant="link"
                    >
                      Plugins
                    </Button>{" "}
                    to search for releases.
                  </span>
                )
              ) : (
                <span>Loading sources…</span>
              )}
              {sourceIds.length > 0 && query.trim().length < 2 && (
                <span>
                  Type at least two characters to search{" "}
                  {sourceIds.map((id) => sourceNames[id]).join(" and ")}.
                </span>
              )}
              {sources.map((source) => (
                <div key={source.sourceId}>
                  <Badge variant="outline">
                    {!!source.loading && <LoaderCircleIcon className="animate-spin" />}
                    {sourceNames[source.sourceId]}
                    {source.sourceId === "tsundere" ? " · Recent releases" : ""} ·{" "}
                    {source.loading
                      ? "Searching…"
                      : source.error
                        ? "Unavailable"
                        : `${source.releases.length} results`}
                  </Badge>
                  {!!source.error && (
                    <Alert>
                      <AlertDescription>
                        {source.error}{" "}
                        <Button disabled={loading || busy} onClick={retry} size="sm" variant="link">
                          Retry
                        </Button>
                      </AlertDescription>
                    </Alert>
                  )}
                  {!!source.warning && <p>{source.warning}</p>}
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>
      {!!(notice || error) && (
        <Alert className="global-search-feedback" variant={error ? "destructive" : "default"}>
          <AlertDescription role="status">{error ?? notice}</AlertDescription>
        </Alert>
      )}
      {!!currentReview && !!release && (
        <div className="global-search-review">
          <div className="global-search-review-title">
            <strong>{release.title}</strong>
            <span>
              {release.resolution ?? "—"} · {release.language ?? "—"} · {bytes(release.size)} ·{" "}
              {release.seeders ?? "—"} seeds
            </span>
          </div>
          {existing ? (
            <Button disabled={busy} onClick={() => void openTorrent(existing)}>
              <ArrowUpRightIcon data-icon="inline-start" />
              Open existing torrent
            </Button>
          ) : (
            <div className="global-search-download">
              <Field orientation="horizontal">
                <FieldLabel htmlFor="global-search-destination">Download to</FieldLabel>
                <OptionSelect
                  disabled={busy}
                  id="global-search-destination"
                  onValueChange={setDestinationId}
                  options={data.destinations.map((thread) => ({
                    label: thread.name,
                    value: thread.id,
                  }))}
                  value={destination?.id ?? ""}
                />
              </Field>
              <Button disabled={busy || !destination} onClick={() => void download()}>
                {busy ? (
                  <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
                ) : (
                  <DownloadIcon data-icon="inline-start" />
                )}
                {busy ? "Adding…" : "Download"}
              </Button>
            </div>
          )}
          {destination && !existing && (
            <span className="global-search-destination-path">{destination.downloadPath}</span>
          )}
        </div>
      )}
      <footer className="global-search-footer">
        <span>
          <kbd>↑</kbd>
          <kbd>↓</kbd> Navigate
        </span>
        <span>
          <kbd>↵</kbd> Open / Review
        </span>
        <span>
          <kbd>Esc</kbd> Close
        </span>
      </footer>
    </Autocomplete.Root>
  );
}
