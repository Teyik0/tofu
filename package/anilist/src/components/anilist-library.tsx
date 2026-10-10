import { usePluginHost, useQuery } from "@tofu/plugins/client";
import type {
  AniListEntry,
  AniListSeason,
  AniListState,
  AutomationState,
} from "@tofu/plugins/domain";
import { ActionTooltip } from "@tofu/ui/action-tooltip";
import { Alert, AlertDescription } from "@tofu/ui/alert";
import { Badge } from "@tofu/ui/badge";
import { Button } from "@tofu/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@tofu/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@tofu/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@tofu/ui/empty";
import { Field, FieldLabel } from "@tofu/ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@tofu/ui/input-group";
import { OptionSelect } from "@tofu/ui/option-select";
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
  ArrowUpDownIcon,
  ChevronDownIcon,
  Grid3x3Icon,
  LayoutGridIcon,
  ListIcon,
  RefreshCwIcon,
  SearchIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";
import { api, coreClient } from "../client-api";
import { request } from "../request";
import { AniListCover } from "./anilist-cover";
import { AniListEpisodeModal } from "./anilist-episode-modal";
import { AniListIcon } from "./anilist-icon";
import { AniListPanel } from "./anilist-panel";
import { aniListStatusLabel, aniListStatusLabels } from "./anilist-status";

type SortValue = "title" | "progress" | "year";
const sortOptions = [
  { label: "Title", value: "title" },
  { label: "Episode progress", value: "progress" },
  { label: "Newest year", value: "year" },
] satisfies { label: string; value: SortValue }[];
type ViewValue = "cards" | "compact" | "list";
const viewOptions = [
  { icon: LayoutGridIcon, label: "Large cards", value: "cards" },
  { icon: Grid3x3Icon, label: "Compact cards", value: "compact" },
  { icon: ListIcon, label: "List", value: "list" },
] satisfies { icon: typeof ListIcon; label: string; value: ViewValue }[];
type ProgressValue = "not-started" | "in-progress" | "caught-up";
interface Filters {
  format: string;
  genres: string[];
  progress: ProgressValue | "any";
  season: AniListSeason | "any";
  tracking: "any" | "automated" | "manual";
  year: string;
}
const noFilters: Filters = {
  format: "any",
  genres: [],
  progress: "any",
  season: "any",
  tracking: "any",
  year: "any",
};
const seasonOptions = [
  { label: "Any", value: "any" },
  { label: "Winter", value: "WINTER" },
  { label: "Spring", value: "SPRING" },
  { label: "Summer", value: "SUMMER" },
  { label: "Fall", value: "FALL" },
] satisfies { label: string; value: Filters["season"] }[];
const trackingOptions = [
  { label: "Any", value: "any" },
  { label: "Has its own automation", value: "automated" },
  { label: "Uses list tracking", value: "manual" },
] satisfies { label: string; value: Filters["tracking"] }[];
const progressOptions = [
  { label: "Any", value: "any" },
  { label: "Not started", value: "not-started" },
  { label: "In progress", value: "in-progress" },
  { label: "Caught up", value: "caught-up" },
] satisfies { label: string; value: Filters["progress"] }[];
const formatLabels: Record<string, string> = {
  MOVIE: "Movie",
  MUSIC: "Music",
  ONA: "ONA",
  OVA: "OVA",
  SPECIAL: "Special",
  TV: "TV Show",
  TV_SHORT: "TV Short",
};
const formatLabel = (format: string) => formatLabels[format] ?? format.replaceAll("_", " ");
function progressOf(entry: AniListEntry): ProgressValue {
  if (entry.progress === 0) {
    return "not-started";
  }
  return entry.episodes !== null && entry.progress >= entry.episodes ? "caught-up" : "in-progress";
}

function AnimeRow({ entry, onOpen }: { entry: AniListEntry; onOpen: () => void }) {
  return (
    <button
      aria-label={`View episodes for ${entry.title}`}
      className="anime-row"
      onClick={onOpen}
      type="button"
    >
      <span className="anime-row-cover">
        <AniListCover src={entry.coverImage} />
      </span>
      <span className="anime-row-title">
        <strong>{entry.title}</strong>
        <small>{entry.genres.slice(0, 3).join(" · ") || "—"}</small>
      </span>
      <span className="anime-row-meta">
        {entry.format ? formatLabel(entry.format) : "—"} · {entry.seasonYear ?? "—"}
      </span>
      <Badge variant="secondary">{aniListStatusLabel(entry.status)}</Badge>
      <span className="anime-row-progress">
        <span>
          {entry.progress} / {entry.episodes ?? "—"}
        </span>
        <span className="anime-row-track">
          <i
            style={{
              width: `${entry.episodes ? Math.min(100, (entry.progress / entry.episodes) * 100) : 0}%`,
            }}
          />
        </span>
      </span>
      {entry.automationId ? <ZapIcon aria-label="Custom automation" /> : <span />}
    </button>
  );
}

