import { Context, Effect, Exit, Layer, Result, Schema, Scope } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ElysiaStatus, problem } from "elysia";
import parseTorrent from "parse-torrent";
import { automationReleases } from "../../../db/schema";
import { Database } from "../../lib/database-layer";
import { normalizeTitle } from "../../lib/title";
import type { JevService } from "../jev/service";
import {
  discoveryMatchQuestions,
  discoveryTitleQuestions,
  Jev,
  safeReleaseState,
} from "../jev/service";
import type { SourcePluginId } from "../plugins/model";
import { publicRelease } from "../plugins/releases";
import type { PluginEndpoints, PluginsService } from "../plugins/service";
import { Plugins, pluginEndpoints } from "../plugins/service";
import { TorrentClient } from "../torrents/layer";
import type { EnginePort } from "../torrents/service";
import type { DiscoveryResult, DiscoverySearch, FeedRelease } from "./model";
import { decodeRelease } from "./persistence";
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

const animeTitleSchema = Schema.Struct({
  id: Schema.Number,
  synonyms: Schema.Array(Schema.String).pipe(Schema.mutable),
  title: Schema.Struct({
    english: Schema.NullOr(Schema.String),
    native: Schema.NullOr(Schema.String),
    romaji: Schema.NullOr(Schema.String),
  }),
});
type AnimeTitle = typeof animeTitleSchema.Type;
const decodeCatalogue = HttpClientResponse.schemaBodyJson(
  Schema.Struct({
    data: Schema.Struct({
      Page: Schema.Struct({ media: Schema.Array(animeTitleSchema).pipe(Schema.mutable) }),
    }),
    errors: Schema.optional(Schema.Array(Schema.Struct({ message: Schema.String }))),
  })
);

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

