import { Schema } from "effect";
import { normalizeTitle } from "../../lib/title";
import type { FeedRelease } from "./model";

const regularEpisode = /^[1-9]\d*$/;
const seasonSuffix =
  /\s+(?:(?:season|saison)\s*\d+|\d+(?:st|nd|rd|th)\s+season)(?:\s+part\s*\d+)?$/i;
const querySeason = /\s+S\d+$/i;
const seasonRange =
  /\b(?:S|Season\s*|Saison\s*)(\d{1,3})\s*[-–+&]\s*(?:S|Season\s*|Saison\s*)?(\d{1,3})\b/i;

const mappedNumber = Schema.optional(
  Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))
);
export const animeMappingSchema = Schema.Struct({
  episodes: Schema.Record(
    Schema.String,
    Schema.Struct({
      absoluteEpisodeNumber: mappedNumber,
      episodeNumber: mappedNumber,
      seasonNumber: mappedNumber,
    })
  ),
  mappings: Schema.Struct({ anilist_id: Schema.Int.check(Schema.isGreaterThan(0)) }),
  titles: Schema.Record(Schema.String, Schema.String),
});
export type AnimeMapping = typeof animeMappingSchema.Type;

interface AnimeIdentity {
  aliases: string[];
  episodes: number | null;
  mediaId: number;
  title: string;
}

/** TVDB coordinates and absolute episode numbers belong to an exact AniList work. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep identity and numbering evidence together before projecting an episode.
export function mappedAnimeRelease(
  entry: AnimeIdentity,
  mapping: AnimeMapping,
  release: FeedRelease
): FeedRelease | null {
  if (
    mapping.mappings.anilist_id !== entry.mediaId ||
    (release.anilistId !== undefined && release.anilistId !== entry.mediaId)
  ) {
    return null;
  }
  if (release.sourceEpisode !== undefined && release.anilistId === entry.mediaId) {
    return release;
  }
  const names = [entry.title, ...entry.aliases, ...Object.values(mapping.titles)];
  const work = normalizeTitle(release.workTitle);
  const exactTitle = names.some((name) => normalizeTitle(name) === work);
  const seriesTitle =
    release.season !== null &&
    names.some((name) => normalizeTitle(name.replace(seasonSuffix, "")) === work);
  const identity = release.anilistId === entry.mediaId;
  const franchiseTitle =
    release.season !== null &&
    names.some((name) => {
      const base = name.split(":")[0]?.trim();
      return (
        base !== name && base !== undefined && base.length >= 3 && normalizeTitle(base) === work
      );
    });
  if (!(identity || exactTitle || seriesTitle || franchiseTitle)) {
    return null;
  }
  const episodes = Object.entries(mapping.episodes)
    .filter(([key]) => regularEpisode.test(key))
    .map(([key, coordinates]) => ({ ...coordinates, episode: Number(key) }))
    .filter((episode) => entry.episodes === null || episode.episode <= entry.episodes);
  const seasons = new Set(
    episodes.flatMap((episode) =>
      episode.seasonNumber && episode.seasonNumber > 0 ? [episode.seasonNumber] : []
    )
  );
  if (release.season !== null && seasons.size === 1 && !seasons.has(release.season)) {
    return null;
  }
  if (release.pack || release.episode === null) {
    const range = release.title.match(seasonRange);
    if (range) {
      const first = Number(range[1]);
      const last = Number(range[2]);
      if (
        last < first ||
        Array.from({ length: last - first + 1 }, (_, index) => first + index).some(
          (season) => !seasons.has(season)
        )
      ) {
        return null;
      }
    }
    return identity || exactTitle ? release : null;
  }
  const number = release.episode;
  let candidates = episodes.filter(
    (episode) =>
      release.season !== null &&
      episode.seasonNumber === release.season &&
      episode.episodeNumber === number
  );
  if (!candidates.length && release.season !== null) {
    candidates = episodes.filter(
      (episode) =>
        episode.seasonNumber === release.season && episode.absoluteEpisodeNumber === number
    );
  }
  if (!candidates.length && (identity || exactTitle)) {
    // Some release groups use S01 plus absolute numbering for a whole continuous series.
    const largestSeasonEpisode = Math.max(
      0,
      ...episodes.map((episode) => episode.episodeNumber ?? 0)
    );
    if (release.season === null || (seasons.size > 1 && number > largestSeasonEpisode)) {
      candidates = episodes.filter((episode) => episode.episode === number);
    }
  }
  if (!candidates.length && release.season === null && identity) {
    candidates = episodes.filter((episode) => episode.absoluteEpisodeNumber === number);
  }
  if (candidates.length > 1) {
    return null;
  }
  const [matched] = candidates;
  if (!matched) {
    // Incomplete mapping data must not invent a coordinate translation.
    return identity || exactTitle ? release : null;
  }
  return { ...release, anilistId: entry.mediaId, episode: matched.episode, sourceEpisode: number };
}

export function mappedAnimeQueries(mapping: AnimeMapping, titles: string[]) {
  const shifted = Object.entries(mapping.episodes).some(
    ([key, episode]) =>
      regularEpisode.test(key) &&
      episode.episodeNumber !== undefined &&
      episode.episodeNumber !== null &&
      Number(key) !== episode.episodeNumber
  );
  const seasons = [
    ...new Set(
      Object.entries(mapping.episodes)
        .filter(([key]) => regularEpisode.test(key))
        .flatMap(([, episode]) =>
          episode.seasonNumber && episode.seasonNumber > 0 ? [episode.seasonNumber] : []
        )
    ),
  ];
  if (seasons.length !== 1) {
    return titles;
  }
  const scoped = titles
    .filter((title) => !querySeason.test(title))
    .map((title) => `${title} S${String(seasons[0]).padStart(2, "0")}`);
  const bases = Object.values(mapping.titles).flatMap((name) => {
    const base = name.split(":")[0]?.trim();
    return base && base !== name && base.length >= 3
      ? [`${base} S${String(seasons[0]).padStart(2, "0")}`]
      : [];
  });
  return [
    ...new Map(
      [...titles, ...(shifted ? bases.slice(0, 2) : scoped)].map((title) => [
        normalizeTitle(title),
        title,
      ])
    ).values(),
  ];
}
