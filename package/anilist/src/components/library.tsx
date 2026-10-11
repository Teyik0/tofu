import type { PreviewCard } from "@base-ui/react/preview-card";
import { useMutation } from "@teyik0/furin/client";
import type {
  AniListCatalog,
  AniListCatalogFilters,
  AniListCatalogOptions,
  AniListCatalogSort,
  AniListEntry,
  AniListMedia,
  AniListSeason,
} from "@tofu/plugins/domain";
import { ActionTooltip } from "@tofu/ui/action-tooltip";
import { Alert, AlertDescription } from "@tofu/ui/alert";
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
  DropdownMenuTrigger,
} from "@tofu/ui/dropdown-menu";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@tofu/ui/empty";
import { Field, FieldLabel } from "@tofu/ui/field";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@tofu/ui/hover-card";
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
  TagsIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { api } from "../client-api";
import { useRefresh } from "../host";
import { request } from "../request";
import {
  airingOptions,
  BrowseAdvancedFilters,
  type BrowseFilters,
  browseRequest,
  CatalogMultiSelectFilter,
  CatalogSelectFilter,
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
import { aniListMediaColors } from "./media-colors";
import { AniListMediaInfo, animeAiringLabel } from "./media-info";
import { AniListPanel } from "./panel";
import { aniListStatusLabel, aniListStatusLabels } from "./status";
import { AniListStatusDot } from "./status-dot";

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
  formats: string[];
  genres: string[];
  progress: ProgressValue | "any";
  season: AniListSeason | "any";
  tracking: "any" | "automated" | "manual";
  year: string;
}
const noFilters: Filters = {
  ...noBrowseFilters,
  formats: [],
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
      aria-description={"status" in entry ? aniListStatusLabel(entry.status) : undefined}
      aria-label={`View episodes for ${entry.title}`}
      className="anime-row"
      onClick={onOpen}
      type="button"
    >
      <span className="anime-row-cover">
        <AniListCover src={entry.coverImage} />
      </span>
      <span className="anime-row-title">
        <strong>
          {"status" in entry ? <AniListStatusDot status={entry.status} /> : null}
          {entry.title}
        </strong>
        <small>{entry.genres.slice(0, 3).join(" · ") || "—"}</small>
      </span>
      <span className="anime-row-meta">
        {entry.format ? formatLabel(entry.format) : "—"} · {entry.seasonYear ?? "—"}
      </span>
      <span className="anime-row-airing">{animeAiringLabel(entry, now)}</span>
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
  const previewActions = useRef<PreviewCard.Root.Actions | null>(null);
  const scrollController = useRef<AbortController | null>(null);
  useEffect(() => () => scrollController.current?.abort(), []);
  const closePreview = () => flushSync(() => previewActions.current?.close());
  return (
    <HoverCard
      actionsRef={previewActions}
      onOpenChange={(open) => {
        scrollController.current?.abort();
        scrollController.current = null;
        if (open) {
          const controller = new AbortController();
          scrollController.current = controller;
          window.addEventListener("scroll", closePreview, {
            capture: true,
            signal: controller.signal,
          });
        }
      }}
    >
      <HoverCardTrigger
        closeDelay={0}
        delay={0}
        onMouseLeave={closePreview}
        render={
          <button
            aria-description={
              "status" in entry
                ? `${aniListStatusLabel(entry.status)} · ${entry.progress} / ${entry.episodes ?? "—"} watched`
                : undefined
            }
            aria-label={`View episodes for ${entry.title}`}
            className="anime-card"
            onClick={onOpen}
            style={aniListMediaColors(entry.coverColor)}
            type="button"
          />
        }
      >
        <div className="anime-card-cover">
          <AniListCover src={entry.coverImage} />
          {"automationId" in entry && entry.automationId ? (
            <span className="anime-card-automation" title="Custom automation">
              <ZapIcon aria-label="Custom automation" />
            </span>
          ) : null}
        </div>
        <strong>
          {"status" in entry ? <AniListStatusDot status={entry.status} /> : null}
          {entry.title}
        </strong>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        alignOffset={5}
        className="anime-preview-popup"
        side="right"
        sideOffset={18}
      >
        <AniListMediaInfo media={entry} now={now} />
      </HoverCardContent>
    </HoverCard>
  );
}

