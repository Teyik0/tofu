import { cn } from "cn";
import { DownloadIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { ActionTooltip } from "../../../../package/ui/src/action-tooltip";
import { bytes, percent, speed, torrentStatusLabel } from "../../../../package/ui/src/format";
import { Button } from "../../../../package/ui/src/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../../../package/ui/src/ui/empty";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../../../../package/ui/src/ui/input-group";
import { Progress } from "../../../../package/ui/src/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../../package/ui/src/ui/select";
import { ToggleGroup, ToggleGroupItem } from "../../../../package/ui/src/ui/toggle-group";
import { showTorrent } from "../lib/navigation";
import { Icon } from "./icon";
import { StatusGlyph } from "./status-glyph";
import { filters, statusFilters, type useTorrentLibrary } from "./use-torrent-library";

export function TorrentLibraryToolbar({ model }: { model: ReturnType<typeof useTorrentLibrary> }) {
  const {
    bulk,
    filter,
    setFilter,
    search,
    setSearch,
    sort,
    setSort,
    pending,
    scoped,
    counts,
    torrents,
    act,
  } = model;
  return (
    <div className="library-toolbar">
      <ToggleGroup
        aria-label="Torrents by status"
        className="status-chips"
        onValueChange={(values) => setFilter((values[0] as typeof filter | undefined) ?? "all")}
        size="sm"
        value={[filter]}
      >
        <ToggleGroupItem className="status-chip" value="all">
          All <b>{scoped.length}</b>
        </ToggleGroupItem>
        {statusFilters
          .filter((item) => counts[item.id] > 0 || filter === item.id)
          .map((item) => (
            <ToggleGroupItem
              className="status-chip"
              data-status={item.id}
              key={item.id}
              value={item.id}
            >
              <i aria-hidden="true" />
              {item.label} <b>{counts[item.id]}</b>
            </ToggleGroupItem>
          ))}
      </ToggleGroup>
      <div className="toolbar-controls">
        <InputGroup className="torrent-search">
          <InputGroupInput
            aria-label="Filter torrents or paths"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter torrents or paths"
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
              void act("bulk", () =>
                bulk.mutateAsync({
                  action: "pause",
                  ids: torrents.map((torrent) => torrent.id),
                })
              )
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
              void act("bulk", () =>
                bulk.mutateAsync({
                  action: "resume",
                  ids: torrents.map((torrent) => torrent.id),
                })
              )
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
  );
}

export function TorrentLibraryList({ model }: { model: ReturnType<typeof useTorrentLibrary> }) {
  const {
    setModal,
    router,
    activeDestination,
    destinations,
    pause,
    resume,
    repair,
    filter,
    search,
    pending,
    torrents,
    selectedId,
    serverId,
    add,
    act,
  } = model;
  const listRef = useRef<HTMLUListElement>(null);
  const selectedIndex = torrents.findIndex((torrent) => torrent.id === selectedId);
  useEffect(() => {
    const list = listRef.current;
    const selected = list?.children.item(selectedIndex);
    if (!(list && selected instanceof HTMLElement)) {
      return;
    }
    if (selected.offsetTop < list.scrollTop) {
      list.scrollTop = selected.offsetTop;
    } else if (selected.offsetTop + selected.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = selected.offsetTop + selected.offsetHeight - list.clientHeight;
    }
  }, [selectedIndex]);
  return (
    <div className="torrent-scroll">
      <ul aria-label="Torrents" className="torrent-list" ref={listRef}>
        {torrents.map((torrent) => {
          const stopped = torrent.status === "paused" || torrent.status === "error";
          const destination = destinations.find((item) => item.id === torrent.destinationId);
          const outbound = torrent.status === "seeding";
          const transferSpeed = outbound ? torrent.uploadSpeed : torrent.downloadSpeed;
          return (
            <li
              className={cn("torrent-row", selectedId === torrent.id && "selected")}
              data-status={torrent.status}
              key={torrent.id}
            >
              <button
                aria-pressed={selectedId === torrent.id}
                className="torrent-select"
                onClick={() => void showTorrent(router, serverId, activeDestination, torrent.id)}
                type="button"
              >
                <StatusGlyph progress={torrent.progress} size={34} status={torrent.status} />
                <div className="torrent-copy">
                  <span className="torrent-row-heading">
                    <strong title={torrent.name}>{torrent.name}</strong>
                    <span className="status-label" data-status={torrent.status}>
                      {torrentStatusLabel(torrent)}
                    </span>
                  </span>
                  <span className="torrent-row-meta">
                    <span className="torrent-location" title={destination?.name}>
                      {activeDestination === null
                        ? (destination?.name ?? "—")
                        : torrent.downloaded === null
                          ? bytes(torrent.length)
                          : `${bytes(torrent.downloaded)} of ${bytes(torrent.length)}`}
                    </span>
                    <span className="num">
                      {percent(torrent.progress)} · {bytes(torrent.length)}
                    </span>
                    <span
                      className="num speed torrent-rate"
                      data-direction={outbound ? "up" : "down"}
                      data-idle={!transferSpeed}
                    >
                      {outbound ? "↑" : "↓"} {speed(transferSpeed)}
                    </span>
                  </span>
                  <Progress
                    aria-label={`Progress for ${torrent.name}`}
                    className="torrent-row-progress"
                    value={torrent.progress === null ? null : torrent.progress * 100}
                  />
                </div>
              </button>
              <div className="row-actions">
                <ActionTooltip>
                  <Button
                    aria-label={`${torrent.storageIssue ? "Repair download" : stopped ? "Resume" : "Pause"} ${torrent.name}`}
                    className="row-action"
                    disabled={pending.has(torrent.id)}
                    onClick={() =>
                      void act(torrent.id, () =>
                        torrent.storageIssue
                          ? repair.mutateAsync(torrent.id)
                          : stopped
                            ? resume.mutateAsync(torrent.id)
                            : pause.mutateAsync(torrent.id)
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
            </li>
          );
        })}
      </ul>
      {!torrents.length && (
        <Empty className="empty-state">
          <EmptyHeader>
            <EmptyMedia variant="icon">{search ? <SearchIcon /> : <DownloadIcon />}</EmptyMedia>
            <EmptyTitle>
              {search || filter !== "all" ? "No torrents here" : "Your next download starts here."}
            </EmptyTitle>
            <EmptyDescription>
              {search || filter !== "all"
                ? "Try another filter or search."
                : "Add a magnet link or a .torrent file. Tofu takes care of the rest."}
            </EmptyDescription>
          </EmptyHeader>
          {!search && filter === "all" && (
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
  );
}
