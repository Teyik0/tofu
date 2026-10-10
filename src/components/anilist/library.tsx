import { getRouteApi, useMutation } from "@teyik0/furin/client";
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
import { api } from "../../lib/client";
import { useRefresh } from "../../lib/navigation";
import type {
  AniListCatalog,
  AniListCatalogFilters,
  AniListCatalogOptions,
  AniListCatalogSort,
  AniListEntry,
  AniListMedia,
  AniListSeason,
} from "../../types";
import { ActionTooltip } from "../action-tooltip";
import { request } from "../api";
import { OptionSelect } from "../option-select";
import { SidebarToggle } from "../sidebar-toggle";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Field, FieldLabel } from "../ui/field";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../ui/hover-card";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "../ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import {
  airingOptions,
  BrowseAdvancedFilters,
  type BrowseFilters,
  browseRequest,
  catalogSortOptions,
  compareBrowseMedia,
  countryOptions,
  GenreTagFilter,
  matchesBrowseFilters,
  noBrowseFilters,
  sourceOptions,
} from "./browse-filters";
import { AniListCover } from "./cover";
import { AniListEpisodeModal } from "./episode-modal";
import { AniListIcon } from "./icon";
import { AniListMediaInfo, animeAiringLabel } from "./media-info";
import { AniListPanel } from "./panel";
import { aniListStatusLabel, aniListStatusLabels } from "./status";

