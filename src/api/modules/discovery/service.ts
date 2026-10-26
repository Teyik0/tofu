import { Context, Effect, Layer, Result } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ElysiaStatus, problem } from "elysia";
import parseTorrent from "parse-torrent";
import { automationReleases } from "../../../db/schema";
import { Database } from "../../lib/db";
import { normalizeTitle } from "../../lib/title";
import type { SourcePluginId } from "../plugins/model";
import { publicRelease } from "../plugins/releases";
import type { PluginsService } from "../plugins/service";
import { Plugins } from "../plugins/service";
import { TorrentClient } from "../torrents/layer";
import type { EnginePort } from "../torrents/service";
import { type AnimeMapping, animeMappingSchema } from "./anime-mapping";
import type { DiscoveryResult, DiscoverySearch, FeedRelease } from "./model";
import { decodeRelease } from "./persistence";

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

interface DiscoveryOptions {
  engine: EnginePort;
  plugins: PluginsService;
}

const make = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const decodeMapping = HttpClientResponse.schemaBodyJson(animeMappingSchema);
  const db = yield* Database;
  const plugins = yield* Plugins;
  const engine = yield* TorrentClient;
  const options: DiscoveryOptions = { engine, plugins };
  const serviceDb = db;
  const serviceOptions = options;

  const serviceLifecycle: { closed: boolean } = { closed: false };
  const serviceReleases = new Map<string, FeedRelease>();
  const serviceMappings = new Map<
    number,
    { expires: number; operation: Effect.Effect<AnimeMapping | null> }
  >();
  const serviceAnimeMapping = Effect.fn("Discovery.animeMapping")(function* (mediaId: number) {
    const cached = serviceMappings.get(mediaId);
    if (cached && cached.expires > Date.now()) {
      return yield* cached.operation;
    }
    const operation = yield* Effect.cached(
      Effect.gen(function* () {
        const fetched = yield* Effect.result(
          Effect.gen(function* () {
            const response = yield* http.get(`https://api.ani.zip/mappings?anilist_id=${mediaId}`);
            if (response.status !== 200) {
              return null;
            }
            const mapping = yield* decodeMapping(response);
            return mapping.mappings.anilist_id === mediaId ? mapping : null;
          }).pipe(Effect.scoped, Effect.timeout(5000))
        );
        const mapping = Result.isSuccess(fetched) ? fetched.success : null;
        const entry = serviceMappings.get(mediaId);
        if (entry) {
          entry.expires = Date.now() + (mapping ? 3_600_000 : 60_000);
        }
        return mapping;
      })
    );
    if (serviceMappings.size >= 100) {
      serviceMappings.clear();
    }
    serviceMappings.set(mediaId, { expires: Date.now() + 5000, operation });
    return yield* operation;
  });
  const serviceAdditions = new Map<string, ReturnType<typeof serviceDownloadRelease>>();
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
    sources: SourcePluginId[],
    cachedSearch = false
  ) {
    const result: DiscoveryResult = { errors: [], releases: [] };
    yield* Effect.forEach(
      [...new Set(sources)],
      (sourceId) =>
        Effect.gen(function* () {
          const releases = yield* serviceOptions.plugins.fetchSource(sourceId, query, cachedSearch);
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
  const serviceClose = Effect.fn("Discovery.close")(function* () {
    if (serviceLifecycle.closed) {
      return;
    }
    serviceLifecycle.closed = true;
    serviceMappings.clear();
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
    animeMapping: serviceAnimeMapping,
    cachedReleases: serviceCachedReleases,
    close: serviceClose,
    discover: serviceDiscover,
    search: serviceSearch,
  };
});

export type DiscoveryService = Discovery["Service"];
export class Discovery extends Context.Service<
  Discovery,
  {
    readonly animeMapping: (mediaId: number) => Effect.Effect<AnimeMapping | null>;
    readonly cachedReleases: () => FeedRelease[];
    readonly search: (
      query: string,
      sources: SourcePluginId[],
      cachedSearch?: boolean
    ) => Effect.Effect<DiscoveryResult>;
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
    readonly close: () => Effect.Effect<void>;
  }
>()("tofu/discovery") {}
export const discoveryLayer = Layer.effect(Discovery, make);
