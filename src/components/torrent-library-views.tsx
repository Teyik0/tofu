import { DownloadIcon, PlusIcon, SearchIcon, XIcon } from "lucide-react";
import { ActionTooltip } from "./action-tooltip";
import { bytes, duration, percent, ratio, speed, torrentStatusLabel } from "./format";
import { Icon } from "./icon";
import { StatusGlyph } from "./status-glyph";
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
            aria-label="Filter torrents"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter torrents"
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

export function TorrentLibraryTable({ model }: { model: ReturnType<typeof useTorrentLibrary> }) {
  const {
    setModal,
    setSelected,
    pause,
    resume,
    repair,
    filter,
    search,
    pending,
    torrents,
    selectedId,
    add,
    act,
  } = model;
  return (
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
                    <StatusGlyph progress={torrent.progress} size={34} status={torrent.status} />
                    <span className="torrent-copy">
                      <strong title={torrent.name}>{torrent.name}</strong>
                      <small>
                        <span className="status-label" data-status={torrent.status}>
                          {torrentStatusLabel(torrent)}
                        </span>
                        <span>
                          {torrent.progress === 1
                            ? bytes(torrent.length)
                            : `${bytes(torrent.downloaded)} of ${bytes(torrent.length)}`}
                        </span>
                        {torrent.progress !== null &&
                          torrent.progress < 1 &&
                          torrent.eta !== null &&
                          !stopped && <span>{duration(torrent.eta)} left</span>}
                      </small>
                    </span>
                  </button>
                </td>
                <td>
                  <div className="row-progress">
                    <Progress
                      aria-label={`Progress for ${torrent.name}`}
                      value={torrent.progress === null ? null : torrent.progress * 100}
                    />
                    <span className="num">{percent(torrent.progress)}</span>
                  </div>
                </td>
                <td className="num speed" data-direction="down" data-idle={!torrent.downloadSpeed}>
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
