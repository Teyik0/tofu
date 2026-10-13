import { interpretLocally, localMatch } from "@tofu/plugins/automation-rules";
import { parseDiscovery } from "@tofu/plugins/discovery-query";
import type {
  AniListEntry,
  AniListMedia,
  AniListReleaseSearchPlan,
  AutomationPreferences,
  FeedRelease,
} from "@tofu/plugins/domain";
import { normalizeTitle } from "@tofu/plugins/title";

const partNumber = /\bpart\s*(\d+)\b/i;
const partSuffix = /\s+part\s*\d+$/i;
const romanSeasonSuffix = /\s+([IVX]+)$/i;
const courPartSuffix = /\s+(?:\(\s*)?(?:part|cour)\s*(\d+)\s*\)?$/i;
const subtitleSeparator = /:\s+/;
const romanSeasons = [
  "I",
  "II",
  "III",
  "IV",
  "V",
  "VI",
  "VII",
  "VIII",
  "IX",
  "X",
  "XI",
  "XII",
  "XIII",
  "XIV",
  "XV",
  "XVI",
  "XVII",
  "XVIII",
  "XIX",
  "XX",
];

export function animeSeriesTitle(title: string, season: number | null) {
  const parsed = parseDiscovery(title);
  const series = parsed.season === season ? parsed.title : title;
  const roman = series.match(romanSeasonSuffix);
  if (
    season !== null &&
    roman?.[1] &&
    romanSeasons.indexOf(roman[1].toUpperCase()) + 1 === season
  ) {
    return series.slice(0, roman.index).trim();
  }
  return series;
}

export function animeSearchPlan(
  entry: AniListMedia,
  seriesTitles: string[],
  season: number | null,
  part: number | null
): AniListReleaseSearchPlan {
  const names = [...new Set(seriesTitles)];
  const requestedPart = part ?? 1;
  return {
    entry: {
      ...entry,
      aliases: [
        ...new Set([
          ...entry.aliases,
          ...names.map(
            (title) =>
              `${title}${season ? ` Season ${season}` : ""}${requestedPart > 1 ? ` Part ${requestedPart}` : ""}`
          ),
        ]),
      ],
      // Search metadata is ephemeral: catalogue titles and user data remain intact.
      title:
        requestedPart > 1 && !partNumber.test(entry.title)
          ? `${entry.title} Part ${requestedPart}`
          : entry.title,
    },
    part,
    season,
    seriesTitles: names,
    titles: names.map((title) => `${title}${season ? ` S${String(season).padStart(2, "0")}` : ""}`),
    warning: null,
  };
}

export function localAnimeSearch(entry: AniListMedia) {
  const aliases = [
    ...new Map(
      [entry.title, ...entry.aliases].map((title) => [normalizeTitle(title), title])
    ).values(),
  ];
  const part = aliases.map((title) => title.match(courPartSuffix)?.[1]).find(Boolean);
  const withoutParts = aliases.map((title) => title.replace(courPartSuffix, "").trim());
  const explicitSeason = withoutParts
    .map((title) => parseDiscovery(title).season)
    .find((candidate) => candidate !== null);
  const romanVotes = withoutParts.map((title) => {
    const roman = title.match(romanSeasonSuffix)?.[1];
    return roman ? romanSeasons.indexOf(roman.toUpperCase()) + 1 : 0;
  });
  // Require agreement between distinct aliases before interpreting a Roman numeral as a season.
  const romanSeason = romanVotes.find(
    (candidate) => candidate > 1 && romanVotes.filter((vote) => vote === candidate).length > 1
  );
  const season = explicitSeason ?? romanSeason ?? null;
  const titles = withoutParts.slice(0, 2).map((title) => {
    const series = animeSeriesTitle(title, season);
    // Short subtitles may identify a different work; only shorten verbose catalogue titles.
    return series.length > 80 ? series.split(subtitleSeparator)[0]?.trim() || series : series;
  });
  return animeSearchPlan(entry, titles, season, part ? Number(part) : null);
}

export function animeEpisodeOffset(entry: AniListMedia, library: AniListEntry[]) {
  const part = Number(entry.title.match(partNumber)?.[1] ?? 1);
  let offset = 0;
  const bases = new Set(
    entry.aliases.map((alias) => normalizeTitle(alias.replace(partSuffix, "")))
  );
  for (let previous = 1; previous < part; previous += 1) {
    const predecessor = library.find(
      (candidate) =>
        candidate.mediaId !== entry.mediaId &&
        Number(candidate.title.match(partNumber)?.[1] ?? 1) === previous &&
        candidate.aliases.some((alias) => bases.has(normalizeTitle(alias.replace(partSuffix, ""))))
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

export function animeQueries(
  entry: AniListMedia,
  preferences: AutomationPreferences,
  searchTitles?: string[]
) {
  const titles = searchTitles ?? [...new Set([entry.title, ...entry.aliases])].slice(0, 2);
  return preferences.languages.length
    ? titles.flatMap((title) => preferences.languages.map((language) => `${title} ${language}`))
    : titles;
}
