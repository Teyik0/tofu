import type { DiscoverySearch, FeedRelease } from "../../../types";
import { normalizeTitle } from "../automation/rules";

const combinedEpisode = /\bs(\d{1,3})\s*e(\d{1,4})\b/gi;
const seasonNumber = /\b(?:saison|season|s)\s*(\d{1,3})\b|\b(\d{1,3})(?:st|nd|rd|th)\s+season\b/gi;
const episodeNumber = /\b(?:[eé]pisode|episode|[eé]p|ep|e)\s*(\d{1,4})\b/gi;
const requestPrefix =
  /^(?:cherche(?:r)?|recherche(?:r)?|trouve(?:r)?|search|find)\s+(?:(?:les?\s+)?(?:[eé]pisodes?\s+)?(?:de\s+|d['’]))?/i;
const spaces = /\s+/g;
const seasonSuffix =
  /\s+(?:(?:season|saison)\s*\d+|\d+(?:st|nd|rd|th)\s+season)(?:\s+part\s*\d+)?$/i;
const catalogQuery = `query($search: String!) {
  Page(perPage: 20) {
    media(search: $search, type: ANIME) {
      id title { english romaji native } synonyms
    }
  }
}`;

interface AnimeTitle {
  id: number;
  synonyms: string[];
  title: { english: string | null; romaji: string | null; native: string | null };
}

function titles(media: AnimeTitle) {
  return [media.title.english, media.title.romaji, media.title.native].filter(
    (title): title is string => typeof title === "string" && Boolean(title.trim())
  );
}

function uniqueTitles(values: string[]) {
  return [...new Map(values.map((title) => [normalizeTitle(title), title])).values()];
}

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

function compactTitle(value: string) {
  return normalizeTitle(value).replaceAll(" ", "");
}

function bestTitle(requestedTitle: string, media: AnimeTitle[]) {
  const requested = compactTitle(requestedTitle);
  const ranked = media
    .map((entry) => {
      const matches = [...titles(entry), ...(entry.synonyms ?? [])]
        .map(compactTitle)
        .filter((title) => title.includes(requested));
      return {
        entry,
        score: matches.length
          ? Math.min(...matches.map((title) => title.length - requested.length))
          : Number.POSITIVE_INFINITY,
      };
    })
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score);
  return ranked[0]?.entry;
}

function resolveTitles(search: DiscoverySearch, media: AnimeTitle[]) {
  const best = bestTitle(search.title, media);
  if (!best) {
    return;
  }
  // Expand the matching series, not similarly named spin-offs returned by AniList.
  const base = titles(best).map((title) => title.replace(seasonSuffix, ""));
  const baseKeys = new Set(base.map(normalizeTitle));
  const family = media.filter((entry) =>
    titles(entry).some((title) => baseKeys.has(normalizeTitle(title.replace(seasonSuffix, ""))))
  );
  const seasonal =
    search.season === null
      ? []
      : family.filter((entry) =>
          titles(entry).some((title) => parseDiscovery(title).season === search.season)
        );
  search.title = base[0] ?? search.title;
  search.aliases = uniqueTitles([
    ...base,
    ...family.flatMap(titles),
    ...(best.synonyms ?? []),
    ...search.aliases,
  ]);
  search.resolved = true;
  const canonical = uniqueTitles(base.slice(0, 2));
  const episode = search.episode === null ? "" : String(search.episode).padStart(2, "0");
  const marker =
    search.season === null
      ? episode
      : `S${String(search.season).padStart(2, "0")}${episode ? `E${episode}` : ""}`;
  search.queries = uniqueTitles([
    ...canonical.map((title) => `${title}${marker ? ` ${marker}` : ""}`),
    ...seasonal.flatMap((entry) =>
      titles(entry)
        .slice(0, 2)
        .map((title) => `${title}${episode ? ` ${episode}` : ""}`)
    ),
    ...canonical,
  ]).slice(0, 6);
}

export class DiscoveryResolver {
  private readonly cache = new Map<string, { expires: number; media: AnimeTitle[] }>();
  private readonly requests = new Set<AbortController>();

  async resolve(search: DiscoverySearch, endpoint: string) {
    try {
      resolveTitles(search, await this.media(search.title, endpoint));
    } catch {
      search.warning = "Alternative titles unavailable; searching with the entered title.";
    }
  }

  async automationTitles(title: string, endpoint: string): Promise<string[]> {
    try {
      const best = bestTitle(title, await this.media(title, endpoint));
      if (best) {
        const canonical = [best.title.romaji, best.title.english].filter(
          (name): name is string => typeof name === "string" && Boolean(name.trim())
        );
        if (canonical.length) {
          return uniqueTitles(canonical);
        }
      }
    } catch {
      // Keep the user's title usable during catalogue outages.
    }
    return [title];
  }

  private async media(title: string, endpoint: string): Promise<AnimeTitle[]> {
    const key = normalizeTitle(title);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.media;
    }
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(endpoint, {
        body: JSON.stringify({ query: catalogQuery, variables: { search: title } }),
        headers: { "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error("Catalogue unavailable");
      }
      const result = (await response.json()) as {
        data?: { Page?: { media?: AnimeTitle[] } };
        errors?: unknown[];
      };
      const media = result.data?.Page?.media;
      if (!Array.isArray(media) || result.errors?.length) {
        throw new Error("Invalid catalogue");
      }
      if (this.cache.size >= 100) {
        this.cache.clear();
      }
      this.cache.set(key, { expires: Date.now() + 3_600_000, media });
      return media;
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }

  close() {
    for (const request of this.requests) {
      request.abort();
    }
    this.cache.clear();
  }
}

export function matchesDiscovery(search: DiscoverySearch, release: FeedRelease) {
  const work = normalizeTitle(release.workTitle);
  const matches = search.aliases.some((title) =>
    search.resolved
      ? work === normalizeTitle(title)
      : ` ${work} `.includes(` ${normalizeTitle(title)} `)
  );
  if (
    !matches ||
    (search.episode !== null && (release.pack || release.episode !== search.episode))
  ) {
    return false;
  }
  const season = release.season ?? parseDiscovery(release.workTitle).season;
  return search.season === null || season === search.season;
}
