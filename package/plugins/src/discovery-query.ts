import type { DiscoverySearch, FeedRelease } from "./domain";
import { normalizeTitle } from "./title";

const combinedEpisode = /\bs(\d{1,3})\s*e(\d{1,4})\b/gi;
const seasonNumber = /\b(?:saison|season|s)\s*(\d{1,3})\b|\b(\d{1,3})(?:st|nd|rd|th)\s+season\b/gi;
const episodeNumber = /(?<![\p{L}\p{N}])(?:[eé]pisode|[eé]p|e)\s*(\d{1,4})\b/giu;
const requestPrefix =
  /^(?:cherche(?:r)?|recherche(?:r)?|trouve(?:r)?|search|find)\s+(?:(?:les?\s+)?(?:[eé]pisodes?\s+)?(?:de\s+|d['’]))?/i;
const spaces = /\s+/g;

export function classicDiscovery(query: string): DiscoverySearch {
  return {
    aliases: [],
    episode: null,
    queries: [query],
    resolved: false,
    season: null,
    title: query.trim(),
    warning: null,
  };
}

export function matchesClassicDiscovery(query: string, release: FeedRelease) {
  const title = ` ${normalizeTitle(release.title)} `;
  const terms = normalizeTitle(query).split(" ").filter(Boolean);
  return terms.length > 0 && terms.every((term) => title.includes(` ${term} `));
}

export function parseDiscovery(query: string): DiscoverySearch {
  let season: number | null = null;
  let episode: number | null = null;
  const title = query
    .replace(combinedEpisode, (_match, s: string, e: string) => {
      season = Number(s);
      episode = Number(e);
      return " ";
    })
    .replace(seasonNumber, (_match, first: string | undefined, second: string | undefined) => {
      season = Number(first ?? second);
      return " ";
    })
    .replace(episodeNumber, (_match, e: string) => {
      episode = Number(e);
      return " ";
    })
    .replace(requestPrefix, "")
    .replace(spaces, " ")
    .trim();
  return {
    aliases: title ? [title] : [],
    episode,
    queries: [],
    resolved: false,
    season,
    title,
    warning: null,
  };
}