type SortValue = AniListCatalogSort | "progress" | "year";
const sortOptions = [
  ...catalogSortOptions,
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
interface Filters extends BrowseFilters {
  format: string;
  genres: string[];
  progress: ProgressValue | "any";
  season: AniListSeason | "any";
  tracking: "any" | "automated" | "manual";
  year: string;
}
const noFilters: Filters = {
  ...noBrowseFilters,
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

function AnimeRow({
  entry,
  onOpen,
  now,
}: {
  entry: AniListMedia | AniListEntry;
  onOpen: () => void;
  now: number;
}) {
  return (
    <button
      aria-label={
        "progress" in entry ? `View episodes for ${entry.title}` : `Open ${entry.title} on AniList`
      }
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
      {"status" in entry ? (
        <Badge variant="secondary">{aniListStatusLabel(entry.status)}</Badge>
      ) : (
        <span>{animeAiringLabel(entry, now)}</span>
      )}
      {"progress" in entry ? (
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
      ) : (
        <span>
          {entry.averageScore === null || entry.averageScore === undefined
            ? "—"
            : `${entry.averageScore}%`}
        </span>
      )}
      {"automationId" in entry && entry.automationId ? (
        <ZapIcon aria-label="Custom automation" />
      ) : (
        <span />
      )}
    </button>
  );
}

function AnimeCard({
  entry,
  onOpen,
  now,
}: {
  entry: AniListMedia | AniListEntry;
  onOpen: () => void;
  now: number;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger
        delay={250}
        render={
          <button
            aria-label={
              "progress" in entry
                ? `View episodes for ${entry.title}`
                : `Open ${entry.title} on AniList`
            }
            className="anime-card"
            onClick={onOpen}
            type="button"
          />
        }
      >
        <div className="anime-card-cover">
          <AniListCover src={entry.coverImage} />
          <div className="anime-card-overlay">
            {"status" in entry ? (
              <Badge variant="secondary">{aniListStatusLabel(entry.status)}</Badge>
            ) : null}
            {"automationId" in entry && entry.automationId ? (
              <ZapIcon aria-label="Custom automation" />
            ) : null}
          </div>
          {"progress" in entry ? (
            <span className="anime-card-progress">
              {entry.progress} / {entry.episodes ?? "—"} watched
            </span>
          ) : (
            <span className="anime-card-progress">{animeAiringLabel(entry, now)}</span>
          )}
        </div>
        <strong>{entry.title}</strong>
        <span className="anime-card-meta">
          {entry.format ? formatLabel(entry.format) : "—"} · {entry.seasonYear ?? "—"}
        </span>
      </HoverCardTrigger>
      <HoverCardContent align="start" className="anime-preview-popup" side="right" sideOffset={12}>
        <AniListMediaInfo media={entry} now={now} />
      </HoverCardContent>
    </HoverCard>
  );
}

export const AniListLibrary = () => {
  const {
    dashboard,
    initialAniList: state,
    initialAutomation: automationState,
  } = getRouteApi("/anilist").useLoaderData();
  const refresh = useRefresh();
  const loadList = useMutation(api.anilist.list.post);
  const openAnime = useMutation(api.anilist.open.post);
  const savePreferences = useMutation(api.anilist.preferences.put);
  const plugin = automationState?.plugins.find((item) => item.id === "anilist");
  const [search, setSearch] = useState("");
  const [listSort, setListSort] = useState<SortValue>("title");
  const [catalogSort, setCatalogSort] = useState<AniListCatalogSort>("trending");
  const browsing = state.visibleStatuses.length === 0;
  const sort = browsing ? catalogSort : listSort;
  const setSort = (value: SortValue) => {
    if (value !== "progress" && value !== "year" && browsing) {
      setCatalogSort(value);
    } else {
      setListSort(value);
    }
  };
  const availableSorts = browsing ? catalogSortOptions : sortOptions;
  const [catalogReload, setCatalogReload] = useState(0);
  const [catalog, setCatalog] = useState<{ key: string; data: AniListCatalog } | null>(null);
  const [catalogError, setCatalogError] = useState<{ key: string; message: string } | null>(null);
  const [catalogOptions, setCatalogOptions] = useState<AniListCatalogOptions | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    void request<AniListCatalogOptions>(
      "/anilist/catalog/options",
      "GET",
      undefined,
      controller.signal
    )
      .then(setCatalogOptions)
      .catch(() => undefined);
    return () => controller.abort();
  }, []);
  const [filters, setFilters] = useState<Filters>(noFilters);
  const catalogBody = JSON.stringify({
    ...browseRequest(filters),
    format: filters.format === "any" ? undefined : filters.format,
    genres: filters.genres,
    search,
    season: filters.season === "any" ? undefined : filters.season,
    sort: catalogSort,
    year: filters.year === "any" ? undefined : Number(filters.year),
  } satisfies AniListCatalogFilters);
  const catalogKey = `${catalogReload}:${catalogBody}`;
  const currentCatalog = catalog?.key === catalogKey ? catalog.data : null;
  const currentCatalogError =
    browsing && catalogError?.key === catalogKey ? catalogError.message : null;
  const loadingCatalog = browsing && !currentCatalog && !currentCatalogError;
  useEffect(() => {
    if (!browsing) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void request<AniListCatalog>(
        "/anilist/catalog",
        "POST",
        JSON.parse(catalogBody) as AniListCatalogFilters,
        controller.signal
      )
        .then((data) => {
          if (!controller.signal.aborted) {
            setCatalog({ data, key: catalogKey });
            setCatalogError(null);
          }
        })
        .catch((cause) => {
          if (!controller.signal.aborted) {
            setCatalogError({
              key: catalogKey,
              message: cause instanceof Error ? cause.message : "Unable to load anime catalog",
            });
          }
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [browsing, catalogKey, catalogBody]);
  const [advanced, setAdvanced] = useState(false);
  const [view, setView] = useState<ViewValue>("cards");
  const update = (patch: Partial<Filters>) => setFilters((previous) => ({ ...previous, ...patch }));
  const [selected, setSelected] = useState<number | null>(null);
  const [settings, setSettings] = useState(false);
  const [target, setTarget] = useState("default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      await refresh();
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
  const listed =
    state?.entries.filter((entry) => state.visibleStatuses.includes(entry.status)) ?? [];
  const genres = [
    ...new Set([
      ...(catalogOptions?.genres ?? []),
      ...state.entries.flatMap((entry) => entry.genres),
    ]),
  ].sort((a, b) => a.localeCompare(b, "en-US"));
  const years = Array.from({ length: new Date(now).getFullYear() + 2 - 1940 + 1 }, (_, index) =>
    String(new Date(now).getFullYear() + 2 - index)
  );
  const formats = Object.keys(formatLabels);
  const query = search.toLocaleLowerCase("en-US");
  const libraryEntries = listed
    .filter(
      (entry) =>
        entry.aliases.some((title) => title.toLocaleLowerCase("en-US").includes(query)) &&
        filters.genres.every((genre) => entry.genres.includes(genre)) &&
        (filters.year === "any" || String(entry.seasonYear) === filters.year) &&
        (filters.season === "any" || entry.season === filters.season) &&
        (filters.format === "any" || entry.format === filters.format) &&
        (filters.tracking === "any" ||
          (filters.tracking === "automated") === (entry.automationId !== null)) &&
        (filters.progress === "any" || progressOf(entry) === filters.progress) &&
        matchesBrowseFilters(entry, filters)
    )
    .toSorted((a, b) =>
      sort === "progress"
        ? b.progress - a.progress || a.title.localeCompare(b.title, "en-US")
        : sort === "year"
          ? (b.seasonYear ?? 0) - (a.seasonYear ?? 0) || a.title.localeCompare(b.title, "en-US")
          : compareBrowseMedia(a, b, sort)
    );
  const entries: (AniListEntry | AniListMedia)[] = browsing
    ? (currentCatalog?.media ?? [])
    : libraryEntries;
  const activeFilters = [
    ...filters.tags.map((tag) => ({
      clear: () => update({ tags: filters.tags.filter((item) => item !== tag) }),
      key: `tag:${tag}`,
      label: tag,
    })),
    ...filters.excludedGenres.map((genre) => ({
      clear: () =>
        update({ excludedGenres: filters.excludedGenres.filter((item) => item !== genre) }),
      key: `excluded-genre:${genre}`,
      label: `Exclude ${genre}`,
    })),
    ...filters.excludedTags.map((tag) => ({
      clear: () => update({ excludedTags: filters.excludedTags.filter((item) => item !== tag) }),
      key: `excluded-tag:${tag}`,
      label: `Exclude ${tag}`,
    })),
    ...[
      { key: "airingStatus", options: airingOptions },
      { key: "countryOfOrigin", options: countryOptions },
      { key: "source", options: sourceOptions },
      {
        key: "streamingOn",
        options:
          catalogOptions?.streaming.map((site) => ({ label: site.name, value: String(site.id) })) ??
          [],
      },
    ].flatMap((field) => {
      const key = field.key as "airingStatus" | "countryOfOrigin" | "source" | "streamingOn";
      return filters[key] === "any"
        ? []
        : [
            {
              clear: () => update({ [key]: "any" }),
              key,
              label:
                field.options.find((option) => option.value === filters[key])?.label ??
                filters[key],
            },
          ];
    }),
    ...[
      { key: "yearMin", label: "Year ≥" },
      { key: "yearMax", label: "Year ≤" },
      { key: "episodesMin", label: "Episodes ≥" },
      { key: "episodesMax", label: "Episodes ≤" },
      { key: "durationMin", label: "Minutes ≥" },
      { key: "durationMax", label: "Minutes ≤" },
    ].flatMap((field) => {
      const key = field.key as
        | "yearMin"
        | "yearMax"
        | "episodesMin"
        | "episodesMax"
        | "durationMin"
        | "durationMax";
      return filters[key]
        ? [{ clear: () => update({ [key]: "" }), key, label: `${field.label} ${filters[key]}` }]
        : [];
    }),
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
    ...(browsing || filters.tracking === "any"
      ? []
      : [
          {
            clear: () => update({ tracking: "any" }),
            key: "tracking",
            label: trackingOptions.find((option) => option.value === filters.tracking)?.label ?? "",
          },
        ]),
    ...(browsing || filters.progress === "any"
      ? []
      : [
          {
            clear: () => update({ progress: "any" }),
            key: "progress",
            label: progressOptions.find((option) => option.value === filters.progress)?.label ?? "",
          },
        ]),
  ];
  const openMedia = (media: AniListMedia) => {
    if (state.entries.some((entry) => entry.mediaId === media.mediaId)) {
      setSelected(media.mediaId);
    } else {
      action(async () => {
        await openAnime.mutateAsync({
          url: `https://anilist.co/anime/${media.mediaId}`,
        });
      });
    }
  };
  const loadMore = () => {
    if (!currentCatalog || loadingMore) {
      return;
    }
    setLoadingMore(true);
    void request<AniListCatalog>("/anilist/catalog", "POST", {
      ...JSON.parse(catalogBody),
      page: currentCatalog.page + 1,
    } as AniListCatalogFilters)
      .then((data) =>
        setCatalog((previous) =>
          previous?.key === catalogKey
            ? {
                data: {
                  ...data,
                  media: [
                    ...new Map(
                      [...previous.data.media, ...data.media].map((media) => [media.mediaId, media])
                    ).values(),
                  ],
                },
                key: catalogKey,
              }
            : previous
        )
      )
      .catch((cause) =>
        setCatalogError({
          key: catalogKey,
          message: cause instanceof Error ? cause.message : "Unable to load more anime",
        })
      )
      .finally(() => setLoadingMore(false));
  };
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
              disabled={browsing ? loadingCatalog : busy || !canLoad}
              onClick={() =>
                browsing
                  ? setCatalogReload((value) => value + 1)
                  : action(async () => {
                      await loadList.mutateAsync();
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
                aria-label="Search anime"
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
                  <DropdownMenuItem
                    disabled={busy || !state}
                    onClick={() =>
                      action(async () => {
                        await savePreferences.mutateAsync({ visibleStatuses: [] });
                        await refresh();
                      })
                    }
                  >
                    None · Browse trending anime
                  </DropdownMenuItem>
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
                            await savePreferences.mutateAsync({
                              visibleStatuses: checked
                                ? [...state.visibleStatuses, value]
                                : state.visibleStatuses.filter((item) => item !== value),
                            });
                            await refresh();
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
          <GenreTagFilter
            filters={filters}
            genres={genres}
            options={catalogOptions}
            update={update}
          />
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
              data-active={advanced || activeFilters.length > 0}
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
            <BrowseAdvancedFilters
              filters={filters}
              genres={genres}
              options={catalogOptions}
              update={update}
            />
            {browsing ? null : (
              <>
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
              </>
            )}
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
              {browsing
                ? loadingCatalog
                  ? "—"
                  : currentCatalog
                    ? entries.length
                    : "—"
                : entries.length}
              {browsing && currentCatalog?.hasNextPage ? "+" : ""} title
              {entries.length === 1 ? "" : "s"}
            </span>
          </div>
          <div className="anilist-view-controls">
            <Select
              items={availableSorts}
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
                  {availableSorts.map((option) => (
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
        {error || (!browsing && state.refreshError) || currentCatalogError ? (
          <Alert>
            <AlertDescription>
              {currentCatalogError ?? error ?? state.refreshError ?? "Unable to load AniList"}
            </AlertDescription>
          </Alert>
        ) : null}
        {loadingCatalog || (!browsing && busy && !state.entries.length) ? (
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
                  now={now}
                  onOpen={() => openMedia(entry)}
                />
              ) : (
                <AnimeCard
                  entry={entry}
                  key={entry.mediaId}
                  now={now}
                  onOpen={() => openMedia(entry)}
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
                {browsing || state.entries.length
                  ? "No anime match your filters"
                  : "Bring your AniList into Tofu"}
              </EmptyTitle>
              <EmptyDescription>
                {browsing || state.entries.length
                  ? "Try another title or clear a filter."
                  : "Connect your account or enter a public username in Settings. Watching and Plan to Watch appear by default."}
              </EmptyDescription>
            </EmptyHeader>
            {browsing || state.entries.length ? null : (
              <Button onClick={() => setSettings(true)}>Connect AniList</Button>
            )}
          </Empty>
        )}
        {browsing && currentCatalog?.hasNextPage ? (
          <Button disabled={loadingMore} onClick={loadMore} variant="outline">
            {loadingMore ? "Loading…" : "Load more anime"}
          </Button>
        ) : null}
      </div>
      {selectedEntry && automationState ? (
        <AniListEpisodeModal
          automation={automationState}
          close={() => setSelected(null)}
          dashboard={dashboard}
          entry={selectedEntry}
          key={selectedEntry.mediaId}
        />
      ) : null}
      {settings && automationState ? (
        <Dialog
          onOpenChange={(open) => {
            if (!open) {
              setSettings(false);
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
              plugin={plugin}
              preferences={automationState.preferences}
              reload={refresh}
              state={state}
              target={target}
            />
          </DialogContent>
        </Dialog>
      ) : null}
    </main>
  );
};
