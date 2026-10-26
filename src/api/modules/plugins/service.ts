import { eq } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Result, Schema, Semaphore } from "effect";
import { HttpClient } from "effect/http";
import { ElysiaStatus, problem } from "elysia";
import { automationPlugins } from "../../../db/schema";
import { Database } from "../../lib/db";
import type { FeedRelease } from "../discovery/model";
import { normalizePluginCredential, validatePluginCredential } from "./credentials";
import { parseNyaaHtml, parseRss, parseTsundere } from "./feeds";
import type { PluginId, PluginState, SourcePluginId, StoredPlugin } from "./model";

export const pluginEndpoints = {
  c411: "https://c411.org/api/torznab",
  nyaa: "https://nyaa.si/",
  tsundere: "https://tsundere.to/api/v1/feed.json",
};
export type PluginEndpoints = typeof pluginEndpoints & { anilist?: string; anilistToken?: string };
const namespacedSourceId = /^[a-z0-9][a-z0-9._-]*\.[a-z0-9._-]+$/;
const feedFailure = /^(Source unavailable|Invalid RSS feed|RSS feed missing|Invalid JSON feed)/;
const decodeStoredPlugin = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      apiKey: Schema.optional(Schema.String),
      callsDay: Schema.optional(Schema.String),
      callsToday: Schema.optional(Schema.Number),
      checkedAt: Schema.optional(Schema.NullOr(Schema.Number)),
      dailyLimit: Schema.optional(Schema.Number),
      description: Schema.optional(Schema.String),
      enabled: Schema.optional(Schema.Boolean),
      error: Schema.optional(Schema.NullOr(Schema.String)),
      hasApiKey: Schema.optional(Schema.Boolean),
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
    })
  )
);
export const plugins: Pick<PluginState, "id" | "name" | "description">[] = [
  {
    description: "Browse your anime library, sync watched episodes, and customize download rules.",
    id: "anilist",
    name: "AniList",
  },
  { description: "Search and follow releases through RSS.", id: "nyaa", name: "Nyaa" },
  {
    description: "Releases and metadata from the official JSON feed.",
    id: "tsundere",
    name: "Tsundere-Raws",
  },
  { description: "Torznab search with your personal key.", id: "c411", name: "C411" },
];

interface PluginsOptions {
  endpoints: PluginEndpoints;
  now: () => number;
}

export interface SourceRegistration {
  description: string;
  download?: (input: {
    release: FeedRelease;
    apiKey: string;
    signal: AbortSignal;
  }) => Promise<Uint8Array>;
  id: SourcePluginId;
  name: string;
  privateDownloads?: boolean;
  search: (input: { query: string; apiKey: string; signal: AbortSignal }) => Promise<FeedRelease[]>;
}

