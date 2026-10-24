import { Effect, Result } from "effect";
import { ElysiaStatus, problem } from "elysia";
import parseTorrent from "parse-torrent";
import { automationReleases } from "../../../db/schema";
import type { Database } from "../../lib/database-layer";
import { normalizeTitle } from "../../lib/title";
import type { JevService } from "../jev/service";
import { discoveryMatchQuestions, discoveryTitleQuestions, safeReleaseState } from "../jev/service";
import type { SourcePluginId } from "../plugins/model";
import { publicRelease } from "../plugins/releases";
import type { PluginEndpoints, PluginsService } from "../plugins/service";
import type { EnginePort } from "../torrents/service";
import type { DiscoveryResult, DiscoverySearch, FeedRelease } from "./model";
import { collectSourceQueries, uniqueReleases } from "./sources";

const combinedEpisode = /\bs(\d{1,3})\s*e(\d{1,4})\b/gi;
const seasonNumber = /\b(?:saison|season|s)\s*(\d{1,3})\b|\b(\d{1,3})(?:st|nd|rd|th)\s+season\b/gi;
const episodeNumber = /(?<![\p{L}\p{N}])(?:[eé]pisode|[eé]p|e)\s*(\d{1,4})\b/giu;
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
  const enteredTitle = search.title;
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
    enteredTitle,
    ...canonical.map((title) => `${title}${marker ? ` ${marker}` : ""}`),
    ...seasonal.flatMap((entry) =>
      titles(entry)
        .slice(0, 2)
        .map((title) => `${title}${episode ? ` ${episode}` : ""}`)
    ),
    ...canonical,
  ]).slice(0, 7);
}

interface DiscoveryOptions {
  endpoints: PluginEndpoints;
  engine: EnginePort;
  jev: JevService;
  plugins: PluginsService;
}

