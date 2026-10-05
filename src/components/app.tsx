import { Await, useQuery } from "@teyik0/furin/client";
import { AlertCircleIcon, DownloadIcon, PlusIcon, SearchIcon, XIcon, ZapIcon } from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { version } from "../../package.json";
import { api } from "../client";
import type { TorrentDetail, TorrentSummary } from "../types";
import { ActionTooltip } from "./action-tooltip";
import { request } from "./api";
import { useDashboard } from "./app-shell";
import { Detail } from "./detail";
import { bytes, duration, percent, ratio, speed, statusLabels } from "./format";
import { Icon } from "./icon";
import { SidebarToggle } from "./sidebar-toggle";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./ui/input-group";
import { Progress } from "./ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Skeleton } from "./ui/skeleton";

type Filter = "all" | "downloading" | "seeding" | "paused" | "error";
const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All statuses" },
  { id: "downloading", label: "Downloading" },
  { id: "seeding", label: "Seeding" },
  { id: "paused", label: "Paused" },
  { id: "error", label: "With errors" },
];
const matches = (torrent: TorrentSummary, filter: Filter) =>
  filter === "all" ||
  (filter === "downloading"
    ? ["downloading", "idle", "metadata", "checking"].includes(torrent.status)
    : torrent.status === filter);