export const AniListLibrary = ({
  dashboard,
  initialAniList: state,
  initialAutomation: automationState,
}: {
  dashboard: import("@tofu/plugins/domain").DashboardState;
  initialAniList: import("@tofu/plugins/domain").AniListState;
  initialAutomation: import("@tofu/plugins/domain").AutomationState;
}) => {
  const refresh = useRefresh();
  const loadList = useMutation(api.anilist.list.post);
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
  const catalogEnd = useRef<HTMLDivElement>(null);
  const catalogRequest = useRef<AbortController | null>(null);
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
    formats: filters.formats,
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
    setLoadingMore(false);
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
      catalogRequest.current?.abort();
      catalogRequest.current = null;
    };
  }, [browsing, catalogKey, catalogBody]);
  const [advanced, setAdvanced] = useState(false);
  const [view, setView] = useState<ViewValue>("cards");
  const update = (patch: Partial<Filters>) => setFilters((previous) => ({ ...previous, ...patch }));
  const [selected, setSelected] = useState<AniListMedia | null>(null);
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
        (!filters.formats.length ||
          (entry.format !== null && filters.formats.includes(entry.format))) &&
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
  const trackedMedia = new Map(state.entries.map((entry) => [entry.mediaId, entry]));
  const entries: (AniListEntry | AniListMedia)[] = browsing
    ? (currentCatalog?.media ?? []).map((media) => {
        const tracked = trackedMedia.get(media.mediaId);
        return tracked
          ? {
              ...media,
              automationId: tracked.automationId,
              completedEpisodes: tracked.completedEpisodes,
              progress: tracked.progress,
              status: tracked.status,
            }
          : media;
      })
    : libraryEntries;
  const activeFilters = [
    ...filters.genres.map((genre) => ({
      clear: () => update({ genres: filters.genres.filter((item) => item !== genre) }),
      key: `genre:${genre}`,
      label: genre,
    })),
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
    ...filters.formats.map((format) => ({
      clear: () => update({ formats: filters.formats.filter((item) => item !== format) }),
      key: `format:${format}`,
      label: formatLabel(format),
    })),
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
    setSelected(media);
  };
  const loadMore = () => {
    if (!(browsing && currentCatalog?.hasNextPage) || catalogRequest.current) {
      return;
    }
    const controller = new AbortController();
    catalogRequest.current = controller;
    setLoadingMore(true);
    void request<AniListCatalog>(
      "/anilist/catalog",
      "POST",
      {
        ...(JSON.parse(catalogBody) as AniListCatalogFilters),
        page: currentCatalog.page + 1,
      },
      controller.signal
    )
      .then((data) => {
        if (controller.signal.aborted) {
          return;
        }
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
        );
        setCatalogError(null);
      })
      .catch((cause) => {
        if (controller.signal.aborted) {
          return;
        }
        setCatalogError({
          key: catalogKey,
          message: cause instanceof Error ? cause.message : "Unable to load more anime",
        });
      })
      .finally(() => {
        if (catalogRequest.current === controller) {
          catalogRequest.current = null;
          setLoadingMore(false);
        }
      });
  };
  const loadNextPage = useEffectEvent(loadMore);
  const catalogPage = currentCatalog?.page;
  const hasNextPage = currentCatalog?.hasNextPage;
  useEffect(() => {
    const sentinel = catalogEnd.current;
    if (
      !(browsing && hasNextPage) ||
      catalogPage === undefined ||
      loadingMore ||
      currentCatalogError ||
      !sentinel
    ) {
      return;
    }
    const observer = new IntersectionObserver(
      (observations) => {
        if (observations.some((observation) => observation.isIntersecting)) {
          loadNextPage();
        }
      },
      { rootMargin: "300px 0px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [browsing, hasNextPage, loadingMore, currentCatalogError, catalogPage]);
  const selectedEntry = selected
    ? (state.entries.find((entry) => entry.mediaId === selected.mediaId) ?? selected)
    : null;
  const accountName = state?.connectedUser || state?.userName || null;
  return (
    <main className="anilist-library">
      <header className="library-topbar anilist-page-header">
        <div className="library-title anilist-page-heading">
          <SidebarToggle className="mobile-sidebar-toggle" />
          <AniListIcon />
          <h1>AniList</h1>
        </div>
        <div className="anilist-header-actions">
          <div className="anilist-list-selector">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    aria-label={`Lists ${state.visibleStatuses.map(aniListStatusLabel).join(", ") || "None"}`}
                    className="anilist-status-filter"
                    size="lg"
                    variant="outline"
                  >
                    <span aria-hidden="true" className="anilist-status-filter-label">
                      Lists
                    </span>
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
              <DropdownMenuContent align="start" className="anilist-genre-menu" sideOffset={10}>
                <DropdownMenuGroup>
                  <DropdownMenuCheckboxItem
                    checked={!state.visibleStatuses.length}
                    disabled={busy || !state}
                    onCheckedChange={() =>
                      action(async () => {
                        await savePreferences.mutateAsync({ visibleStatuses: [] });
                        await refresh();
                      })
                    }
                  >
                    None
                  </DropdownMenuCheckboxItem>
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
          <span aria-hidden="true" className="toolbar-divider" />
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
              size="icon-lg"
              variant="outline"
            >
              <RefreshCwIcon className={busy ? "motion-safe:animate-spin" : undefined} />
            </Button>
          </ActionTooltip>
          {/* The account doubles as the settings entry point, like AniList's avatar menu. */}
          <ActionTooltip>
            {accountName ? (
              <Button
                aria-label={`AniList settings, ${accountName}`}
                className="anilist-account-button"
                onClick={() => setSettings(true)}
                size="lg"
                variant="outline"
              >
                <span aria-hidden="true" className="anilist-account-avatar">
                  {accountName.slice(0, 1).toUpperCase()}
                </span>
                <span className="anilist-account-name">{accountName}</span>
                <SettingsIcon aria-hidden="true" data-icon="inline-end" />
              </Button>
            ) : (
              <Button
                aria-label="AniList settings"
                className="anilist-account-button"
                onClick={() => setSettings(true)}
                size="icon-lg"
                variant="outline"
              >
                <SettingsIcon />
              </Button>
            )}
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
          <GenreTagFilter
            filters={filters}
            genres={genres}
            options={catalogOptions}
            update={update}
          />
          <CatalogSelectFilter
            id="anilist-year"
            label="Year"
            onValueChange={(year) => update({ year })}
            options={[
              { label: "Any", value: "any" },
              ...years.map((year) => ({ label: year, value: year })),
            ]}
            value={filters.year}
          />

          <CatalogSelectFilter
            id="anilist-season"
            label="Season"
            onValueChange={(season) => update({ season })}
            options={seasonOptions}
            value={filters.season}
          />

          <CatalogMultiSelectFilter
            id="anilist-format"
            label="Format"
            onValueChange={(selectedFormats) => update({ formats: selectedFormats })}
            options={formats.map((format) => ({ label: formatLabel(format), value: format }))}
            value={filters.formats}
          />

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
          <fieldset aria-label="Active filters" className="anilist-active-filters">
            {activeFilters.length ? (
              <TagsIcon aria-hidden="true" className="anilist-filter-tag" />
            ) : null}
            {activeFilters.map((filter) => (
              <button
                aria-label={`Remove filter ${filter.label}`}
                className="anilist-filter-chip"
                key={filter.key}
                onClick={filter.clear}
                title={`Remove ${filter.label}`}
                type="button"
              >
                {filter.label}
                <XIcon aria-hidden="true" />
              </button>
            ))}
            {activeFilters.length ? (
              <button
                className="anilist-filter-chip anilist-clear-filters"
                onClick={() => setFilters(noFilters)}
                type="button"
              >
                Clear All
                <XIcon aria-hidden="true" />
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
          </fieldset>
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
              <SelectContent
                align="end"
                alignItemWithTrigger={false}
                className="anilist-select-menu"
              >
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
          <div className="flex min-h-10 items-center justify-center" ref={catalogEnd}>
            {currentCatalogError ? (
              <Button disabled={loadingMore} onClick={loadMore} variant="outline">
                {loadingMore ? "Loading…" : "Retry loading anime"}
              </Button>
            ) : (
              <span className="text-muted-foreground text-sm" role="status">
                {loadingMore ? "Loading more anime…" : ""}
              </span>
            )}
          </div>
        ) : null}
      </div>
      {selectedEntry && automationState ? (
        <AniListEpisodeModal
          authenticated={state.authenticated}
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