const make = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const httpScope = yield* Scope.fork(yield* Effect.scope);
  const db = yield* Database;
  const plugins = yield* Plugins;
  const jev = yield* Jev;
  const engine = yield* TorrentClient;
  const options: DiscoveryOptions = { endpoints: pluginEndpoints, engine, jev, plugins };
  const serviceDb = db;
  const serviceOptions = options;

  const serviceLifecycle: { closed: boolean } = { closed: false };
  const serviceReleases = new Map<string, FeedRelease>();
  const serviceAdditions = new Map<string, ReturnType<typeof serviceDownloadRelease>>();
  const serviceCache = new Map<string, { expires: number; media: AnimeTitle[] }>();
  function serviceCachedReleases() {
    return structuredClone([...serviceReleases.values()]);
  }
  function serviceStoreRelease(release: FeedRelease) {
    const value = JSON.stringify(release);
    serviceDb
      .insert(automationReleases)
      .values({ id: `${release.sourceId}:${release.id}`, value })
      .onConflictDoUpdate({ set: { value }, target: automationReleases.id })
      .run();
  }
  const serviceSearch = Effect.fn("Discovery.search")(function* (
    query: string,
    sources: SourcePluginId[]
  ) {
    const result: DiscoveryResult = { errors: [], releases: [] };
    yield* Effect.forEach(
      [...new Set(sources)],
      (sourceId) =>
        Effect.gen(function* () {
          const releases = yield* serviceOptions.plugins.fetchSource(sourceId, query);
          if (releases instanceof ElysiaStatus) {
            if (!serviceOptions.plugins.plugin(sourceId).enabled || serviceLifecycle.closed) {
              return;
            }
            const message = releases.response.detail;
            result.errors.push({ message, sourceId });
            serviceOptions.plugins.recordFailure(sourceId, message);
            return;
          }
          result.releases.push(...releases);
        }),
      { concurrency: "unbounded", discard: true }
    );
    if (serviceLifecycle.closed) {
      return { errors: [], releases: [] };
    }
    for (const release of result.releases) {
      const key = `${release.sourceId}:${release.id}`;
      serviceReleases.set(key, release);
      serviceStoreRelease(release);
    }
    return result;
  });
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceDiscover = Effect.fn("Discovery.discover")(function* (
    query: string,
    sources: SourcePluginId[] | undefined
  ) {
    const known = serviceOptions.plugins.sourceIds();
    if (sources?.some((id) => !known.includes(id))) {
      return problem(404, { detail: "Unknown plugin" });
    }
    const selected: SourcePluginId[] = sources ?? known;
    const active = [...new Set(selected)].filter((id) => serviceOptions.plugins.plugin(id).enabled);
    const currentJev = serviceOptions.plugins.plugin("jev");
    if (!(currentJev?.enabled && currentJev.apiKey)) {
      const search = classicDiscovery(query);
      if (!(search.title && active.length) || serviceLifecycle.closed) {
        return { errors: [], releases: [], search };
      }
      const result = yield* serviceSearch(query, active);
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
    if (!(search.title && active.length) || serviceLifecycle.closed) {
      return { errors: [], releases: [], search };
    }
    const interpretation = discoveryTitleQuestions(search.title);
    const interpreted = yield* serviceOptions.jev.evaluate({ query }, interpretation.questions);
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
    yield* serviceResolve(search, serviceOptions.endpoints.anilist ?? "https://graphql.anilist.co");
    if (!search.queries.length) {
      search.queries = [search.title];
    }
    const result = yield* collectSourceQueries({
      accept: (release) => discoveryCandidate(search, release),
      active: (source) => !serviceLifecycle.closed && serviceOptions.plugins.plugin(source).enabled,
      enough: () => Effect.succeed(false),
      queries: (source) => (source === "tsundere" ? [search.title] : search.queries),
      search: (variant, source) => serviceSearch(variant, [source]),
      sources: active,
    });
    const candidates = uniqueReleases(result.releases);
    const ranked = semantic
      ? yield* serviceRank(query, search, candidates, (release) =>
          matchesDiscovery(search, release)
        )
      : candidates.filter((release) => matchesDiscovery(search, release));
    return {
      errors: result.errors,
      releases: ranked
        .filter(
          (release) =>
            !serviceLifecycle.closed && serviceOptions.plugins.plugin(release.sourceId).enabled
        )
        .map((release) => publicRelease(release)),
      search,
    };
  });
  const serviceRank = Effect.fn("Discovery.rank")(function* (
    query: string,
    search: DiscoverySearch,
    releases: FeedRelease[],
    locallyMatches: (release: FeedRelease) => boolean
  ) {
    const ranked: { probability: number; release: FeedRelease }[] = [];
    for (let offset = 0; offset < releases.length; offset += 20) {
      if (serviceLifecycle.closed) {
        return [];
      }
      const batch = releases.slice(offset, offset + 20);
      // bound model requests and respect the daily budget.
      const result = yield* serviceOptions.jev.evaluate(
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
  });
  const serviceAddRelease = Effect.fn("Discovery.addRelease")(function* (
    sourceId: SourcePluginId,
    id: string,
    destinationId: string,
    paused: boolean,
    allowed?: () => boolean
  ) {
    const release = serviceReleases.get(`${sourceId}:${id}`);
    if (!release) {
      return problem(404, { detail: "Search for this release before adding it" });
    }
    const key = release.infoHash ?? `${sourceId}:${id}`;
    const pending = serviceAdditions.get(key);
    if (pending) {
      return yield* pending;
    }
    const task = yield* Effect.cached(
      serviceDownloadRelease(release, destinationId, paused, allowed).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (serviceAdditions.get(key) === task) {
              serviceAdditions.delete(key);
            }
          })
        )
      )
    );
    serviceAdditions.set(key, task);
    return yield* task;
  });
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceDownloadRelease = Effect.fn("Discovery.downloadRelease")(function* (
    release: FeedRelease,
    destinationId: string,
    paused: boolean,
    allowed: (() => boolean) | undefined
  ) {
    if (!serviceOptions.plugins.plugin(release.sourceId).enabled || serviceLifecycle.closed) {
      return problem(409, { detail: "Plugin disabled" });
    }
    let input: string | Uint8Array = release.downloadUrl;
    if (!input.startsWith("magnet:")) {
      const file = yield* serviceOptions.plugins.downloadFile(release);
      if (file instanceof ElysiaStatus) {
        return file;
      }
      input = file;
    }
    const parsedTorrent = yield* Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => parseTorrent(input),
      })
    );
    if (Result.isFailure(parsedTorrent)) {
      return problem(400, { detail: "Invalid torrent file" });
    }
    const parsed = parsedTorrent.success;
    if (parsed.infoHash && release.infoHash !== parsed.infoHash) {
      release.infoHash = parsed.infoHash;
      serviceStoreRelease(release);
    }
    if (serviceLifecycle.closed || !serviceOptions.plugins.plugin(release.sourceId).enabled) {
      return problem(409, { detail: "Plugin disabled" });
    }
    if (allowed && !allowed()) {
      return problem(409, { detail: "Automation changed or release ignored" });
    }
    const existing = serviceOptions.engine
      .snapshot(null, false)
      .torrents.find((torrent) => torrent.id === parsed.infoHash);
    if (existing) {
      return { id: existing.id };
    }
    return yield* Effect.promise(() =>
      serviceOptions.engine.call("add", [input, { destinationId, paused }])
    );
  });
  const serviceResolve = Effect.fn("Discovery.resolve")(function* (
    search: DiscoverySearch,
    endpoint: string
  ) {
    const media = yield* serviceMedia(search.title, endpoint);
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
  });
  const serviceTitleAliases = Effect.fn("Discovery.titleAliases")(function* (title: string) {
    const media = yield* serviceMedia(
      title,
      serviceOptions.endpoints.anilist ?? "https://graphql.anilist.co"
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
  });
  const serviceMedia = Effect.fn("Discovery.media")(function* (title: string, endpoint: string) {
    const key = normalizeTitle(title);
    const cached = serviceCache.get(key);
    if (cached && cached.expires > Date.now()) {
      return cached.media;
    }
    const requestScope = yield* Effect.acquireRelease(Scope.fork(httpScope), (owned, exit) =>
      Scope.close(owned, exit)
    );
    const fetched = yield* Effect.result(
      http
        .execute(
          HttpClientRequest.post(endpoint).pipe(
            HttpClientRequest.bodyJsonUnsafe({ query: catalogQuery, variables: { search: title } })
          )
        )
        .pipe(Scope.provide(requestScope), Effect.timeout(5000))
    );
    if (Result.isFailure(fetched)) {
      return problem(502, { detail: "Catalogue unavailable" });
    }
    const response = fetched.success;
    if (response.status < 200 || response.status >= 300) {
      return problem(502, { detail: "Catalogue unavailable" });
    }
    const decoded = yield* Effect.result(decodeCatalogue(response).pipe(Effect.timeout(5000)));
    if (Result.isFailure(decoded)) {
      return problem(502, { detail: "Invalid catalogue" });
    }
    const result = decoded.success;
    const { media } = result.data.Page;
    if (result.errors?.length) {
      return problem(502, { detail: "Invalid catalogue" });
    }
    if (serviceCache.size >= 100) {
      serviceCache.clear();
    }
    serviceCache.set(key, { expires: Date.now() + 3_600_000, media });
    return media;
  }, Effect.scoped);
  const serviceClose = Effect.fn("Discovery.close")(function* () {
    if (serviceLifecycle.closed) {
      return;
    }
    serviceLifecycle.closed = true;
    yield* Scope.close(httpScope, Exit.void);
    serviceCache.clear();
    yield* Effect.all([...serviceAdditions.values()].map(Effect.exit), {
      concurrency: "unbounded",
    });
  });
  for (const row of serviceDb.select().from(automationReleases).all()) {
    const release = decodeRelease(row.value);
    serviceReleases.set(`${release.sourceId}:${release.id}`, release);
  }
  yield* Effect.addFinalizer(() => serviceClose());
  return {
    addRelease: serviceAddRelease,
    cachedReleases: serviceCachedReleases,
    close: serviceClose,
    discover: serviceDiscover,
    rank: serviceRank,
    search: serviceSearch,
    titleAliases: serviceTitleAliases,
  };
});

