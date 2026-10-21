import type { AniListCatalogFilters, AniListCatalogSort } from "../../api/modules/anilist/catalog";
import type { AniListCatalog } from "../../api/modules/anilist/service";
import type {
  AniListCatalogOptions,
  AniListEntry,
  AniListMedia,
  AniListSeason,
  AniListState,
} from "../../api/modules/anilist/types";
import {
  airingOptions,
  type BrowseFilters,
  catalogSortOptions,
  compareBrowseMedia,
  countryOptions,
  matchesBrowseFilters,
  noBrowseFilters,
  sourceOptions,
} from "./_browse-filters";
export type SortValue = AniListCatalogSort | "progress" | "year";
export const sortOptions = [
  ...catalogSortOptions,
  { label: "Episode progress", value: "progress" },
  { label: "Newest year", value: "year" },
] satisfies { label: string; value: SortValue }[];
type ProgressValue = "not-started" | "in-progress" | "caught-up";
export interface Filters extends BrowseFilters {
  formats: NonNullable<AniListCatalogFilters["formats"]>;
  genres: string[];
  progress: ProgressValue | "any";
  season: AniListSeason | "any";
  tracking: "any" | "automated" | "manual";
  year: string;
}
export const noFilters: Filters = {
  ...noBrowseFilters,
  formats: [],
  genres: [],
  progress: "any",
  season: "any",
  tracking: "any",
  year: "any",
};
export const seasonOptions = [
  { label: "Any", value: "any" },
  { label: "Winter", value: "WINTER" },
  { label: "Spring", value: "SPRING" },
  { label: "Summer", value: "SUMMER" },
  { label: "Fall", value: "FALL" },
] satisfies { label: string; value: Filters["season"] }[];
export const trackingOptions = [
  { label: "Any", value: "any" },
  { label: "Has its own automation", value: "automated" },
  { label: "Uses list tracking", value: "manual" },
] satisfies { label: string; value: Filters["tracking"] }[];
export const progressOptions = [
  { label: "Any", value: "any" },
  { label: "Not started", value: "not-started" },
  { label: "In progress", value: "in-progress" },
  { label: "Caught up", value: "caught-up" },
] satisfies { label: string; value: Filters["progress"] }[];
const formatOptions = [
  { label: "Movie", value: "MOVIE" },
  { label: "Music", value: "MUSIC" },
  { label: "ONA", value: "ONA" },
  { label: "OVA", value: "OVA" },
  { label: "Special", value: "SPECIAL" },
  { label: "TV Show", value: "TV" },
  { label: "TV Short", value: "TV_SHORT" },
] satisfies { label: string; value: Filters["formats"][number] }[];
export const formatLabel = (format: string) =>
  formatOptions.find((option) => option.value === format)?.label ?? format.replaceAll("_", " ");
function progressOf(entry: AniListEntry): ProgressValue {
  if (entry.progress === 0) {
    return "not-started";
  }
  return entry.episodes !== null && entry.progress >= entry.episodes ? "caught-up" : "in-progress";
}

export function useLibraryFilters(
  state: AniListState,
  catalogOptions: AniListCatalogOptions | null,
  browsing: boolean,
  search: string,
  sort: SortValue,
  now: number,
  currentCatalog: AniListCatalog | null,
  filters: Filters,
  setFilters: React.Dispatch<React.SetStateAction<Filters>>
) {
  const update = (patch: Partial<Filters>) => setFilters((previous) => ({ ...previous, ...patch }));

  const statuses = new Set(state.visibleStatuses);
  const formatsSelected = new Set<string>(filters.formats);
  const listed = state.entries.filter((entry) => statuses.has(entry.status));
  const genres = [
    ...new Set([
      ...(catalogOptions?.genres ?? []),
      ...state.entries.flatMap((entry) => entry.genres),
    ]),
  ].sort((a, b) => a.localeCompare(b, "en-US"));
  const years = Array.from({ length: new Date(now).getFullYear() + 2 - 1940 + 1 }, (_, index) =>
    String(new Date(now).getFullYear() + 2 - index)
  );
  const formats = formatOptions.map((option) => option.value);
  const query = search.toLocaleLowerCase("en-US");
  const libraryEntries = listed
    .filter(
      (entry) =>
        entry.aliases.some((title) => title.toLocaleLowerCase("en-US").includes(query)) &&
        filters.genres.every((genre) => entry.genres.includes(genre)) &&
        (filters.year === "any" || String(entry.seasonYear) === filters.year) &&
        (filters.season === "any" || entry.season === filters.season) &&
        (!filters.formats.length || (entry.format !== null && formatsSelected.has(entry.format))) &&
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
  return {
    activeFilters,
    clear: () => setFilters(noFilters),
    entries,
    filters,
    formats,
    genres,
    update,
    years,
  };
}