const make = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const http = HttpClient.withScope(client);
  const db = yield* Database;
  const options: PluginsOptions = { endpoints: pluginEndpoints, now: Date.now };
  const serviceDb = db;
  const serviceOptions = options;

  const servicePlugins = new Map<PluginId, StoredPlugin>();
  const serviceSources = new Map<SourcePluginId, SourceRegistration>();
  const serviceLifecycle: { closed: boolean } = { closed: false };
  const serviceRequests = new Map<PluginId, Set<AbortController>>();
  const serviceC411Queue = yield* Semaphore.make(1);
  let serviceC411NextAt = 0;
  const serviceSearches = new Map<
    string,
    { expires: number; operation: ReturnType<typeof serviceFetchUncached> }
  >();
  const serviceTsundereQueue = yield* Semaphore.make(1);
  let serviceTsundereCache: { expires: number; releases: FeedRelease[] } | null = null;
  function serviceSnapshot() {
    return Array.from(servicePlugins.values(), ({ apiKey, callsDay, ...plugin }) => ({
      ...plugin,
      callsToday:
        callsDay === new Date(serviceOptions.now()).toISOString().slice(0, 10)
          ? plugin.callsToday
          : 0,
      hasApiKey: Boolean(apiKey),
    }));
  }
  function serviceRegisterSource(source: SourceRegistration) {
    // Registration is application wiring, not client input: a bad source is a programming error.
    if (!namespacedSourceId.test(source.id) || servicePlugins.has(source.id)) {
      throw new Error("Use a unique namespaced source identifier");
    }
    if (serviceLifecycle.closed) {
      throw new Error("Plugin unavailable");
    }
    const row = serviceDb
      .select()
      .from(automationPlugins)
      .where(eq(automationPlugins.id, source.id))
      .get();
    const stored = row ? decodeStoredPlugin(row.value) : {};
    servicePlugins.set(source.id, {
      apiKey: "",
      callsDay: "",
      callsToday: 0,
      checkedAt: null,
      dailyLimit: 1000,
      enabled: false,
      error: null,
      hasApiKey: false,
      ...stored,
      description: source.description,
      id: source.id,
      name: source.name,
    });
    serviceSources.set(source.id, { ...source });
  }
  function serviceSourceIds() {
    return ["nyaa", "tsundere", "c411", ...serviceSources.keys()];
  }
  function serviceRecordFailure(id: PluginId, message: string) {
    if (serviceLifecycle.closed) {
      return;
    }
    const plugin = servicePlugins.get(id);
    if (plugin) {
      plugin.error = message;
      plugin.checkedAt = serviceOptions.now();
      serviceStorePlugin(plugin);
    }
  }
  function serviceRecordSuccess(id: PluginId) {
    if (serviceLifecycle.closed) {
      return;
    }
    const plugin = servicePlugins.get(id);
    if (plugin) {
      plugin.error = null;
      plugin.checkedAt = serviceOptions.now();
      serviceStorePlugin(plugin);
    }
  }
  function serviceStorePlugin(plugin: StoredPlugin) {
    const value = JSON.stringify(plugin);
    serviceDb
      .insert(automationPlugins)
      .values({ id: plugin.id, value })
      .onConflictDoUpdate({ set: { value }, target: automationPlugins.id })
      .run();
  }
  function servicePlugin(id: string) {
    const plugin = servicePlugins.get(id as PluginId);
    if (!plugin) {
      throw new Error(`Unknown plugin ${id}`);
    }
    return structuredClone(plugin);
  }
  function serviceConfigure(
    id: string,
    input: { enabled: boolean; apiKey?: string; dailyLimit?: number }
  ) {
    const stored = servicePlugins.get(id as PluginId);
    if (!stored) {
      return problem(404, { detail: "Unknown plugin" });
    }
    const plugin = structuredClone(stored);
    const next = {
      ...plugin,
      ...input,
      apiKey: input.apiKey === undefined ? plugin.apiKey : input.apiKey.trim(),
      error: null,
    };
    if (next.enabled && id === "c411" && !next.apiKey) {
      return problem(400, { detail: "Add your API key before enabling this plugin" });
    }
    if (id === "tsundere") {
      serviceTsundereCache = null;
      serviceAbort("tsundere");
    }
    for (const key of serviceSearches.keys()) {
      if (key.startsWith(`${id}:`)) {
        serviceSearches.delete(key);
      }
    }
    servicePlugins.set(next.id, next);
    if (!next.enabled) {
      serviceAbort(next.id);
    }
    serviceStorePlugin(next);
    return serviceSnapshot();
  }
  const serviceTest = Effect.fn("Plugins.test")(function* (id: string) {
    if (!(id === "nyaa" || id === "tsundere" || id === "c411" || serviceSources.has(id))) {
      return problem(404, { detail: "Unknown plugin" });
    }
    for (const key of serviceSearches.keys()) {
      if (key.startsWith(`${id}:`)) {
        serviceSearches.delete(key);
      }
    }
    if (id === "tsundere") {
      serviceTsundereCache = null;
    }
    const releases = yield* serviceFetchUncached(id, "");
    if (releases instanceof ElysiaStatus) {
      return releases;
    }
    return serviceSnapshot();
  });
  const serviceConnect = Effect.fn("Plugins.connect")(function* (
    id: string,
    input: { apiKey?: string; enabled: boolean; dailyLimit?: number }
  ) {
    if (id !== "c411") {
      return problem(400, { detail: "This plugin does not use an API key" });
    }
    const plugin = servicePlugins.get(id);
    if (!plugin || serviceLifecycle.closed) {
      return problem(409, { detail: "Plugin unavailable" });
    }
    const apiKey = yield* serviceValidateCredential(id, input.apiKey ?? "", plugin);
    if (apiKey instanceof ElysiaStatus) {
      return apiKey;
    }
    const configured = serviceConfigure(id, { ...input, apiKey });
    if (configured instanceof ElysiaStatus) {
      return configured;
    }
    const updated = servicePlugins.get(id);
    if (updated) {
      updated.checkedAt = serviceOptions.now();
      serviceStorePlugin(updated);
    }
    return serviceSnapshot();
  });
  const serviceRequest = Effect.fn("Plugins.request")(function* <Result>(
    id: PluginId,
    timeoutMs: number,
    reserve: Effect.Effect<void> | null,
    run: (controller: AbortController) => Effect.Effect<Result>
  ) {
    if (serviceLifecycle.closed) {
      return problem(409, { detail: "Plugin unavailable" });
    }
    const controller = new AbortController();
    const active = serviceRequests.get(id) ?? new Set<AbortController>();
    active.add(controller);
    serviceRequests.set(id, active);
    const cleanup = yield* Effect.acquireRelease(
      Effect.sync(() => new DisposableStack()),
      (resource) => Effect.sync(() => resource.dispose())
    );
    cleanup.defer(() => {
      controller.abort();
      active.delete(controller);
    });
    if (controller.signal.aborted) {
      return problem(409, { detail: "Plugin request cancelled" });
    }
    const result = yield* Effect.raceFirst(
      Effect.gen(function* () {
        if (reserve) {
          yield* reserve;
        }
        return yield* run(controller).pipe(
          Effect.timeoutOrElse({
            duration: timeoutMs,
            orElse: () =>
              Effect.sync(() => {
                controller.abort();
                return problem(409, { detail: "Plugin request cancelled" });
              }),
          })
        );
      }),
      Effect.callback<
        ReturnType<typeof problem<409, { readonly detail: "Plugin request cancelled" }>>
      >((resume) => {
        const abort = () =>
          resume(Effect.succeed(problem(409, { detail: "Plugin request cancelled" })));
        controller.signal.addEventListener("abort", abort, { once: true });
        if (controller.signal.aborted) {
          abort();
        }
        return Effect.sync(() => controller.signal.removeEventListener("abort", abort));
      })
    );
    if (controller.signal.aborted && !(result instanceof ElysiaStatus)) {
      return problem(409, { detail: "Plugin request cancelled" });
    }
    return result;
  }, Effect.scoped);
  const serviceReserveC411 = Effect.fn("Plugins.reserveC411")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const delay = Math.max(0, serviceC411NextAt - now);
    if (delay > 0) {
      yield* Effect.sleep(delay);
    }
    serviceC411NextAt = (yield* Clock.currentTimeMillis) + 4100;
  }, serviceC411Queue.withPermits(1));
  const serviceTsundereCatalog = Effect.fn("Plugins.tsundereCatalog")(function* () {
    const plugin = servicePlugins.get("tsundere");
    if (!plugin?.enabled || serviceLifecycle.closed) {
      return [];
    }
    if (serviceTsundereCache && serviceTsundereCache.expires > serviceOptions.now()) {
      return structuredClone(serviceTsundereCache.releases);
    }
    return yield* serviceRequest("tsundere", 30_000, null, () =>
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep bounded partition traversal and completeness validation together.
      Effect.gen(function* () {
        const pending: { filters: [string, string][]; dimensions: ("quality" | "codec")[] }[] = [
          { dimensions: ["quality", "codec"], filters: [] },
        ];
        const releases = new Map<string, FeedRelease>();
        const identities = new Set<string>();
        let total = 0;
        let requests = 0;
        for (const partition of pending) {
          requests += 1;
          if (requests > 32) {
            return problem(502, { detail: "Tsundere catalogue exceeds public filter coverage" });
          }
          const url = new URL(serviceOptions.endpoints.tsundere);
          url.searchParams.set("limit", "250");
          url.searchParams.set("provider", "nyaa.si");
          for (const [name, value] of partition.filters) {
            url.searchParams.set(name, value);
          }
          const fetched = yield* Effect.result(
            Effect.gen(function* () {
              const response = yield* http.get(url);
              if (response.status < 200 || response.status >= 300) {
                return problem(502, { detail: `Source unavailable (HTTP ${response.status})` });
              }
              return yield* parseTsundere(yield* response.text);
            })
          );
          if (Result.isFailure(fetched)) {
            const cause = fetched.failure;
            return problem(502, {
              detail:
                cause instanceof Error && feedFailure.test(cause.message)
                  ? cause.message
                  : "Unable to read the Tsundere catalogue",
            });
          }
          const page = fetched.success;
          if (page instanceof ElysiaStatus) {
            return page;
          }
          if (requests === 1) {
            ({ total } = page);
          }
          if (new Set(page.identities).size < page.total) {
            const [dimension] = partition.dimensions;
            if (!dimension || page.options[dimension].length === 0) {
              return problem(502, { detail: "Incomplete Tsundere catalogue" });
            }
            for (const value of new Set(page.options[dimension])) {
              pending.push({
                dimensions: partition.dimensions.slice(1),
                filters: [...partition.filters, [dimension, value]],
              });
            }
          }
          for (const identity of page.identities) {
            identities.add(identity);
          }
          for (const release of page.releases) {
            releases.set(release.id, release);
          }
        }
        if (identities.size < total) {
          return problem(502, { detail: "Incomplete Tsundere catalogue" });
        }
        if (servicePlugins.get("tsundere") !== plugin || serviceLifecycle.closed) {
          return problem(409, { detail: "Plugin request cancelled" });
        }
        const result = Array.from(releases.values());
        serviceTsundereCache = { expires: serviceOptions.now() + 300_000, releases: result };
        serviceRecordSuccess("tsundere");
        return structuredClone(result);
      }).pipe(Effect.scoped)
    );
  }, serviceTsundereQueue.withPermits(1));
  const serviceFetchUncached = Effect.fn("Plugins.fetchUncached")(function* (
    sourceId: SourcePluginId,
    query: string
  ) {
    const plugin = servicePlugins.get(sourceId);
    if (!plugin?.enabled) {
      return [];
    }
    const registered = serviceSources.get(sourceId);
    if (registered) {
      return yield* serviceRequest(sourceId, 12_000, null, (controller) =>
        Effect.gen(function* () {
          const fetched = yield* Effect.result(
            Effect.tryPromise({
              catch: (cause) => cause,
              try: () =>
                registered.search({ apiKey: plugin.apiKey, query, signal: controller.signal }),
            })
          );
          if (Result.isFailure(fetched)) {
            return problem(502, { detail: "Unable to connect to the source" });
          }
          const releases = fetched.success;
          if (
            servicePlugins.get(sourceId) !== plugin ||
            !plugin.enabled ||
            serviceLifecycle.closed
          ) {
            return [];
          }
          if (
            !Array.isArray(releases) ||
            releases.some((release) => !release || release.sourceId !== sourceId || !release.id)
          ) {
            return problem(502, { detail: "Invalid source release identity" });
          }
          serviceRecordSuccess(sourceId);
          return releases.map((release) => ({
            ...release,
            privateDownload:
              registered.privateDownloads === true || release.privateDownload === true,
          }));
        }).pipe(Effect.scoped)
      );
    }
    if (sourceId !== "nyaa" && sourceId !== "tsundere" && sourceId !== "c411") {
      throw new Error(`Unknown source ${sourceId}`);
    }
    if (sourceId === "tsundere") {
      return yield* serviceTsundereCatalog();
    }
    const url = new URL(serviceOptions.endpoints[sourceId]);
    if (sourceId === "nyaa") {
      url.searchParams.set("page", "rss");
      url.searchParams.set("q", query);
    }
    if (sourceId === "c411") {
      url.searchParams.set("t", "search");
      url.searchParams.set("q", query);
      url.searchParams.set("apikey", plugin.apiKey);
      url.searchParams.set("limit", "100");
    }
    return yield* serviceRequest(
      sourceId,
      12_000,
      sourceId === "c411" ? serviceReserveC411() : null,
      () =>
        Effect.gen(function* () {
          // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
          const fetched = yield* Effect.result(
            Effect.gen(function* () {
              const response = yield* http.get(url);
              let releases: FeedRelease[];
              if (sourceId === "nyaa" && (response.status < 200 || response.status >= 300)) {
                url.searchParams.delete("page");
                const fallback = yield* http.get(url);
                if (fallback.status < 200 || fallback.status >= 300) {
                  return problem(502, {
                    detail: `Source unavailable (HTTP ${fallback.status})`,
                  });
                }
                const text = yield* fallback.text;
                releases = parseNyaaHtml(text, url.href);
              } else {
                if (response.status < 200 || response.status >= 300) {
                  return problem(502, {
                    detail: `Source unavailable (HTTP ${response.status})`,
                  });
                }
                const text = yield* response.text;
                releases = yield* parseRss(text, sourceId);
              }
              return releases;
            })
          );
          // biome-ignore-end lint/complexity/noExcessiveCognitiveComplexity: End of the existing operation.
          if (Result.isFailure(fetched)) {
            const cause = fetched.failure;
            const message =
              cause instanceof Error && feedFailure.test(cause.message)
                ? cause.message
                : "Unable to connect to the source";
            return problem(502, { detail: message });
          }
          const releases = fetched.success;
          if (releases instanceof ElysiaStatus) {
            return releases;
          }
          if (
            servicePlugins.get(sourceId) !== plugin ||
            !plugin.enabled ||
            serviceLifecycle.closed
          ) {
            return [];
          }
          plugin.error = null;
          plugin.checkedAt = serviceOptions.now();
          return releases;
        }).pipe(Effect.scoped)
    );
  });
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep cache reservation, lifecycle checks and failure eviction together.
  const serviceFetchSource = Effect.fn("Plugins.fetchSource")(function* (
    sourceId: SourcePluginId,
    query: string,
    cachedSearch = false
  ) {
    if (!servicePlugins.get(sourceId)?.enabled || serviceLifecycle.closed) {
      return [];
    }
    if (!cachedSearch || sourceId === "tsundere") {
      return yield* serviceFetchUncached(sourceId, query);
    }
    const key = `${sourceId}:${query}`;
    const cached = serviceSearches.get(key);
    if (cached && cached.expires > serviceOptions.now()) {
      const result = yield* cached.operation;
      return result instanceof ElysiaStatus ? result : structuredClone(result);
    }
    const operation = yield* Effect.cached(serviceFetchUncached(sourceId, query));
    if (serviceSearches.size >= 100) {
      const [oldest] = serviceSearches.keys();
      if (oldest) {
        serviceSearches.delete(oldest);
      }
    }
    const reservation = { expires: Number.POSITIVE_INFINITY, operation };
    serviceSearches.set(key, reservation);
    const result = yield* operation.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          if (serviceSearches.get(key) === reservation) {
            serviceSearches.delete(key);
          }
        })
      )
    );
    if (serviceSearches.get(key) === reservation) {
      if (result instanceof ElysiaStatus) {
        serviceSearches.delete(key);
      } else {
        reservation.expires = serviceOptions.now() + 60_000;
      }
    }
    return result instanceof ElysiaStatus ? result : structuredClone(result);
  });
  const serviceValidateCredential = Effect.fn("Plugins.validateCredential")(function* (
    id: "c411",
    input: string,
    plugin: StoredPlugin
  ) {
    const apiKey = normalizePluginCredential(id, input);
    if (apiKey instanceof ElysiaStatus) {
      return apiKey;
    }
    if (!apiKey) {
      return problem(400, { detail: "Paste your API key before validating the connection" });
    }
    const validated = yield* serviceRequest(id, 15_000, serviceReserveC411(), (controller) =>
      Effect.gen(function* () {
        const rejected = yield* validatePluginCredential({
          apiKey,
          endpoint: serviceOptions.endpoints[id],
          id,
        }).pipe(Effect.provideService(HttpClient.HttpClient, client));
        if (rejected) {
          return rejected;
        }
        if (
          serviceLifecycle.closed ||
          controller.signal.aborted ||
          servicePlugins.get(id) !== plugin
        ) {
          return problem(409, {
            detail: "Plugin settings changed. Try validating the key again.",
          });
        }
        return null;
      }).pipe(Effect.scoped)
    );
    return validated ?? apiKey;
  });
  const serviceDownloadFile = Effect.fn("Plugins.downloadFile")(function* (release: FeedRelease) {
    return yield* serviceRequest(release.sourceId, 15_000, null, (controller) =>
      Effect.gen(function* () {
        const registered = serviceSources.get(release.sourceId);
        const apiKey = registered?.download ? servicePlugin(release.sourceId).apiKey : undefined;

        // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
        const downloaded = yield* Effect.result(
          Effect.gen(function* () {
            const download = registered?.download;
            if (download) {
              const bytes = yield* Effect.tryPromise({
                catch: (cause) => cause,
                try: () =>
                  download({
                    apiKey: apiKey ?? "",
                    release,
                    signal: controller.signal,
                  }),
              });
              if (bytes.byteLength > 8 * 1024 * 1024) {
                return problem(400, { detail: "Torrent file too large" });
              }
              return bytes;
            }
            const response = yield* http.get(release.downloadUrl);
            if (response.status < 200 || response.status >= 300) {
              return problem(502, {
                detail: `Torrent file unavailable (HTTP ${response.status})`,
              });
            }
            const bytes = new Uint8Array(yield* response.arrayBuffer);
            if (bytes.byteLength > 8 * 1024 * 1024) {
              return problem(400, { detail: "Torrent file too large" });
            }
            return bytes;
          })
        );
        // biome-ignore-end lint/complexity/noExcessiveCognitiveComplexity: End of the existing operation.
        if (Result.isFailure(downloaded)) {
          return problem(502, { detail: "Unable to download the torrent file" });
        }
        return downloaded.success;
      }).pipe(Effect.scoped)
    );
  });
  function serviceAbort(id: PluginId) {
    for (const controller of serviceRequests.get(id) ?? []) {
      controller.abort();
    }
  }
  function serviceClose() {
    serviceLifecycle.closed = true;
    serviceSearches.clear();
    serviceTsundereCache = null;
    for (const id of serviceRequests.keys()) {
      serviceAbort(id);
    }
  }
  for (const plugin of plugins) {
    const row = serviceDb
      .select()
      .from(automationPlugins)
      .where(eq(automationPlugins.id, plugin.id))
      .get();
    servicePlugins.set(plugin.id, {
      ...plugin,
      apiKey: "",
      callsDay: "",
      callsToday: 0,
      checkedAt: null,
      dailyLimit: 1000,
      enabled: false,
      error: null,
      hasApiKey: false,
      ...(row ? decodeStoredPlugin(row.value) : {}),
    });
  }
  yield* Effect.addFinalizer(() => Effect.sync(serviceClose));
  return {
    close: serviceClose,
    configure: serviceConfigure,
    connect: serviceConnect,
    downloadFile: serviceDownloadFile,
    fetchSource: serviceFetchSource,
    plugin: servicePlugin,
    recordFailure: serviceRecordFailure,
    recordSuccess: serviceRecordSuccess,
    registerSource: serviceRegisterSource,
    request: serviceRequest,
    snapshot: serviceSnapshot,
    sourceIds: serviceSourceIds,
    test: serviceTest,
  };
});