export function App({
  initialDetail,
  initialTorrentId,
}: {
  initialDetail: Promise<TorrentDetail | null>;
  initialTorrentId: string | null;
}) {
  useEffect(() => {
    // Live details can replace this deferred snapshot before navigation cancels its stream.
    // Await still receives the original promise and displays errors when the snapshot is used.
    void initialDetail.catch(() => undefined);
  }, [initialDetail]);
  const {
    data,
    activeDestination,
    open: setModal,
    refresh,
    selectedId: currentId,
    setSelected,
  } = useDashboard();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<"added" | "name" | "progress">("added");
  const [pending, setPending] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const torrents = useMemo(
    () =>
      (data?.torrents ?? [])
        .filter(
          (torrent) =>
            (activeDestination === null || torrent.destinationId === activeDestination) &&
            matches(torrent, filter) &&
            torrent.name.toLocaleLowerCase("en-US").includes(search.toLocaleLowerCase("en-US"))
        )
        .sort((a, b) =>
          sort === "name"
            ? a.name.localeCompare(b.name, "en-US")
            : sort === "progress"
              ? b.progress - a.progress
              : b.addedAt - a.addedAt
        ),
    [data, activeDestination, filter, search, sort]
  );
  const selectedId = torrents.find((torrent) => torrent.id === currentId)?.id ?? torrents[0]?.id;
  const destination = data.destinations.find((item) => item.id === activeDestination);
  const add = () => setModal({ destinationId: activeDestination ?? "default", type: "add" });
  const act = useCallback(
    async (path: string, method: string, body: object | undefined) => {
      const key = path.split("/")[2] ?? "bulk";
      setPending((previous) => new Set(previous).add(key));
      setError(null);
      try {
        await request(path, method, body);
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "An error occurred");
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
  return (
    <div className="main">
      <header className="library-topbar">
        <div className="library-title">
          <SidebarToggle className="mobile-sidebar-toggle" />
          <h1>{destination?.name ?? "All torrents"}</h1>
          {destination && (
            <>
              <span aria-hidden="true" className="breadcrumb-divider">
                -
              </span>
              <span className="topbar-path" title={destination.downloadPath}>
                {destination.downloadPath}
              </span>
            </>
          )}
        </div>
        <div className="library-actions">
          <ActionTooltip>
            <Button
              aria-label="Automations"
              onClick={() =>
                setModal({ destinationId: activeDestination ?? "default", type: "automation" })
              }
              size="icon"
              variant="outline"
            >
              <ZapIcon />
            </Button>
          </ActionTooltip>
          <ActionTooltip>
            <Button aria-label="Add a torrent" className="add-button" onClick={add} size="icon">
              <PlusIcon />
            </Button>
          </ActionTooltip>
        </div>
      </header>
      {error !== null && (
        <Alert className="connection-banner">
          <AlertCircleIcon />
          <AlertDescription>
            {error}
            <ActionTooltip>
              <Button
                aria-label="Dismiss error"
                onClick={() => setError(null)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Icon name="x" />
              </Button>
            </ActionTooltip>
          </AlertDescription>
        </Alert>
      )}
      <section aria-label="Torrent list" className="library">
        <div className="library-toolbar">
          <span className="library-count">
            {torrents.length} torrent{torrents.length === 1 ? "" : "s"}
          </span>
          <div className="toolbar-controls">
            <InputGroup className="torrent-search">
              <InputGroupInput
                aria-label="Search torrents"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search torrents"
                type="search"
                value={search}
              />
              <InputGroupAddon align="inline-start">
                <SearchIcon />
              </InputGroupAddon>
              {search.length > 0 && (
                <InputGroupAddon align="inline-end">
                  <ActionTooltip>
                    <InputGroupButton
                      aria-label="Clear search"
                      onClick={() => setSearch("")}
                      size="icon-xs"
                    >
                      <XIcon />
                    </InputGroupButton>
                  </ActionTooltip>
                </InputGroupAddon>
              )}
            </InputGroup>
            <Select
              items={filters.map((item) => ({ label: item.label, value: item.id }))}
              onValueChange={(value) => {
                if (value !== null) {
                  setFilter(value);
                }
              }}
              value={filter}
            >
              <SelectTrigger aria-label="Filter torrents by status" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  {filters.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <ActionTooltip>
              <Button
                aria-label="Pause all"
                disabled={pending.has("bulk") || !torrents.length}
                onClick={() =>
                  void act("/bulk", "POST", {
                    action: "pause",
                    ids: torrents.map((torrent) => torrent.id),
                  })
                }
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Icon name="pause" size={17} />
              </Button>
            </ActionTooltip>
            <ActionTooltip>
              <Button
                aria-label="Resume all"
                disabled={pending.has("bulk") || !torrents.length}
                onClick={() =>
                  void act("/bulk", "POST", {
                    action: "resume",
                    ids: torrents.map((torrent) => torrent.id),
                  })
                }
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Icon name="play" size={17} />
              </Button>
            </ActionTooltip>
            <Select
              items={[
                { label: "Newest first", value: "added" },
                { label: "Name", value: "name" },
                { label: "Progress", value: "progress" },
              ]}
              onValueChange={(value) => {
                if (value !== null) {
                  setSort(value as typeof sort);
                }
              }}
              value={sort}
            >
              <SelectTrigger aria-label="Sort torrents" size="sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  <SelectItem value="added">Newest first</SelectItem>
                  <SelectItem value="name">Name</SelectItem>
                  <SelectItem value="progress">Progress</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="table-scroll torrent-scroll">
          <table className="torrent-table">
            <thead>
              <tr>
                <th className="name-col">Torrent name</th>
                <th>Size</th>
                <th className="progress-col">Progress</th>
                <th>Download</th>
                <th>Upload</th>
                <th>Peers</th>
                <th>Ratio</th>
                <th>Remaining</th>
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {torrents.map((torrent) => (
                <tr className={selectedId === torrent.id ? "selected" : ""} key={torrent.id}>
                  <td>
                    <button
                      aria-pressed={selectedId === torrent.id}
                      className="torrent-select"
                      onClick={() => setSelected(torrent.id)}
                      type="button"
                    >
                      <span className={`torrent-icon ${torrent.status}`}>
                        <Icon
                          name={
                            torrent.status === "paused"
                              ? "pause"
                              : torrent.progress === 1
                                ? "check"
                                : "download"
                          }
                          size={18}
                        />
                      </span>
                      <span>
                        <strong title={torrent.name}>{torrent.name}</strong>
                        <small className={torrent.status}>{statusLabels[torrent.status]}</small>
                      </span>
                    </button>
                  </td>
                  <td className="mono">{bytes(torrent.length)}</td>
                  <td>
                    <div className="row-progress">
                      <Progress
                        aria-label={`Progress for ${torrent.name}`}
                        value={torrent.progress * 100}
                      />
                      <span className="mono">{percent(torrent.progress)}</span>
                    </div>
                  </td>
                  <td className={`mono ${torrent.downloadSpeed ? "speed-active" : ""}`}>
                    {speed(torrent.downloadSpeed)}
                  </td>
                  <td className="mono">{speed(torrent.uploadSpeed)}</td>
                  <td className="mono">{torrent.peers}</td>
                  <td className="mono">{ratio(torrent.ratio)}</td>
                  <td className="mono">{torrent.progress === 1 ? "—" : duration(torrent.eta)}</td>
                  <td>
                    <ActionTooltip>
                      <Button
                        aria-label={`${torrent.status === "paused" || torrent.status === "error" ? "Resume" : "Pause"} ${torrent.name}`}
                        disabled={pending.has(torrent.id)}
                        onClick={() =>
                          void act(
                            `/torrents/${torrent.id}/${torrent.status === "paused" || torrent.status === "error" ? "resume" : "pause"}`,
                            "POST",
                            undefined
                          )
                        }
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <Icon
                          name={
                            torrent.status === "paused" || torrent.status === "error"
                              ? "play"
                              : "pause"
                          }
                          size={16}
                        />
                      </Button>
                    </ActionTooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!torrents.length && (
            <Empty className="empty-state">
              <EmptyHeader>
                <EmptyMedia variant="icon">{search ? <SearchIcon /> : <DownloadIcon />}</EmptyMedia>
                <EmptyTitle>
                  {data
                    ? search || filter !== "all"
                      ? "No torrents here"
                      : "Your next download starts here."
                    : "Preparing your workspace…"}
                </EmptyTitle>
                <EmptyDescription>
                  {search || filter !== "all"
                    ? "Try another filter or search."
                    : "Add a magnet link or a .torrent file. Tofu takes care of the rest."}
                </EmptyDescription>
              </EmptyHeader>
              {data !== null && !search && filter === "all" && (
                <EmptyContent>
                  <Button onClick={add} variant="outline">
                    <PlusIcon data-icon="inline-start" />
                    Add my first torrent
                  </Button>
                </EmptyContent>
              )}
            </Empty>
          )}
        </div>
        <div className="library-bottom">
          <span>
            {torrents.length} torrent{torrents.length === 1 ? "" : "s"}
          </span>
          <span>
            Select a torrent to view its details <Icon name="chevron" size={13} />
          </span>
        </div>
      </section>
      {selectedId && torrents.some((torrent) => torrent.id === selectedId) && (
        <Suspense fallback={<DetailLoading />}>
          <SelectedDetail
            act={act}
            busy={pending.has(selectedId)}
            id={selectedId}
            initial={selectedId === initialTorrentId ? initialDetail : null}
          />
        </Suspense>
      )}
      <footer className="status-bar">
        <span>
          <i />
          Engine connected
        </span>
        <span>DHT: {data?.session.dhtNodes ?? 0} nodes</span>
        <span>Port: {data?.session.port ?? "—"}</span>
        <span className="status-version">
          Tofu {version} <span>·</span>{" "}
          {data?.session.mode === "desktop" ? "Native app" : "Web workspace"}
        </span>
      </footer>
    </div>
  );
}

function DetailLoading() {
  return (
    <section aria-busy="true" aria-label="Loading details" className="detail-pane detail-loading">
      <Skeleton className="h-5 w-64" />
      <Skeleton className="h-32 w-full" />
    </section>
  );
}

function SelectedDetail({
  id,
  initial,
  act,
  busy,
}: {
  id: string;
  initial: Promise<TorrentDetail | null> | null;
  act: (path: string, method: string, body: object | undefined) => Promise<void>;
  busy: boolean;
}) {
  const { data, open } = useDashboard();
  const { data: live, error } = useQuery(api.api.torrents({ id }).get);
  const summary = data.torrents.find((item) => item.id === id);
  const cached = live && "id" in live ? live : null;
  const torrent = useMemo(
    () => (cached && summary ? { ...cached, ...summary } : null),
    [cached, summary]
  );
  if (error || (live && !("id" in live))) {
    return (
      <Alert className="connection-banner">
        <AlertCircleIcon />
        <AlertDescription>Unable to load details. Retrying on the next update.</AlertDescription>
      </Alert>
    );
  }
  if (torrent) {
    return <Detail act={act} busy={busy} data={data} open={open} torrent={torrent} />;
  }
  return initial ? (
    <Await resolve={initial}>
      {(snapshot) =>
        snapshot && summary ? (
          <Detail
            act={act}
            busy={busy}
            data={data}
            open={open}
            torrent={{ ...snapshot, ...summary }}
          />
        ) : (
          <DetailLoading />
        )
      }
    </Await>
  ) : (
    <DetailLoading />
  );
}
