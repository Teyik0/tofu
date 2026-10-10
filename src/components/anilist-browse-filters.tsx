import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";
import type {
  AniListCatalogFilters,
  AniListCatalogOptions,
  AniListCatalogSort,
  AniListMedia,
} from "../types";
import { OptionSelect } from "./option-select";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";

export const catalogSortOptions = [
  { label: "Title", value: "title" },
  { label: "Popularity", value: "popularity" },
  { label: "Average Score", value: "score" },
  { label: "Trending", value: "trending" },
  { label: "Favorites", value: "favourites" },
  { label: "Date Added", value: "added" },
  { label: "Release Date", value: "released" },
] satisfies { label: string; value: AniListCatalogSort }[];
export const airingOptions = [
  { label: "Any", value: "any" },
  { label: "Airing", value: "RELEASING" },
  { label: "Finished", value: "FINISHED" },
  { label: "Not Yet Aired", value: "NOT_YET_RELEASED" },
  { label: "Cancelled", value: "CANCELLED" },
  { label: "Hiatus", value: "HIATUS" },
];
export const countryOptions = [
  { label: "Any", value: "any" },
  { label: "Japan", value: "JP" },
  { label: "South Korea", value: "KR" },
  { label: "China", value: "CN" },
  { label: "Taiwan", value: "TW" },
];
export const sourceOptions = [
  { label: "Any", value: "any" },
  { label: "Original", value: "ORIGINAL" },
  { label: "Manga", value: "MANGA" },
  { label: "Light Novel", value: "LIGHT_NOVEL" },
  { label: "Visual Novel", value: "VISUAL_NOVEL" },
  { label: "Video Game", value: "VIDEO_GAME" },
  { label: "Other", value: "OTHER" },
  { label: "Novel", value: "NOVEL" },
  { label: "Doujinshi", value: "DOUJINSHI" },
  { label: "Anime", value: "ANIME" },
  { label: "Web Novel", value: "WEB_NOVEL" },
  { label: "Live Action", value: "LIVE_ACTION" },
  { label: "Game", value: "GAME" },
  { label: "Comic", value: "COMIC" },
  { label: "Multimedia Project", value: "MULTIMEDIA_PROJECT" },
  { label: "Picture Book", value: "PICTURE_BOOK" },
];
export const doujinOptions = [
  { label: "Any", value: "any" },
  { label: "Only doujin", value: "only" },
  { label: "Exclude doujin", value: "exclude" },
] satisfies { label: string; value: NonNullable<AniListCatalogFilters["doujin"]> }[];
export interface BrowseFilters {
  airingStatus: string;
  countryOfOrigin: string;
  doujin: NonNullable<AniListCatalogFilters["doujin"]>;
  durationMax: string;
  durationMin: string;
  episodesMax: string;
  episodesMin: string;
  excludedGenres: string[];
  excludedTags: string[];
  source: string;
  streamingOn: string;
  tags: string[];
  yearMax: string;
  yearMin: string;
}
export const noBrowseFilters: BrowseFilters = {
  airingStatus: "any",
  countryOfOrigin: "any",
  doujin: "any",
  durationMax: "",
  durationMin: "",
  episodesMax: "",
  episodesMin: "",
  excludedGenres: [],
  excludedTags: [],
  source: "any",
  streamingOn: "any",
  tags: [],
  yearMax: "",
  yearMin: "",
};
export function browseRequest(filters: BrowseFilters): AniListCatalogFilters {
  return {
    airingStatus: filters.airingStatus === "any" ? undefined : filters.airingStatus,
    countryOfOrigin: filters.countryOfOrigin === "any" ? undefined : filters.countryOfOrigin,
    doujin: filters.doujin,
    durationMax: filters.durationMax ? Number(filters.durationMax) : undefined,
    durationMin: filters.durationMin ? Number(filters.durationMin) : undefined,
    episodesMax: filters.episodesMax ? Number(filters.episodesMax) : undefined,
    episodesMin: filters.episodesMin ? Number(filters.episodesMin) : undefined,
    excludedGenres: filters.excludedGenres,
    excludedTags: filters.excludedTags,
    source: filters.source === "any" ? undefined : filters.source,
    streamingOn: filters.streamingOn === "any" ? undefined : Number(filters.streamingOn),
    tags: filters.tags,
    yearMax: filters.yearMax ? Number(filters.yearMax) : undefined,
    yearMin: filters.yearMin ? Number(filters.yearMin) : undefined,
  };
}
function inRange(value: number | null | undefined, min: string, max: string) {
  return (
    !(min || max) ||
    (value !== null &&
      value !== undefined &&
      (!min || value >= Number(min)) &&
      (!max || value <= Number(max)))
  );
}
export function matchesBrowseFilters(media: AniListMedia, filters: BrowseFilters) {
  return (
    (filters.airingStatus === "any" || media.airingStatus === filters.airingStatus) &&
    (filters.streamingOn === "any" || media.streamingOn?.includes(Number(filters.streamingOn))) &&
    (filters.countryOfOrigin === "any" || media.countryOfOrigin === filters.countryOfOrigin) &&
    (filters.source === "any" || media.source === filters.source) &&
    (filters.doujin === "any" || media.isLicensed === (filters.doujin === "exclude")) &&
    filters.tags.every((tag) => media.tags?.some((item) => item.name === tag && item.rank >= 18)) &&
    !filters.excludedGenres.some((genre) => media.genres.includes(genre)) &&
    !filters.excludedTags.some((tag) =>
      media.tags?.some((item) => item.name === tag && item.rank >= 18)
    ) &&
    inRange(
      media.startDate ? Math.floor(media.startDate / 10_000) : null,
      filters.yearMin,
      filters.yearMax
    ) &&
    inRange(media.episodes, filters.episodesMin, filters.episodesMax) &&
    inRange(media.duration, filters.durationMin, filters.durationMax)
  );
}
export function compareBrowseMedia(a: AniListMedia, b: AniListMedia, sort: AniListCatalogSort) {
  const field = {
    added: "mediaId",
    favourites: "favourites",
    popularity: "popularity",
    released: "startDate",
    score: "averageScore",
    trending: "trending",
  } as const;
  if (sort !== "title") {
    const left = a[field[sort]];
    const right = b[field[sort]];
    if ((left === null || left === undefined) && right !== null && right !== undefined) {
      return 1;
    }
    if (left !== null && left !== undefined && (right === null || right === undefined)) {
      return -1;
    }
    if (
      left !== null &&
      left !== undefined &&
      right !== null &&
      right !== undefined &&
      left !== right
    ) {
      return right - left;
    }
  }
  return a.title.localeCompare(b.title, "en-US");
}

