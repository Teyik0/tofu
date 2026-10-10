import { t } from "elysia";
import type { AniListCatalogFilters, AniListMedia } from "../../types";
import { UserError } from "../engine";

export interface CatalogMedia {
  averageScore?: number | null;
  bannerImage?: string | null;
  countryOfOrigin?: string | null;
  coverImage?: { extraLarge?: string | null; large?: string | null };
  duration?: number | null;
  endDate?: { year: number | null; month: number | null; day: number | null };
  episodes?: number | null;
  externalLinks?: { siteId: number | null; type: string; isDisabled: boolean | null }[];
  favourites?: number | null;
  format?: string | null;
  genres?: string[] | null;
  id: number;
  isAdult?: boolean | null;
  isLicensed?: boolean | null;
  nextAiringEpisode?: { episode: number; airingAt: number } | null;
  popularity?: number | null;
  season?: string | null;
  seasonYear?: number | null;
  siteUrl?: string | null;
  source?: string | null;
  startDate?: { year: number | null; month: number | null; day: number | null };
  status?: string | null;
  studios?: { nodes: { name: string }[] };
  synonyms?: string[];
  tags?: { name: string; rank: number; isAdult: boolean }[];
  title: {
    romaji?: string | null;
    english?: string | null;
    native?: string | null;
    userPreferred?: string | null;
  };
  trending?: number | null;
}
const choices = (values: string[]) => t.Optional(t.Union(values.map((value) => t.Literal(value))));
const names = t.Optional(
  t.Array(t.String({ maxLength: 100, minLength: 1 }), { maxItems: 30, uniqueItems: true })
);
const year = t.Optional(t.Integer({ maximum: 2200, minimum: 1900 }));
const count = t.Optional(t.Integer({ maximum: 100_000, minimum: 0 }));
export const catalogSchema = t.Object({
  airingStatus: choices(["RELEASING", "FINISHED", "NOT_YET_RELEASED", "CANCELLED", "HIATUS"]),
  countryOfOrigin: choices(["JP", "KR", "CN", "TW"]),
  doujin: choices(["any", "only", "exclude"]),
  durationMax: count,
  durationMin: count,
  episodesMax: count,
  episodesMin: count,
  excludedGenres: names,
  excludedTags: names,
  format: choices(["TV", "TV_SHORT", "MOVIE", "SPECIAL", "OVA", "ONA", "MUSIC"]),
  genres: names,
  page: t.Optional(t.Integer({ maximum: 1000, minimum: 1 })),
  search: t.Optional(t.String({ maxLength: 200 })),
  season: choices(["WINTER", "SPRING", "SUMMER", "FALL"]),
  sort: choices(["title", "popularity", "score", "trending", "favourites", "added", "released"]),
  source: choices([
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
  ]),
  streamingOn: t.Optional(t.Integer({ minimum: 1 })),
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
export function catalogVariables(filters: AniListCatalogFilters) {
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
    format: filters.format,
    genre_in: filters.genres?.length ? filters.genres : undefined,
    genre_not_in: filters.excludedGenres?.length ? filters.excludedGenres : undefined,
    isLicensed:
      filters.doujin && filters.doujin !== "any" ? filters.doujin === "exclude" : undefined,
    licensedById: filters.streamingOn,
    page: filters.page ?? 1,
    search: filters.search?.trim() || undefined,
    season: filters.season,
    seasonYear: filters.year,
    sort: [...new Set([mediaSort[filters.sort ?? "trending"], "ID_DESC"])],
    source: filters.source,
    startDate_greater:
      filters.yearMin === undefined ? undefined : (filters.yearMin - 1) * 10_000 + 1231,
    startDate_lesser:
      filters.yearMax === undefined ? undefined : (filters.yearMax + 1) * 10_000 + 101,
    status: filters.airingStatus,
    tag_in: filters.tags?.length ? filters.tags : undefined,
    tag_not_in: filters.excludedTags?.length ? filters.excludedTags : undefined,
  };
}
export const mediaFields = `id title { romaji english native userPreferred } synonyms siteUrl coverImage { extraLarge large }
  bannerImage episodes format genres season seasonYear status(version: 2) averageScore trending popularity favourites
  duration countryOfOrigin source(version: 3) isLicensed isAdult tags { name rank isAdult }
  externalLinks { siteId type isDisabled } startDate { year month day } endDate { year month day } nextAiringEpisode { episode airingAt } studios(isMain: true) { nodes { name } }`;
export const catalogQuery = `query($page: Int!, $sort: [MediaSort], $search: String, $genre_in: [String], $genre_not_in: [String],
  $tag_in: [String], $tag_not_in: [String], $seasonYear: Int, $season: MediaSeason, $format: MediaFormat,
  $status: MediaStatus, $licensedById: Int, $countryOfOrigin: CountryCode, $source: MediaSource,
  $startDate_greater: FuzzyDateInt, $startDate_lesser: FuzzyDateInt, $episodes_greater: Int, $episodes_lesser: Int,
  $duration_greater: Int, $duration_lesser: Int, $isLicensed: Boolean) {
  Page(page: $page, perPage: 30) { pageInfo { currentPage hasNextPage }
    media(type: ANIME, isAdult: false, sort: $sort, search: $search, genre_in: $genre_in, genre_not_in: $genre_not_in,
      tag_in: $tag_in, tag_not_in: $tag_not_in, seasonYear: $seasonYear, season: $season, format: $format,
      status: $status, licensedById: $licensedById, countryOfOrigin: $countryOfOrigin, source: $source,
      startDate_greater: $startDate_greater, startDate_lesser: $startDate_lesser,
      episodes_greater: $episodes_greater, episodes_lesser: $episodes_lesser,
      duration_greater: $duration_greater, duration_lesser: $duration_lesser, isLicensed: $isLicensed) { ${mediaFields} }
  }
}`;
export const catalogOptionsQuery = `query { GenreCollection MediaTagCollection { name category isAdult }
  ExternalLinkSourceCollection(type: STREAMING, mediaType: ANIME) { id site type isDisabled } }`;

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
    studios: media.studios?.nodes.map((studio) => studio.name) ?? [],
    tags: media.tags ?? [],
    trending: media.trending ?? null,
  };
}
export function catalogMedia(media: CatalogMedia): AniListMedia {
  const aliases = [
    ...new Set(
      [
        media.title.romaji,
        media.title.english,
        media.title.native,
        media.title.userPreferred,
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
    genres: media.genres ?? [],
    mediaId: media.id,
    season: ["WINTER", "SPRING", "SUMMER", "FALL"].includes(media.season ?? "")
      ? (media.season as AniListMedia["season"])
      : null,
    seasonYear: media.seasonYear ?? null,
    siteUrl: media.siteUrl ?? null,
    startDate: media.startDate?.year
      ? media.startDate.year * 10_000 +
        (media.startDate.month ?? 0) * 100 +
        (media.startDate.day ?? 0)
      : null,
    streamingOn: (media.externalLinks ?? []).flatMap((link) =>
      link.type === "STREAMING" && !link.isDisabled && link.siteId !== null ? [link.siteId] : []
    ),
    title: aliases[0] ?? `Anime ${media.id}`,
  };
}