export type DiscoveryService = Discovery["Service"];
export class Discovery extends Context.Service<
  Discovery,
  {
    readonly cachedReleases: () => FeedRelease[];
    readonly search: (query: string, sources: SourcePluginId[]) => Effect.Effect<DiscoveryResult>;
    readonly discover: (
      query: string,
      sources: SourcePluginId[] | undefined
    ) => Effect.Effect<
      | ReturnType<typeof problem<404, { readonly detail: "Unknown plugin" }>>
      | {
          releases: FeedRelease[];
          search: DiscoverySearch;
          errors: { sourceId: SourcePluginId; message: string }[];
        }
    >;
    readonly rank: (
      query: string,
      search: DiscoverySearch,
      releases: FeedRelease[],
      locallyMatches: (release: FeedRelease) => boolean
    ) => Effect.Effect<FeedRelease[]>;
    readonly addRelease: (
      sourceId: SourcePluginId,
      id: string,
      destinationId: string,
      paused: boolean,
      allowed?: () => boolean
    ) => Effect.Effect<
      | ReturnType<
          typeof problem<404, { readonly detail: "Search for this release before adding it" }>
        >
      | ReturnType<typeof problem<502, { readonly detail: "Unable to download the torrent file" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Torrent file too large" }>>
      | ReturnType<
          typeof problem<502, { readonly detail: `Torrent file unavailable (HTTP ${number})` }>
        >
      | ReturnType<typeof problem<400, { readonly detail: "Invalid torrent file" }>>
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: `The torrent file is inaccessible (HTTP ${number})` }
          >
        >
      | ReturnType<typeof problem<400, { readonly detail: "The torrent file is too large" }>>
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Invalid magnet link or .torrent file (BitTorrent v1 required)" }
          >
        >
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Trackers must use valid HTTP, HTTPS, UDP, or WebSocket URLs" }
          >
        >
      | ReturnType<typeof problem<404, { readonly detail: "Tab not found" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "The download folder must be an absolute path" }>
        >
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "The torrent contains an unsafe or inaccessible file path" }
          >
        >
      | ReturnType<
          typeof problem<400, { readonly detail: "File path outside the download folder" }>
        >
      | { id: string }
      | ReturnType<typeof problem<503, { readonly detail: "The worker is unavailable" }>>
      | ReturnType<typeof problem<503, { detail: string }>>
    >;
    readonly titleAliases: (title: string) => Effect.Effect<string[]>;
    readonly close: () => Effect.Effect<void>;
  }
>()("tofu/discovery") {}
export const discoveryLayer = Layer.effect(Discovery, make);

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