function AnimeCard({ entry, onOpen }: { entry: AniListEntry; onOpen: () => void }) {
  return (
    <button
      aria-label={`View episodes for ${entry.title}`}
      className="anime-card"
      onClick={onOpen}
      type="button"
    >
      <div className="anime-card-cover">
        <AniListCover src={entry.coverImage} />
        <div className="anime-card-overlay">
          <Badge variant="secondary">{aniListStatusLabel(entry.status)}</Badge>
          {entry.automationId ? <ZapIcon aria-label="Custom automation" /> : null}
        </div>
        <span className="anime-card-progress">
          {entry.progress} / {entry.episodes ?? "—"} watched
        </span>
      </div>
      <strong>{entry.title}</strong>
      <span className="anime-card-meta">
        {entry.format ? formatLabel(entry.format) : "—"} · {entry.seasonYear ?? "—"}
      </span>
    </button>
  );
}

export function AniListLibrary() {
  const { dashboard } = usePluginHost();
  const { data: live, error: loadingError } = useQuery(api.api.anilist.get);
  const { data: liveAutomation } = useQuery(coreClient.api.automation.get);
  const [saved, setSaved] = useState<AniListState | null>(null);
  const [automation, setAutomation] = useState<AutomationState | null>(null);
  const state = saved ?? (live && "entries" in live ? live : null);
  const automationState =
    automation ?? (liveAutomation && "plugins" in liveAutomation ? liveAutomation : null);
  const plugin = automationState?.plugins.find((item) => item.id === "anilist");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<SortValue>("title");
  const [filters, setFilters] = useState<Filters>(noFilters);
  const [advanced, setAdvanced] = useState(false);
  const [view, setView] = useState<ViewValue>("cards");
  const update = (patch: Partial<Filters>) => setFilters((previous) => ({ ...previous, ...patch }));
  const [selected, setSelected] = useState<number | null>(null);
  const [settings, setSettings] = useState(false);
  const [target, setTarget] = useState("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reloadAutomation = async () => {
    setAutomation(await request<AutomationState>("/automation", "GET", undefined));
  };
  const action = (task: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    void task()
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Unable to update AniList")
      )
      .finally(() => setBusy(false));
  };
  const canLoad = Boolean(plugin?.enabled && (plugin.hasApiKey || state?.userName));
  const refreshConnection = useEffectEvent(async () => {
    try {
      setSaved(await request<AniListState>("/anilist", "GET", undefined));
      await reloadAutomation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to check AniList connection");
    }
  });
  useEffect(() => {
    if (!state?.authorizationPending || settings) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      await refreshConnection();
      if (active) {
        timer = setTimeout(check, 1000);
      }
    };
    timer = setTimeout(check, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [state?.authorizationPending, settings]);
  useEffect(() => {
    if (!canLoad) {
      return;
    }
    let active = true;
    setBusy(true);
    void request<AniListState>("/anilist/list", "POST", {})
      .then((value) => {
        if (active) {
          setSaved(value);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Unable to load AniList");
        }
      })
      .finally(() => {
        if (active) {
          setBusy(false);
        }
      });
    return () => {
      active = false;
    };
  }, [canLoad]);
  const listed =
    state?.entries.filter((entry) => state.visibleStatuses.includes(entry.status)) ?? [];
  const genres = [...new Set(listed.flatMap((entry) => entry.genres))].sort((a, b) =>
    a.localeCompare(b, "en-US")
  );
  const years = [
    ...new Set(listed.flatMap((entry) => (entry.seasonYear ? [String(entry.seasonYear)] : []))),
  ].sort((a, b) => Number(b) - Number(a));
  const formats = [...new Set(listed.flatMap((entry) => (entry.format ? [entry.format] : [])))];
  const query = search.toLocaleLowerCase("en-US");
  const entries = listed
    .filter(
      (entry) =>
        entry.aliases.some((title) => title.toLocaleLowerCase("en-US").includes(query)) &&
        filters.genres.every((genre) => entry.genres.includes(genre)) &&
        (filters.year === "any" || String(entry.seasonYear) === filters.year) &&
        (filters.season === "any" || entry.season === filters.season) &&
        (filters.format === "any" || entry.format === filters.format) &&
        (filters.tracking === "any" ||
          (filters.tracking === "automated") === (entry.automationId !== null)) &&
        (filters.progress === "any" || progressOf(entry) === filters.progress)
    )
    .toSorted((a, b) =>
      sort === "progress"
        ? b.progress - a.progress || a.title.localeCompare(b.title, "en-US")
        : sort === "year"
          ? (b.seasonYear ?? 0) - (a.seasonYear ?? 0) || a.title.localeCompare(b.title, "en-US")
          : a.title.localeCompare(b.title, "en-US")
    );
  const activeFilters = [
    ...filters.genres.map((genre) => ({
      clear: () => update({ genres: filters.genres.filter((item) => item !== genre) }),
      key: `genre:${genre}`,
      label: genre,
    })),
    ...(filters.year === "any"
      ? []
      : [{ clear: () => update({ year: "any" }), key: "year", label: filters.year }]),
    ...(filters.season === "any"
      ? []
      : [
          {
            clear: () => update({ season: "any" }),
            key: "season",
            label: seasonOptions.find((option) => option.value === filters.season)?.label ?? "",
          },
        ]),
    ...(filters.format === "any"
      ? []
      : [
          {
            clear: () => update({ format: "any" }),
            key: "format",
            label: formatLabel(filters.format),
          },
        ]),
    ...(filters.tracking === "any"
      ? []
      : [
          {
            clear: () => update({ tracking: "any" }),
            key: "tracking",
            label: trackingOptions.find((option) => option.value === filters.tracking)?.label ?? "",
          },
        ]),
    ...(filters.progress === "any"
      ? []
      : [
          {
            clear: () => update({ progress: "any" }),
            key: "progress",
            label: progressOptions.find((option) => option.value === filters.progress)?.label ?? "",
          },
        ]),
  ];
  const selectedEntry = state?.entries.find((entry) => entry.mediaId === selected);
  return (
    <main className="anilist-library">
      <header className="library-topbar anilist-page-header">
        <div className="library-title anilist-page-heading">
          <SidebarToggle className="mobile-sidebar-toggle" />
          <AniListIcon />
          <h1>AniList</h1>
        </div>
        <div className="anilist-header-actions">
          <span className="anilist-account">{state?.connectedUser ?? state?.userName ?? ""}</span>
          <ActionTooltip>
            <Button
              aria-label="Sync list"
              disabled={busy || !canLoad}
              onClick={() =>
                action(async () => {
                  setSaved(await request<AniListState>("/anilist/list", "POST", {}));
                  await reloadAutomation();
                })
              }
              size="icon"
              variant="outline"
            >
              <RefreshCwIcon className={busy ? "motion-safe:animate-spin" : undefined} />
            </Button>
          </ActionTooltip>
          <ActionTooltip>
            <Button
              aria-label="AniList settings"
              onClick={() => setSettings(true)}
              size="icon"
              variant="outline"
            >
              <SettingsIcon />
            </Button>
          </ActionTooltip>
        </div>
      </header>
      <div className="anilist-page-body">
        <div className="anilist-filters">
          <div className="anilist-filter">
            <label htmlFor="anime-search">Search</label>
            <InputGroup className="anilist-search">
              <InputGroupAddon>
                <SearchIcon />
              </InputGroupAddon>
              <InputGroupInput
                aria-label="Search your anime"
                id="anime-search"
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Title or alias"
                value={search}
              />
              {search ? (
                <InputGroupAddon align="inline-end">
                  <InputGroupButton
                    aria-label="Clear search"
                    onClick={() => setSearch("")}
                    size="icon-xs"
                  >
                    <XIcon />
                  </InputGroupButton>
                </InputGroupAddon>
              ) : null}
            </InputGroup>
          </div>
          <div className="anilist-filter">
            <span id="anilist-lists-label">Lists</span>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-labelledby="anilist-lists-label anilist-lists-value"
                    className="anilist-status-filter anilist-filter-trigger"
                    variant="ghost"
                  >
                    <span id="anilist-lists-value">
                      {state
                        ? state.visibleStatuses.length
                          ? state.visibleStatuses.map(aniListStatusLabel).join(", ")
                          : "None"
                        : "Loading…"}
                    </span>
                    <ChevronDownIcon data-icon="inline-end" />
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="w-56">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Show anime from these lists</DropdownMenuLabel>
                  {aniListStatusLabels.map(({ value, label }) => (
                    <DropdownMenuCheckboxItem
                      checked={
                        state?.visibleStatuses.includes(value) ??
                        (value === "CURRENT" || value === "PLANNING")
                      }
                      disabled={busy || !state}
                      key={value}
                      onCheckedChange={(checked) => {
                        if (state) {
                          action(async () => {
                            setSaved(
                              await request<AniListState>("/anilist/preferences", "PUT", {
                                visibleStatuses: checked
                                  ? [...state.visibleStatuses, value]
                                  : state.visibleStatuses.filter((item) => item !== value),
                              })
                            );
                          });
                        }
                      }}
                    >
                      {label}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="anilist-filter">
            <span id="anilist-genres-label">Genres</span>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-labelledby="anilist-genres-label anilist-genres-value"
                    className="anilist-filter-trigger"
                    disabled={!genres.length}
                    variant="ghost"
                  >
                    <span id="anilist-genres-value">
                      {filters.genres.length ? filters.genres.join(", ") : "Any"}
                    </span>
                    <ChevronDownIcon data-icon="inline-end" />
                  </Button>
                }
              />
              <DropdownMenuContent align="start" className="anilist-genre-menu">
                <DropdownMenuGroup>
                  <DropdownMenuLabel>Genres</DropdownMenuLabel>
                  {genres.map((genre) => (
                    <DropdownMenuCheckboxItem
                      checked={filters.genres.includes(genre)}
                      key={genre}
                      onCheckedChange={(checked) =>
                        update({
                          genres: checked
                            ? [...filters.genres, genre]
                            : filters.genres.filter((item) => item !== genre),
                        })
                      }
                    >
                      {genre}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          <div className="anilist-filter">
            <label htmlFor="anilist-year">Year</label>
            <OptionSelect
              className="anilist-filter-trigger"
              disabled={!years.length}
              id="anilist-year"
              onValueChange={(year) => update({ year })}
              options={[
                { label: "Any", value: "any" },
                ...years.map((year) => ({ label: year, value: year })),
              ]}
              value={filters.year}
            />
          </div>
          <div className="anilist-filter">
            <label htmlFor="anilist-season">Season</label>
            <OptionSelect
              className="anilist-filter-trigger"
              disabled={false}
              id="anilist-season"
              onValueChange={(season) => update({ season })}
              options={seasonOptions}
              value={filters.season}
            />
          </div>
          <div className="anilist-filter">
            <label htmlFor="anilist-format">Format</label>
            <OptionSelect
              className="anilist-filter-trigger"
              disabled={!formats.length}
              id="anilist-format"
              onValueChange={(format) => update({ format })}
              options={[
                { label: "Any", value: "any" },
                ...formats.map((format) => ({ label: formatLabel(format), value: format })),
              ]}
              value={filters.format}
            />
          </div>
          <ActionTooltip>
            <Button
              aria-expanded={advanced}
              aria-label="More filters"
              className="anilist-advanced-toggle"
              data-active={advanced || filters.tracking !== "any" || filters.progress !== "any"}
              onClick={() => setAdvanced(!advanced)}
              size="icon"
              variant="ghost"
            >
              <SlidersHorizontalIcon />
            </Button>
          </ActionTooltip>
        </div>
        {advanced ? (
          <div className="anilist-advanced">
            <div className="anilist-filter">
              <label htmlFor="anilist-tracking">Automation</label>
              <OptionSelect
                className="anilist-filter-trigger"
                disabled={false}
                id="anilist-tracking"
                onValueChange={(tracking) => update({ tracking })}
                options={trackingOptions}
                value={filters.tracking}
              />
            </div>
            <div className="anilist-filter">
              <label htmlFor="anilist-progress">Progress</label>
              <OptionSelect
                className="anilist-filter-trigger"
                disabled={false}
                id="anilist-progress"
                onValueChange={(progress) => update({ progress })}
                options={progressOptions}
                value={filters.progress}
              />
            </div>
          </div>
        ) : null}
        <div className="anilist-results-bar">
          <div className="anilist-active-filters">
            {activeFilters.map((filter) => (
              <button
                aria-label={`Remove filter ${filter.label}`}
                className="anilist-filter-chip"
                key={filter.key}
                onClick={filter.clear}
                type="button"
              >
                {filter.label}
                <XIcon aria-hidden="true" />
              </button>
            ))}
            {activeFilters.length > 1 ? (
              <button className="link-button" onClick={() => setFilters(noFilters)} type="button">
                Clear all
              </button>
            ) : null}
            <span className="anilist-title-count">
              {state ? entries.length : "—"} title{entries.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="anilist-view-controls">
            <Select
              items={sortOptions}
              onValueChange={(value) => {
                if (value !== null) {
                  setSort(value);
                }
              }}
              value={sort}
            >
              <SelectTrigger aria-label="Sort anime" className="anilist-sort" size="sm">
                <ArrowUpDownIcon />
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
                <SelectGroup>
                  {sortOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <span aria-hidden="true" className="toolbar-divider" />
            <fieldset aria-label="Layout" className="anilist-views">
              {viewOptions.map((option) => {
                const Glyph = option.icon;
                return (
                  <ActionTooltip key={option.value}>
                    <Button
                      aria-label={option.label}
                      aria-pressed={view === option.value}
                      onClick={() => setView(option.value)}
                      size="icon-sm"
                      variant="ghost"
                    >
                      <Glyph />
                    </Button>
                  </ActionTooltip>
                );
              })}
            </fieldset>
          </div>
        </div>
        {error || loadingError ? (
          <Alert>
            <AlertDescription>{error ?? "Unable to load AniList"}</AlertDescription>
          </Alert>
        ) : null}
        {!state || (busy && !state.entries.length) ? (
          <div aria-label="Loading anime" className="anime-grid" role="status">
            {["first", "second", "third", "fourth", "fifth"].map((placeholder) => (
              <Skeleton className="anime-cover-skeleton" key={placeholder} />
            ))}
          </div>
        ) : entries.length ? (
          <div className="anime-grid" data-view={view}>
            {entries.map((entry) =>
              view === "list" ? (
                <AnimeRow
                  entry={entry}
                  key={entry.mediaId}
                  onOpen={() => setSelected(entry.mediaId)}
                />
              ) : (
                <AnimeCard
                  entry={entry}
                  key={entry.mediaId}
                  onOpen={() => setSelected(entry.mediaId)}
                />
              )
            )}
          </div>
        ) : (
          <Empty className="anilist-empty">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <AniListIcon />
              </EmptyMedia>
              <EmptyTitle>
                {state.entries.length
                  ? "No anime match your filters"
                  : "Bring your AniList into Tofu"}
              </EmptyTitle>
              <EmptyDescription>
                {state.entries.length
                  ? "Try another title, clear a filter, or show more lists."
                  : "Connect your account or enter a public username in Settings. Watching and Plan to Watch appear by default."}
              </EmptyDescription>
            </EmptyHeader>
            {state.entries.length ? null : (
              <Button onClick={() => setSettings(true)}>Connect AniList</Button>
            )}
          </Empty>
        )}
      </div>
      {selectedEntry && automationState ? (
        <AniListEpisodeModal
          automation={automationState}
          close={() => setSelected(null)}
          entry={selectedEntry}
          key={selectedEntry.mediaId}
          onState={setSaved}
          reloadAutomation={reloadAutomation}
        />
      ) : null}
      {settings && automationState ? (
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setSettings(false);
              action(async () => {
                setSaved(await request<AniListState>("/anilist", "GET", undefined));
                await reloadAutomation();
              });
            }
          }}
          open
        >
          <DialogContent className="anilist-settings-dialog">
            <DialogHeader>
              <DialogTitle>AniList settings</DialogTitle>
              <DialogDescription>
                Connect your account and set default tracking preferences. Each anime can override
                them.
              </DialogDescription>
            </DialogHeader>
            {error ? (
              <Alert>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <AniListPanel
              action={action}
              automations={automationState.automations}
              busy={busy}
              destinationField={
                <Field>
                  <FieldLabel htmlFor="anime-default-destination">Default destination</FieldLabel>
                  <OptionSelect
                    disabled={busy}
                    id="anime-default-destination"
                    onValueChange={setTarget}
                    options={dashboard.destinations.map((destination) => ({
                      label: destination.name,
                      value: destination.id,
                    }))}
                    value={target}
                  />
                </Field>
              }
              destinations={dashboard.destinations}
              key={target}
              onRefresh={setSaved}
              plugin={plugin}
              preferences={automationState.preferences}
              reloadPlugins={reloadAutomation}
              target={target}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </main>
  );
}