export type PluginsService = Plugins["Service"];
export class Plugins extends Context.Service<
  Plugins,
  {
    readonly snapshot: () => {
      callsToday: number;
      hasApiKey: boolean;
      checkedAt: number | null;
      dailyLimit: number;
      description: string;
      enabled: boolean;
      error: string | null;
      id: PluginId;
      name: string;
    }[];
    readonly registerSource: (source: SourceRegistration) => void;
    readonly sourceIds: () => string[];
    readonly recordFailure: (id: PluginId, message: string) => void;
    readonly recordSuccess: (id: PluginId) => void;
    readonly plugin: (id: string) => StoredPlugin;
    readonly configure: (
      id: string,
      input: { enabled: boolean; apiKey?: string; dailyLimit?: number }
    ) =>
      | {
          callsToday: number;
          hasApiKey: boolean;
          checkedAt: number | null;
          dailyLimit: number;
          description: string;
          enabled: boolean;
          error: string | null;
          id: PluginId;
          name: string;
        }[]
      | ReturnType<typeof problem<404, { readonly detail: "Unknown plugin" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "Add your API key before enabling this plugin" }>
        >;
    readonly test: (id: string) => Effect.Effect<
      | {
          callsToday: number;
          hasApiKey: boolean;
          checkedAt: number | null;
          dailyLimit: number;
          description: string;
          enabled: boolean;
          error: string | null;
          id: PluginId;
          name: string;
        }[]
      | ReturnType<typeof problem<404, { readonly detail: "Unknown plugin" }>>
      | ReturnType<typeof problem<409, { readonly detail: "Plugin unavailable" }>>
      | ReturnType<typeof problem<409, { readonly detail: "Plugin request cancelled" }>>
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly connect: (
      id: string,
      input: { apiKey?: string; enabled: boolean; dailyLimit?: number }
    ) => Effect.Effect<
      | {
          callsToday: number;
          hasApiKey: boolean;
          checkedAt: number | null;
          dailyLimit: number;
          description: string;
          enabled: boolean;
          error: string | null;
          id: PluginId;
          name: string;
        }[]
      | ReturnType<typeof problem<404, { readonly detail: "Unknown plugin" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "Add your API key before enabling this plugin" }>
        >
      | ReturnType<typeof problem<400, { readonly detail: "This plugin does not use an API key" }>>
      | ReturnType<typeof problem<409, { readonly detail: "Plugin unavailable" }>>
      | ReturnType<
          typeof problem<
            400,
            {
              readonly detail: "Paste your C411 API key or a Torznab link from C411 API integrations";
            }
          >
        >
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Paste your API key before validating the connection" }
          >
        >
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<
          typeof problem<
            502,
            {
              readonly detail: "Unable to validate your C411 API key. Check your connection and try again.";
            }
          >
        >
      | ReturnType<
          typeof problem<
            400,
            {
              readonly detail: "C411 rejected this API key. Generate a new key and try again.";
            }
          >
        >
      | ReturnType<
          typeof problem<
            502,
            {
              readonly detail: `Unable to validate your C411 API key (HTTP ${number})`;
            }
          >
        >
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "Plugin settings changed. Try validating the key again." }
          >
        >
      | ReturnType<typeof problem<409, { readonly detail: "Plugin request cancelled" }>>
    >;
    readonly request: <Result>(
      id: PluginId,
      timeoutMs: number,
      reserve: Effect.Effect<void> | null,
      run: (controller: AbortController) => Effect.Effect<Result>
    ) => Effect.Effect<
      | Result
      | ReturnType<typeof problem<409, { readonly detail: "Plugin unavailable" }>>
      | ReturnType<typeof problem<409, { readonly detail: "Plugin request cancelled" }>>
    >;
    readonly fetchSource: (
      sourceId: SourcePluginId,
      query: string,
      cachedSearch?: boolean
    ) => Effect.Effect<
      | FeedRelease[]
      | ReturnType<typeof problem<409, { readonly detail: "Plugin unavailable" }>>
      | ReturnType<typeof problem<409, { readonly detail: "Plugin request cancelled" }>>
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly downloadFile: (
      release: FeedRelease
    ) => Effect.Effect<
      | ReturnType<typeof problem<502, { readonly detail: "Unable to download the torrent file" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Torrent file too large" }>>
      | Uint8Array<ArrayBufferLike>
      | ReturnType<
          typeof problem<502, { readonly detail: `Torrent file unavailable (HTTP ${number})` }>
        >
      | ReturnType<typeof problem<409, { readonly detail: "Plugin unavailable" }>>
      | ReturnType<typeof problem<409, { readonly detail: "Plugin request cancelled" }>>
    >;
    readonly close: () => void;
  }
>()("tofu/plugins") {}
export const pluginsLayer = Layer.effect(Plugins, make);
