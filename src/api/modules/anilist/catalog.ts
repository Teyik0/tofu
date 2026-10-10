import {
  array,
  check,
  integer,
  maxLength,
  maxValue,
  minLength,
  minValue,
  object,
  optional,
  picklist,
  pipe,
  string,
} from "valibot";
import type { AniListCatalogFilters, AniListMedia } from "../../../types";
import { UserError } from "../../lib/errors";
import { integerInput } from "../../lib/validation";
import type { AniListMediaFragment, CatalogQueryVariables } from "./graphql/generated";

export type CatalogMedia = AniListMediaFragment;
const mediaStatuses = ["RELEASING", "FINISHED", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"] as const;
const mediaFormats = ["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"] as const;
const mediaSources = [
  "ORIGINAL",
  "MANGA",
  "LIGHT_NOVEL",
  "VISUAL_NOVEL",
  "VIDEO_GAME",
  "OTHER",
  "NOVEL",
  "DOUJINSHI",
  "ANIME",
  "WEB_NOVEL",
  "LIVE_ACTION",
  "GAME",
  "COMIC",
  "MULTIMEDIA_PROJECT",
  "PICTURE_BOOK",
] as const;

function enumValue<Value extends string>(input: string | undefined, values: readonly Value[]) {
  if (input === undefined) {
    return;
  }
  const value = values.find((candidate) => candidate === input);
  if (value === undefined) {
    throw new UserError("Invalid AniList catalog filter", { status: 400 });
  }
  return value;
}
const choices = (values: readonly string[]) => optional(picklist(values));
const names = optional(
  pipe(
    array(pipe(string(), minLength(1), maxLength(100))),
    maxLength(30),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  )
);
const year = optional(pipe(integerInput, integer(), minValue(1900), maxValue(2200)));
const count = optional(pipe(integerInput, integer(), minValue(0), maxValue(100_000)));
export const catalogSchema = object({
  airingStatus: choices(mediaStatuses),
  countryOfOrigin: choices(["JP", "KR", "CN", "TW"]),
  doujin: choices(["any", "only", "exclude"]),
  durationMax: count,
  durationMin: count,
  episodesMax: count,
  episodesMin: count,
  excludedGenres: names,
  excludedTags: names,
  format: choices(mediaFormats),
  genres: names,
  page: optional(pipe(integerInput, integer(), minValue(1), maxValue(1000))),
  search: optional(pipe(string(), maxLength(200))),
  season: choices(["WINTER", "SPRING", "SUMMER", "FALL"]),
  sort: choices(["title", "popularity", "score", "trending", "favourites", "added", "released"]),
  source: choices(mediaSources),
  streamingOn: optional(pipe(integerInput, integer(), minValue(1))),
  tags: names,
  year,
  yearMax: year,
  yearMin: year,
});
const mediaSort = {
  added: "ID_DESC",
  favourites: "FAVOURITES_DESC",
  popularity: "POPULARITY_DESC",
  released: "START_DATE_DESC",
  score: "SCORE_DESC",
  title: "TITLE_ROMAJI",
  trending: "TRENDING_DESC",
} as const;
export function catalogVariables(filters: AniListCatalogFilters): CatalogQueryVariables {
  for (const [min, max] of [
    [filters.yearMin, filters.yearMax],
    [filters.episodesMin, filters.episodesMax],
    [filters.durationMin, filters.durationMax],
  ]) {
    if (min !== undefined && max !== undefined && min > max) {
      throw new UserError("The minimum must not exceed the maximum", { status: 400 });
    }
  }
  return {
    countryOfOrigin: filters.countryOfOrigin,
    duration_greater: filters.durationMin === undefined ? undefined : filters.durationMin - 1,
    duration_lesser: filters.durationMax === undefined ? undefined : filters.durationMax + 1,
    episodes_greater: filters.episodesMin === undefined ? undefined : filters.episodesMin - 1,
    episodes_lesser: filters.episodesMax === undefined ? undefined : filters.episodesMax + 1,
    format: enumValue(filters.format, mediaFormats),
    genre_in: filters.genres?.length ? filters.genres : undefined,
    genre_not_in: filters.excludedGenres?.length ? filters.excludedGenres : undefined,
    licensedById: filters.streamingOn,
    page: filters.page ?? 1,
    search: filters.search?.trim() || undefined,
    season: filters.season,
    seasonYear: filters.year,
    sort: [...new Set([mediaSort[filters.sort ?? "trending"], "ID_DESC" as const])],
    source: enumValue(filters.source, mediaSources),
    startDate_greater:
      filters.yearMin === undefined ? undefined : (filters.yearMin - 1) * 10_000 + 1231,
    startDate_lesser:
      filters.yearMax === undefined ? undefined : (filters.yearMax + 1) * 10_000 + 101,
    status: enumValue(filters.airingStatus, mediaStatuses),
    tag_in: filters.tags?.length ? filters.tags : undefined,
    tag_not_in: filters.excludedTags?.length ? filters.excludedTags : undefined,
  };
}

function catalogStatistics(media: CatalogMedia) {
  return {
    averageScore: media.averageScore ?? null,
    countryOfOrigin: media.countryOfOrigin ?? null,
    duration: media.duration ?? null,
    endDate: media.endDate ?? null,
    favourites: media.favourites ?? null,
    isAdult: media.isAdult ?? null,
    isLicensed: media.isLicensed ?? null,
    nextAiringEpisode: media.nextAiringEpisode ?? null,
    popularity: media.popularity ?? null,
    releaseDate: media.startDate ?? null,
    source: media.source ?? null,
    studios: (media.studios?.nodes ?? []).flatMap((studio) => (studio?.name ? [studio.name] : [])),
    tags: (media.tags ?? []).flatMap((tag) =>
      tag && tag.rank !== null && tag.isAdult !== null
        ? [{ isAdult: tag.isAdult, name: tag.name, rank: tag.rank }]
        : []
    ),
    trending: media.trending ?? null,
  };
}
export function catalogMedia(media: CatalogMedia): AniListMedia {
  const aliases = [
    ...new Set(
      [
        media.title?.romaji,
        media.title?.english,
        media.title?.native,
        media.title?.userPreferred,
        ...(media.synonyms ?? []),
      ].filter((name): name is string => typeof name === "string" && name.trim().length > 0)
    ),
  ].slice(0, 30);
  return {
    ...catalogStatistics(media),
    airingStatus: media.status ?? null,
    aliases,
    bannerImage: media.bannerImage ?? null,
    coverImage: media.coverImage?.extraLarge ?? media.coverImage?.large ?? null,
    episodes: media.episodes ?? null,
    format: media.format ?? null,
    genres: (media.genres ?? []).filter((genre): genre is string => typeof genre === "string"),
    mediaId: media.id,
    season: media.season ?? null,
    seasonYear: media.seasonYear ?? null,
    siteUrl: media.siteUrl ?? null,
    startDate: media.startDate?.year
      ? media.startDate.year * 10_000 +
        (media.startDate.month ?? 0) * 100 +
        (media.startDate.day ?? 0)
      : null,
    streamingOn: (media.externalLinks ?? []).flatMap((link) =>
      link?.type === "STREAMING" && !link.isDisabled && link.siteId !== null ? [link.siteId] : []
    ),
    title: aliases[0] ?? `Anime ${media.id}`,
  };
}
