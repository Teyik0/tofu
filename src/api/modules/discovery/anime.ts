import type {
  AniListEntry,
  AniListMedia,
  AutomationPreferences,
  FeedRelease,
} from "../../../types";
import { interpretLocally, localMatch, normalizeTitle } from "../automation/rules";
import { parseDiscovery } from "./service";

const partNumber = /\bpart\s*(\d+)\b/i;
const partSuffix = /\s+part\s*\d+$/i;

export function animeEpisodeOffset(entry: AniListMedia, library: AniListEntry[]) {
  const part = Number(entry.title.match(partNumber)?.[1] ?? 1);
  let offset = 0;
  const bases = entry.aliases.map((alias) => normalizeTitle(alias.replace(partSuffix, "")));
  for (let previous = 1; previous < part; previous += 1) {
    const predecessor = library.find(
      (candidate) =>
        candidate.mediaId !== entry.mediaId &&
        Number(candidate.title.match(partNumber)?.[1] ?? 1) === previous &&
        candidate.aliases.some((alias) =>
          bases.includes(normalizeTitle(alias.replace(partSuffix, "")))
        )
    );
    if (!predecessor?.episodes) {
      return null;
    }
    offset += predecessor.episodes;
  }
  return offset;
}

export function animeEpisodeRelease(
  entry: AniListMedia,
  offset: number | null,
  release: FeedRelease
): FeedRelease | null {
  if (
    release.sourceEpisode !== undefined ||
    !offset ||
    release.episode === null ||
    release.pack ||
    partNumber.test(release.workTitle)
  ) {
    return release;
  }
  const work = normalizeTitle(release.workTitle);
  const continuous = entry.aliases.some((alias) => {
    const base = alias.replace(partSuffix, "");
    const parsed = parseDiscovery(base);
    return (
      normalizeTitle(base) === work ||
      (parsed.season !== null &&
        parsed.season === release.season &&
        normalizeTitle(parsed.title) === work)
    );
  });
  if (!continuous) {
    return release;
  }
  const episode = release.episode - offset;
  return episode > 0 && (entry.episodes === null || episode <= entry.episodes)
    ? { ...release, episode, sourceEpisode: release.episode }
    : null;
}

export function animeReleaseCandidate(
  entry: AniListMedia,
  preferences: AutomationPreferences,
  release: FeedRelease
) {
  const aliases = [entry.title, ...entry.aliases];
  const requestedSeason =
    aliases.map((title) => parseDiscovery(title).season).find((season) => season !== null) ?? null;
  const releaseSeason = release.season ?? parseDiscovery(release.workTitle).season;
  if (requestedSeason !== null && releaseSeason !== null && requestedSeason !== releaseSeason) {
    return false;
  }
  const requestedPart = Number(entry.title.match(partNumber)?.[1] ?? 1);
  const releasePart = Number(
    release.title.match(partNumber)?.[1] ??
      (release.sourceEpisode === undefined ? 1 : requestedPart)
  );
  if (
    releasePart !== requestedPart ||
    (entry.episodes !== null && release.episode !== null && release.episode > entry.episodes)
  ) {
    return false;
  }
  return !(
    (preferences.languages.length &&
      release.language !== null &&
      !preferences.languages.includes(release.language)) ||
    (preferences.resolutions.length &&
      release.resolution !== null &&
      !preferences.resolutions.includes(release.resolution)) ||
    (preferences.codecs.length &&
      release.codec !== null &&
      !preferences.codecs.includes(release.codec))
  );
}

export function matchesAnimeRelease(
  entry: AniListMedia,
  preferences: AutomationPreferences,
  release: FeedRelease
) {
  if (!animeReleaseCandidate(entry, preferences, release)) {
    return false;
  }
  const aliases = [entry.title, ...entry.aliases];
  const releaseSeason = release.season ?? parseDiscovery(release.workTitle).season;
  const work = normalizeTitle(release.workTitle);
  const identity = aliases.some((alias) => {
    if (normalizeTitle(alias) === work) {
      return true;
    }
    const parsed = parseDiscovery(
      release.sourceEpisode === undefined ? alias : alias.replace(partSuffix, "")
    );
    return (
      parsed.season !== null &&
      parsed.season === releaseSeason &&
      normalizeTitle(parsed.title) === work
    );
  });
  const matcher = {
    ...interpretLocally(entry.title, "default", preferences),
    aliases: [release.workTitle],
    excludePacks: false,
    season: null,
  };
  return identity && localMatch(matcher, release) === null;
}

export function animeQueries(entry: AniListMedia, preferences: AutomationPreferences) {
  const titles = [...new Set([entry.title, ...entry.aliases])].slice(0, 2);
  return preferences.languages.length
    ? titles.flatMap((title) => preferences.languages.map((language) => `${title} ${language}`))
    : titles;
}
