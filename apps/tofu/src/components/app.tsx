import { Await, useQuery } from "@teyik0/furin/client";
import { ActionTooltip } from "@tofu/ui/action-tooltip";
import { Alert, AlertDescription } from "@tofu/ui/alert";
import { Button } from "@tofu/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@tofu/ui/empty";
import { bytes, duration, percent, ratio, speed, statusLabels } from "@tofu/ui/format";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@tofu/ui/input-group";
import { Progress } from "@tofu/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@tofu/ui/select";
import { SidebarToggle } from "@tofu/ui/sidebar-toggle";
import { Skeleton } from "@tofu/ui/skeleton";
import {
  AlertCircleIcon,
  DownloadIcon,
  LayersIcon,
  PlusIcon,
  SearchIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { version } from "../../package.json";
import { api } from "../client";
import type { TorrentDetail, TorrentSummary } from "../types";
import { request } from "./api";
import { useDashboard } from "./app-shell";
import type { AutomationSection } from "./automation-center";
import { DestinationIcon } from "./destination-icon";
import { Detail } from "./detail";
import { Icon } from "./icon";
import { PluginThreadActions } from "./plugin-contributions";
import { StatusGlyph } from "./status-glyph";

type Filter = "all" | "downloading" | "seeding" | "paused" | "error";
const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "All statuses" },
  { id: "downloading", label: "Downloading" },
  { id: "seeding", label: "Seeding" },
  { id: "paused", label: "Paused" },
  { id: "error", label: "With errors" },
];
const statusFilters = filters.filter(
  (item): item is { id: Exclude<Filter, "all">; label: string } => item.id !== "all"
);
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
  const scoped = useMemo(
    () =>
      (data?.torrents ?? []).filter(
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
              ? b.progress - a.progress
              : b.addedAt - a.addedAt
        ),
    [scoped, filter, search, sort]
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
          <span aria-hidden="true" className="library-glyph">
            {destination ? <DestinationIcon name={destination.icon} /> : <LayersIcon />}
          </span>
          <div className="library-heading">
            <h1>{destination?.name ?? "All torrents"}</h1>
            <span className="topbar-path" title={destination?.downloadPath ?? "Every destination"}>
              {destination?.downloadPath ?? "Every destination"}
            </span>
          </div>
        </div>
        <div className="library-actions">
          {destination && (
            <PluginThreadActions
              context={{
                dashboard: data,
                settings: data.settings,
                thread: destination,
                torrents: scoped,
              }}
            />
          )}
          <AutomationsButton
            open={(section) =>
              setModal({
                destinationId: activeDestination ?? "default",
                section,
                type: "automation",
              })
            }
          />
          <Button className="add-button" onClick={add}>
            <PlusIcon data-icon="inline-start" />
            Add a torrent
          </Button>
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
          <fieldset aria-label="Torrents by status" className="status-chips">
            <button
              aria-pressed={filter === "all"}
              className="status-chip"
              onClick={() => setFilter("all")}
              type="button"
            >
              All <b>{scoped.length}</b>
            </button>
            {statusFilters
              .filter((item) => counts[item.id] > 0 || filter === item.id)
              .map((item) => (
                <button
                  aria-pressed={filter === item.id}
                  className="status-chip"
                  data-status={item.id}
                  key={item.id}
                  onClick={() => setFilter(filter === item.id ? "all" : item.id)}
                  type="button"
                >
                  <i aria-hidden="true" />
                  {item.label} <b>{counts[item.id]}</b>
                </button>
              ))}
          </fieldset>
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
            <span aria-hidden="true" className="toolbar-divider" />
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
                <Icon name="pause" size={16} />
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
                <Icon name="play" size={16} />
              </Button>
            </ActionTooltip>
          </div>
        </div>
        <div className="table-scroll torrent-scroll">
          <table className="torrent-table">
            <thead>
              <tr>
                <th className="name-col">Name</th>
                <th className="progress-col">Progress</th>
                <th className="num">Download</th>
                <th className="num">Upload</th>
                <th className="num">Peers</th>
                <th className="num">Ratio</th>
                <th className="action-col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {torrents.map((torrent) => {
                const stopped = torrent.status === "paused" || torrent.status === "error";
                return (
                  <tr
                    className={selectedId === torrent.id ? "selected" : ""}
                    data-status={torrent.status}
                    key={torrent.id}
                  >
                    <td>
                      <button
                        aria-pressed={selectedId === torrent.id}
                        className="torrent-select"
                        onClick={() => setSelected(torrent.id)}
                        type="button"
                      >
                        <StatusGlyph
                          progress={torrent.progress}
                          size={34}
                          status={torrent.status}
                        />
                        <span className="torrent-copy">
                          <strong title={torrent.name}>{torrent.name}</strong>
                          <small>
                            <span className="status-label" data-status={torrent.status}>
                              {statusLabels[torrent.status]}
                            </span>
                            <span>
                              {torrent.progress === 1
                                ? bytes(torrent.length)
                                : `${bytes(torrent.downloaded)} of ${bytes(torrent.length)}`}
                            </span>
                            {torrent.progress < 1 && torrent.eta !== null && !stopped && (
                              <span>{duration(torrent.eta)} left</span>
                            )}
                          </small>
                        </span>
                      </button>
                    </td>
                    <td>
                      <div className="row-progress">
                        <Progress
                          aria-label={`Progress for ${torrent.name}`}
                          value={torrent.progress * 100}
                        />
                        <span className="num">{percent(torrent.progress)}</span>
                      </div>
                    </td>
                    <td
                      className="num speed"
                      data-direction="down"
                      data-idle={!torrent.downloadSpeed}
                    >
                      {speed(torrent.downloadSpeed)}
                    </td>
                    <td className="num speed" data-direction="up" data-idle={!torrent.uploadSpeed}>
                      {speed(torrent.uploadSpeed)}
                    </td>
                    <td className="num">{torrent.peers}</td>
                    <td className="num">{ratio(torrent.ratio)}</td>
                    <td className="action-col">
                      <div className="row-actions">
                        <ActionTooltip>
                          <Button
                            aria-label={`${stopped ? "Resume" : "Pause"} ${torrent.name}`}
                            className="row-action"
                            disabled={pending.has(torrent.id)}
                            onClick={() =>
                              void act(
                                `/torrents/${torrent.id}/${stopped ? "resume" : "pause"}`,
                                "POST",
                                undefined
                              )
                            }
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <Icon name={stopped ? "play" : "pause"} size={15} />
                          </Button>
                        </ActionTooltip>
                        <ActionTooltip>
                          <Button
                            aria-label={`Remove ${torrent.name}`}
                            className="row-action row-remove"
                            onClick={() => setModal({ torrent, type: "remove" })}
                            size="icon-sm"
                            type="button"
                            variant="ghost"
                          >
                            <Icon name="trash" size={15} />
                          </Button>
                        </ActionTooltip>
                      </div>
                    </td>
                  </tr>
                );
              })}
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
        <span className="status-port">
          Port <b>{data?.session.port ?? "—"}</b>
        </span>
        <span className="status-throughput">
          <span data-direction="down">
            <Icon name="download" size={12} />
            {speed(data?.session.downloadSpeed ?? 0)}
          </span>
          <span data-direction="up">
            <Icon name="upload" size={12} />
            {speed(data?.session.uploadSpeed ?? 0)}
          </span>
        </span>
        <span className="status-version">
          Tofu {version} <span>·</span>{" "}
          {data?.session.mode === "desktop" ? "Native app" : "Web workspace"}
        </span>
      </footer>
    </div>
  );
}

/** Opens the automation Inbox directly when releases are waiting for a decision. */
function AutomationsButton({ open }: { open: (section: AutomationSection) => void }) {
  const { data } = useQuery(api.api.automation.get);
  const waiting =
    data && "decisions" in data
      ? data.decisions.filter(
          (decision) => decision.status === "review" || decision.status === "error"
        ).length
      : 0;
  return (
    <ActionTooltip>
      <Button
        aria-describedby={waiting ? "automation-attention" : undefined}
        aria-label="Automations"
        className="automations-button"
        onClick={() => open(waiting ? "inbox" : "rules")}
        size="icon"
        variant="outline"
      >
        <ZapIcon />
        {waiting ? (
          <span aria-hidden="true" className="automations-count">
            {waiting}
          </span>
        ) : null}
        {waiting ? (
          <span className="sr-only" id="automation-attention">
            {waiting} release{waiting === 1 ? "" : "s"} need your decision
          </span>
        ) : null}
      </Button>
    </ActionTooltip>
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
