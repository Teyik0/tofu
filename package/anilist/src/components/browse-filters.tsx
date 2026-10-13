import type {
  AniListCatalogFilters,
  AniListCatalogOptions,
  AniListCatalogSort,
  AniListMedia,
} from "@tofu/plugins/domain";
import { Badge } from "@tofu/ui/badge";
import { Button } from "@tofu/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@tofu/ui/dropdown-menu";
import { Field, FieldGroup, FieldLabel } from "@tofu/ui/field";
import { Input } from "@tofu/ui/input";
import { OptionSelect, type SelectOption } from "@tofu/ui/option-select";
import { ChevronDownIcon, XIcon } from "lucide-react";
import { useState } from "react";

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
  const names = [...filters.genres, ...filters.tags];
  const selectedGenres = new Set(filters.genres);
  const selectedTags = new Set(filters.tags);
  return (
    <div className="anilist-filter">
      <span id="anilist-genres-label">Genres &amp; Tags</span>
      <div className="anilist-filter-control" data-selected={names.length > 0}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-labelledby="anilist-genres-label anilist-genres-value"
                className="anilist-filter-trigger"
                variant="ghost"
              >
                <span className="sr-only" id="anilist-genres-value">
                  {names.join(", ") || "Any"}
                </span>
                <span aria-hidden="true" className="anilist-genre-summary">
                  {names.length ? (
                    <>
                      <Badge className="anilist-genre-value" variant="secondary">
                        {names[0]}
                      </Badge>
                      {names.length > 1 ? (
                        <Badge className="anilist-genre-count" variant="secondary">
                          +{names.length - 1}
                        </Badge>
                      ) : null}
                    </>
                  ) : (
                    "Any"
                  )}
                </span>
                {names.length ? null : <ChevronDownIcon data-icon="inline-end" />}
              </Button>
            }
          />
          <DropdownMenuContent
            align="start"
            className="anilist-genre-menu anilist-genre-picker"
            sideOffset={10}
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>Genres</DropdownMenuLabel>
              {genres.map((genre) => (
                <DropdownMenuCheckboxItem
                  checked={selectedGenres.has(genre)}
                  closeOnClick={false}
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
              {(options?.tags ?? []).map((tag) => (
                <DropdownMenuCheckboxItem
                  checked={selectedTags.has(tag.name)}
                  closeOnClick={false}
                  disabled={filters.tags.length >= 30 && !selectedTags.has(tag.name)}
                  key={tag.name}
                  onCheckedChange={(checked) =>
                    update({
                      tags: checked
                        ? filters.tags.length < 30 && !selectedTags.has(tag.name)
                          ? [...filters.tags, tag.name]
                          : filters.tags
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
        {names.length ? (
          <Button
            aria-label="Clear genres and tags"
            className="anilist-filter-clear"
            onClick={() => update({ genres: [], tags: [] })}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
    </div>
  );
}
export function CatalogSelectFilter<Value extends string>({
  id,
  label,
  value,
  options,
  onValueChange,
}: {
  id: string;
  label: string;
  value: Value | "any";
  options: readonly SelectOption<Value | "any">[];
  onValueChange: (value: Value | "any") => void;
}) {
  return (
    <Field className="anilist-filter">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="anilist-filter-control" data-selected={value !== "any"}>
        <OptionSelect
          className="anilist-filter-trigger"
          contentClassName="anilist-select-menu"
          disabled={!options.length}
          id={id}
          onValueChange={onValueChange}
          options={options}
          value={value}
        />
        {value === "any" ? null : (
          <Button
            aria-label={`Clear ${label.toLowerCase()}`}
            className="anilist-filter-clear"
            onClick={() => onValueChange("any")}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        )}
      </div>
    </Field>
  );
}
export function CatalogMultiSelectFilter<Value extends string>({
  id,
  label,
  value,
  options,
  onValueChange,
}: {
  id: string;
  label: string;
  value: Value[];
  options: readonly SelectOption<Value>[];
  onValueChange: (value: Value[]) => void;
}) {
  const summary = value.map(
    (item) => options.find((option) => option.value === item)?.label ?? item
  );
  const selected = new Set(value);
  return (
    <Field className="anilist-filter">
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="anilist-filter-control" data-selected={value.length > 0}>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={`${label}: ${summary.join(", ") || "Any"}`}
                className="anilist-filter-trigger"
                id={id}
                variant="ghost"
              >
                <span className="anilist-genre-summary">
                  {summary.length ? (
                    <>
                      <Badge className="anilist-genre-value" variant="secondary">
                        {summary[0]}
                      </Badge>
                      {summary.length > 1 ? (
                        <Badge className="anilist-genre-count" variant="secondary">
                          +{summary.length - 1}
                        </Badge>
                      ) : null}
                    </>
                  ) : (
                    "Any"
                  )}
                </span>
                {value.length ? null : <ChevronDownIcon data-icon="inline-end" />}
              </Button>
            }
          />
          <DropdownMenuContent align="start" className="anilist-genre-menu" sideOffset={10}>
            <DropdownMenuGroup>
              <DropdownMenuCheckboxItem
                checked={!value.length}
                closeOnClick={false}
                onCheckedChange={() => onValueChange([])}
              >
                Any
              </DropdownMenuCheckboxItem>
              {options.map((option) => (
                <DropdownMenuCheckboxItem
                  checked={selected.has(option.value)}
                  closeOnClick={false}
                  key={option.value}
                  onCheckedChange={(checked) =>
                    onValueChange(
                      checked
                        ? [...value, option.value]
                        : value.filter((item) => item !== option.value)
                    )
                  }
                >
                  {option.label}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {value.length ? (
          <Button
            aria-label={`Clear ${label.toLowerCase()}`}
            className="anilist-filter-clear"
            onClick={() => onValueChange([])}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        ) : null}
      </div>
    </Field>
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
  const selected = new Set(value);
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
                  checked={selected.has(name)}
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
        <CatalogSelectFilter
          id={`anilist-${field.key}`}
          key={field.key}
          label={field.label}
          onValueChange={(value) => update({ [field.key]: value })}
          options={field.options}
          value={
            filters[field.key as "airingStatus" | "streamingOn" | "countryOfOrigin" | "source"]
          }
        />
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