export function GenreTagFilter({
  genres,
  options,
  filters,
  update,
}: {
  genres: string[];
  options: AniListCatalogOptions | null;
  filters: BrowseFilters & { genres: string[] };
  update: (patch: Partial<BrowseFilters & { genres: string[] }>) => void;
}) {
  const [search, setSearch] = useState("");
  const names = [...filters.genres, ...filters.tags];
  const query = search.toLocaleLowerCase("en-US");
  return (
    <div className="anilist-filter">
      <span id="anilist-genres-label">Genres &amp; Tags</span>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-labelledby="anilist-genres-label anilist-genres-value"
              className="anilist-filter-trigger"
              variant="ghost"
            >
              <span id="anilist-genres-value">{names.length ? names.join(", ") : "Any"}</span>
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="anilist-genre-menu">
          <Input
            aria-label="Find genres and tags"
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Find a genre or tag"
            value={search}
          />
          <DropdownMenuGroup>
            <DropdownMenuLabel>Genres</DropdownMenuLabel>
            {genres
              .filter((genre) => genre.toLocaleLowerCase("en-US").includes(query))
              .map((genre) => (
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
          <DropdownMenuGroup>
            <DropdownMenuLabel>Tags</DropdownMenuLabel>
            {(options?.tags ?? [])
              .filter((tag) => tag.name.toLocaleLowerCase("en-US").includes(query))
              .map((tag) => (
                <DropdownMenuCheckboxItem
                  checked={filters.tags.includes(tag.name)}
                  key={tag.name}
                  onCheckedChange={(checked) =>
                    update({
                      tags: checked
                        ? [...filters.tags, tag.name]
                        : filters.tags.filter((item) => item !== tag.name),
                    })
                  }
                >
                  {tag.name}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
function ExclusionFilter({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  return (
    <Field className="anilist-filter">
      <FieldLabel>{label}</FieldLabel>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              aria-label={`${label}: ${value.join(", ") || "None"}`}
              className="anilist-filter-trigger"
              variant="ghost"
            >
              <span>{value.join(", ") || "None"}</span>
              <ChevronDownIcon data-icon="inline-end" />
            </Button>
          }
        />
        <DropdownMenuContent align="start" className="anilist-genre-menu">
          <Input
            aria-label={`Find ${label.toLowerCase()}`}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search"
            value={search}
          />
          <DropdownMenuGroup>
            <DropdownMenuLabel>{label}</DropdownMenuLabel>
            {options
              .filter((name) =>
                name.toLocaleLowerCase("en-US").includes(search.toLocaleLowerCase("en-US"))
              )
              .map((name) => (
                <DropdownMenuCheckboxItem
                  checked={value.includes(name)}
                  key={name}
                  onCheckedChange={(checked) =>
                    onChange(checked ? [...value, name] : value.filter((item) => item !== name))
                  }
                >
                  {name}
                </DropdownMenuCheckboxItem>
              ))}
          </DropdownMenuGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </Field>
  );
}
export function BrowseAdvancedFilters({
  filters,
  options,
  genres,
  update,
}: {
  filters: BrowseFilters;
  options: AniListCatalogOptions | null;
  genres: string[];
  update: (patch: Partial<BrowseFilters>) => void;
}) {
  const streamingOptions = [
    { label: "Any", value: "any" },
    ...(options?.streaming ?? []).map((site) => ({ label: site.name, value: String(site.id) })),
  ];
  return (
    <FieldGroup className="anilist-browse-advanced">
      {[
        { key: "airingStatus", label: "Airing Status", options: airingOptions },
        { key: "streamingOn", label: "Streaming On", options: streamingOptions },
        { key: "countryOfOrigin", label: "Country of Origin", options: countryOptions },
        { key: "source", label: "Source Material", options: sourceOptions },
      ].map((field) => (
        <Field className="anilist-filter" key={field.key}>
          <FieldLabel htmlFor={`anilist-${field.key}`}>{field.label}</FieldLabel>
          <OptionSelect
            className="anilist-filter-trigger"
            disabled={false}
            id={`anilist-${field.key}`}
            onValueChange={(value) => update({ [field.key]: value })}
            options={field.options}
            value={
              filters[field.key as "airingStatus" | "streamingOn" | "countryOfOrigin" | "source"]
            }
          />
        </Field>
      ))}
      {[
        { label: "Year Range", lower: 1900, max: "yearMax", min: "yearMin", upper: 2200 },
        { label: "Episodes", lower: 0, max: "episodesMax", min: "episodesMin", upper: 100_000 },
        {
          label: "Duration (minutes)",
          lower: 0,
          max: "durationMax",
          min: "durationMin",
          upper: 100_000,
        },
      ].map((range) => (
        <Field className="anilist-filter" key={range.min}>
          <FieldLabel htmlFor={`anilist-${range.min}`}>{range.label}</FieldLabel>
          <div className="anilist-range">
            {[range.min, range.max].map((key, index) => (
              <Input
                aria-label={`${range.label} ${index === 0 ? "minimum" : "maximum"}`}
                id={`anilist-${key}`}
                key={key}
                max={range.upper}
                min={range.lower}
                onChange={(event) => update({ [key]: event.target.value })}
                placeholder={index === 0 ? "Min" : "Max"}
                step={1}
                type="number"
                value={
                  filters[
                    key as
                      | "yearMin"
                      | "yearMax"
                      | "episodesMin"
                      | "episodesMax"
                      | "durationMin"
                      | "durationMax"
                  ]
                }
              />
            ))}
          </div>
        </Field>
      ))}
      <Field className="anilist-filter">
        <FieldLabel htmlFor="anilist-doujin">Doujin</FieldLabel>
        <OptionSelect
          className="anilist-filter-trigger"
          disabled={false}
          id="anilist-doujin"
          onValueChange={(doujin) => update({ doujin })}
          options={doujinOptions}
          value={filters.doujin}
        />
      </Field>
      <ExclusionFilter
        label="Exclude Genres"
        onChange={(excludedGenres) => update({ excludedGenres })}
        options={genres}
        value={filters.excludedGenres}
      />
      <ExclusionFilter
        label="Exclude Tags"
        onChange={(excludedTags) => update({ excludedTags })}
        options={options?.tags.map((tag) => tag.name) ?? []}
        value={filters.excludedTags}
      />
    </FieldGroup>
  );
}