export class DiscoveryService {
  private readonly lifecycle: { closed: boolean } = { closed: false };
  private readonly releases = new Map<string, FeedRelease>();
  private readonly additions = new Map<string, ReturnType<DiscoveryService["downloadRelease"]>>();
  private readonly db: Database;
  private readonly options: DiscoveryOptions;
  constructor(db: Database, options: DiscoveryOptions) {
    this.db = db;
    this.options = options;
    for (const row of this.db.select().from(automationReleases).all()) {
      const release = JSON.parse(row.value) as FeedRelease;
      this.releases.set(`${release.sourceId}:${release.id}`, release);
    }
  }
  cachedReleases() {
    return structuredClone([...this.releases.values()]);
  }
  private storeRelease(release: FeedRelease) {
    const value = JSON.stringify(release);
    this.db
      .insert(automationReleases)
      .values({ id: `${release.sourceId}:${release.id}`, value })
      .onConflictDoUpdate({ set: { value }, target: automationReleases.id })
      .run();
  }
  async search(query: string, sources: SourcePluginId[]): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { errors: [], releases: [] };
    await Promise.all(
      [...new Set(sources)].map(async (sourceId) => {
        const releases = await this.options.plugins.fetchSource(sourceId, query);
        if (releases instanceof ElysiaStatus) {
          if (!this.options.plugins.plugin(sourceId).enabled || this.lifecycle.closed) {
            return;
          }
          const message = releases.response.detail;
          result.errors.push({ message, sourceId });
          this.options.plugins.recordFailure(sourceId, message);
          return;
        }
        result.releases.push(...releases);
      })
    );
    if (this.lifecycle.closed) {
      return { errors: [], releases: [] };
    }
    for (const release of result.releases) {
      const key = `${release.sourceId}:${release.id}`;
      this.releases.set(key, release);
      this.storeRelease(release);
    }
    return result;
  }
  async discover(query: string, sources: SourcePluginId[] | undefined) {
    const known = this.options.plugins.sourceIds();
    if (sources?.some((id) => !known.includes(id))) {
      return problem(404, { detail: "Unknown plugin" });
    }
    const selected: SourcePluginId[] = sources ?? known;
    const active = [...new Set(selected)].filter((id) => this.options.plugins.plugin(id).enabled);
    const jev = this.options.plugins.plugin("jev");
    if (!(jev?.enabled && jev.apiKey)) {
      const search = classicDiscovery(query);
      if (!(search.title && active.length) || this.lifecycle.closed) {
        return { errors: [], releases: [], search };
      }
      const result = await this.search(query, active);
      return {
        ...result,
        releases: result.releases
          .filter(
            (release) => release.sourceId !== "tsundere" || matchesClassicDiscovery(query, release)
          )
          .map((release) => publicRelease(release)),
        search,
      };
    }
    const search = parseDiscovery(query);
    if (!(search.title && active.length) || this.lifecycle.closed) {
      return { errors: [], releases: [], search };
    }
    const interpretation = discoveryTitleQuestions(search.title);
    const interpreted = await this.options.jev.evaluate({ query }, interpretation.questions);
    const semantic = !(interpreted instanceof ElysiaStatus);
    if (semantic) {
      const answer = interpreted?.answers.title;
      const title = interpretation.titles[Number(answer?.choice)];
      if (title && answer?.confidence !== undefined && answer.confidence >= 0.8) {
        search.title = title;
        search.aliases = [title];
      }
    } else {
      search.warning = "Jev interpretation unavailable; searching with the entered title.";
    }
    await this.resolve(search, this.options.endpoints.anilist ?? "https://graphql.anilist.co");
    if (!search.queries.length) {
      search.queries = [search.title];
    }
    const result = await collectSourceQueries({
      accept: (release) => discoveryCandidate(search, release),
      active: (source) => !this.lifecycle.closed && this.options.plugins.plugin(source).enabled,
      enough: () => Promise.resolve(false),
      queries: (source) => (source === "tsundere" ? [search.title] : search.queries),
      search: (variant, source) => this.search(variant, [source]),
      sources: active,
    });
    const candidates = uniqueReleases(result.releases);
    const ranked = semantic
      ? await this.rank(query, search, candidates, (release) => matchesDiscovery(search, release))
      : candidates.filter((release) => matchesDiscovery(search, release));
    return {
      errors: result.errors,
      releases: ranked
        .filter(
          (release) =>
            !this.lifecycle.closed && this.options.plugins.plugin(release.sourceId).enabled
        )
        .map((release) => publicRelease(release)),
      search,
    };
  }

  async rank(
    query: string,
    search: DiscoverySearch,
    releases: FeedRelease[],
    locallyMatches: (release: FeedRelease) => boolean
  ) {
    const ranked: { probability: number; release: FeedRelease }[] = [];
    for (let offset = 0; offset < releases.length; offset += 20) {
      if (this.lifecycle.closed) {
        return [];
      }
      const batch = releases.slice(offset, offset + 20);
      // biome-ignore lint/performance/noAwaitInLoops: bound model requests and respect the daily budget.
      const result = await this.options.jev.evaluate(
        {
          query,
          releases: batch.map(safeReleaseState),
          search: {
            aliases: search.aliases,
            episode: search.episode,
            season: search.season,
            title: search.title,
          },
        },
        discoveryMatchQuestions(batch)
      );
      if (!result || result instanceof ElysiaStatus) {
        search.warning = [
          search.warning,
          "Jev ranking unavailable; showing locally matched releases.",
        ]
          .filter(Boolean)
          .join(" ");
        ranked.push(
          ...releases
            .slice(offset)
            .filter(locallyMatches)
            .map((release) => ({ probability: 0, release }))
        );
        break;
      }
      for (const [index, release] of batch.entries()) {
        const probability = Math.min(
          result.answers[`identity_${index}`]?.noul ?? 0,
          result.answers[`requirements_${index}`]?.noul ?? 0
        );
        // A manual search can show plausible candidates; automated downloads retain their stricter threshold.
        if (probability >= 0.5) {
          ranked.push({ probability, release });
        }
      }
    }
    return ranked
      .sort(
        (a, b) =>
          b.probability - a.probability || (b.release.seeders ?? -1) - (a.release.seeders ?? -1)
      )
      .map(({ release }) => release);
  }
  async addRelease(
    sourceId: SourcePluginId,
    id: string,
    destinationId: string,
    paused: boolean,
    allowed?: () => boolean
  ) {
    const release = this.releases.get(`${sourceId}:${id}`);
    if (!release) {
      return problem(404, { detail: "Search for this release before adding it" });
    }
    const key = release.infoHash ?? `${sourceId}:${id}`;
    const pending = this.additions.get(key);
    if (pending) {
      return pending;
    }
    const task = this.downloadRelease(release, destinationId, paused, allowed);
    this.additions.set(key, task);
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      this.additions.delete(key);
    });
    return await task;
  }
  private async downloadRelease(
    release: FeedRelease,
    destinationId: string,
    paused: boolean,
    allowed: (() => boolean) | undefined
  ) {
    if (!this.options.plugins.plugin(release.sourceId).enabled || this.lifecycle.closed) {
      return problem(409, { detail: "Plugin disabled" });
    }
    let input: string | Uint8Array = release.downloadUrl;
    if (!input.startsWith("magnet:")) {
      const file = await this.options.plugins.downloadFile(release);
      if (file instanceof ElysiaStatus) {
        return file;
      }
      input = file;
    }
    const parsedTorrent = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () => parseTorrent(input),
        })
      )
    );
    if (Result.isFailure(parsedTorrent)) {
      return problem(400, { detail: "Invalid torrent file" });
    }
    const parsed = parsedTorrent.success;
    if (parsed.infoHash && release.infoHash !== parsed.infoHash) {
      release.infoHash = parsed.infoHash;
      this.storeRelease(release);
    }
    if (this.lifecycle.closed || !this.options.plugins.plugin(release.sourceId).enabled) {
      return problem(409, { detail: "Plugin disabled" });
    }
    if (allowed && !allowed()) {
      return problem(409, { detail: "Automation changed or release ignored" });
    }
    const existing = this.options.engine
      .snapshot(null, false)
      .torrents.find((torrent) => torrent.id === parsed.infoHash);
    if (existing) {
      return { id: existing.id };
    }
    return this.options.engine.call("add", [input, { destinationId, paused }]);
  }
  private readonly cache = new Map<string, { expires: number; media: AnimeTitle[] }>();
  private readonly requests = new Set<AbortController>();

  private async resolve(search: DiscoverySearch, endpoint: string) {
    const media = await this.media(search.title, endpoint);
    if (media instanceof ElysiaStatus) {
      search.warning = [
        search.warning,
        "Alternative titles unavailable; searching with the entered title.",
      ]
        .filter(Boolean)
        .join(" ");
      return;
    }
    resolveTitles(search, media);
  }

  async titleAliases(title: string): Promise<string[]> {
    const media = await this.media(
      title,
      this.options.endpoints.anilist ?? "https://graphql.anilist.co"
    );
    if (!(media instanceof ElysiaStatus)) {
      const best = bestTitle(title, media);
      if (best) {
        const canonical = [best.title.romaji, best.title.english].filter(
          (name): name is string => typeof name === "string" && Boolean(name.trim())
        );
        if (canonical.length) {
          return uniqueTitles(canonical);
        }
      }
    }
    return [title];
  }

  private async media(title: string, endpoint: string) {
    const key = normalizeTitle(title);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.media;
    }
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 5000);
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      clearTimeout(timeout);
      this.requests.delete(controller);
    });
    const fetched = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () =>
            fetch(endpoint, {
              body: JSON.stringify({ query: catalogQuery, variables: { search: title } }),
              headers: { "content-type": "application/json" },
              method: "POST",
              signal: controller.signal,
            }),
        })
      )
    );
    if (Result.isFailure(fetched)) {
      return problem(502, { detail: "Catalogue unavailable" });
    }
    const response = fetched.success;
    if (!response.ok) {
      return problem(502, { detail: "Catalogue unavailable" });
    }
    const decoded = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () => response.json(),
        })
      )
    );
    if (Result.isFailure(decoded)) {
      return problem(502, { detail: "Invalid catalogue" });
    }
    const result = decoded.success as {
      data?: { Page?: { media?: AnimeTitle[] } };
      errors?: unknown[];
    } | null;
    const media = result?.data?.Page?.media;
    if (!Array.isArray(media) || result?.errors?.length) {
      return problem(502, { detail: "Invalid catalogue" });
    }
    if (this.cache.size >= 100) {
      this.cache.clear();
    }
    this.cache.set(key, { expires: Date.now() + 3_600_000, media });
    return media;
  }

  async close() {
    if (this.lifecycle.closed) {
      return;
    }
    this.lifecycle.closed = true;
    for (const request of this.requests) {
      request.abort();
    }
    this.cache.clear();
    await Promise.allSettled(this.additions.values());
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

/** Reject known conflicts before semantic ranking, while retaining unparsed evidence for Jev. */
export function discoveryCandidate(search: DiscoverySearch, release: FeedRelease) {
  const season = release.season ?? parseDiscovery(release.workTitle).season;
  return !(
    (search.episode !== null &&
      (release.pack || (release.episode !== null && release.episode !== search.episode))) ||
    (search.season !== null && season !== null && season !== search.season)
  );
}
