import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Result } from "effect";
import { ElysiaStatus, problem } from "elysia";
import { automationPlugins } from "../../../db/schema";
import { Database } from "../../lib/database-layer";
import type { FeedRelease } from "../discovery/model";
import { normalizePluginCredential, validatePluginCredential } from "./credentials";
import { parseNyaaHtml, parseRss, parseTsundere } from "./feeds";
import type { PluginId, PluginState, SourcePluginId, StoredPlugin } from "./model";

export const pluginEndpoints = {
  c411: "https://c411.org/api/torznab",
  jev: "https://api.typesafe.ai/v1/systemone",
  nyaa: "https://nyaa.si/",
  tsundere: "https://tsundere.to/api/v1/feed.json",
};
export type PluginEndpoints = typeof pluginEndpoints & { anilist?: string; anilistToken?: string };
const namespacedSourceId = /^[a-z0-9][a-z0-9._-]*\.[a-z0-9._-]+$/;
const feedFailure = /^(Source unavailable|Invalid RSS feed|RSS feed missing|Invalid JSON feed)/;
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
  {
    description: "Natural language request interpretation and title matching.",
    id: "jev",
    name: "Jev · TypeSafe",
  },
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
  const db = yield* Database;
  const options: PluginsOptions = { endpoints: pluginEndpoints, now: Date.now };
  const serviceDb = db;
  const serviceOptions = options;

  const servicePlugins = new Map<PluginId, StoredPlugin>();
  const serviceSources = new Map<SourcePluginId, SourceRegistration>();
  const serviceLifecycle: { closed: boolean } = { closed: false };
  const serviceRequests = new Map<PluginId, Set<AbortController>>();
  let serviceC411Queue: Promise<void> = Promise.resolve();
  let serviceC411NextAt = 0;
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
    const stored = row ? (JSON.parse(row.value) as Partial<StoredPlugin>) : {};
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
    if (next.enabled && (id === "c411" || id === "jev") && !next.apiKey) {
      return problem(400, { detail: "Add your API key before enabling this plugin" });
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
    const releases = yield* serviceFetchSource(id, "");
    if (releases instanceof ElysiaStatus) {
      return releases;
    }
    return serviceSnapshot();
  });
  const serviceConnect = Effect.fn("Plugins.connect")(function* (
    id: string,
    input: { apiKey?: string; enabled: boolean; dailyLimit?: number }
  ) {
    if (id !== "c411" && id !== "jev") {
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
    reserve: ((controller: AbortController) => Effect.Effect<void, unknown>) | null,
    run: (controller: AbortController) => Effect.Effect<Result>
  ) {
    if (serviceLifecycle.closed) {
      return problem(409, { detail: "Plugin unavailable" });
    }
    const controller = new AbortController();
    const active = serviceRequests.get(id) ?? new Set<AbortController>();
    active.add(controller);
    serviceRequests.set(id, active);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = yield* Effect.acquireRelease(
      Effect.sync(() => new DisposableStack()),
      (resource) => Effect.sync(() => resource.dispose())
    );
    cleanup.defer(() => {
      controller.abort();
      if (timer !== null) {
        clearTimeout(timer);
      }
      active.delete(controller);
    });
    if (reserve) {
      const reserved = yield* Effect.result(reserve(controller));
      if (Result.isFailure(reserved) && !controller.signal.aborted) {
        throw reserved.failure;
      }
    }
    if (controller.signal.aborted) {
      return problem(409, { detail: "Plugin request cancelled" });
    }
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const result = yield* run(controller);
    if (controller.signal.aborted && !(result instanceof ElysiaStatus)) {
      return problem(409, { detail: "Plugin request cancelled" });
    }
    return result;
  }, Effect.scoped);
  function serviceReserveDailyCall(id: PluginId) {
    const plugin = servicePlugins.get(id);
    if (!plugin) {
      throw new Error(`Unknown plugin ${id}`);
    }
    const day = new Date(serviceOptions.now()).toISOString().slice(0, 10);
    if (plugin.callsDay !== day) {
      plugin.callsDay = day;
      plugin.callsToday = 0;
    }
    if (plugin.callsToday >= plugin.dailyLimit) {
      return problem(429, {
        detail: id === "jev" ? "Jev daily limit reached" : `${plugin.name} daily limit reached`,
      });
    }
    plugin.callsToday += 1;
    serviceStorePlugin(plugin);
    return null;
  }
  const serviceReserveC411 = Effect.fn("plugins.ReserveC411")(function* (
    controller: AbortController
  ) {
    const previous = serviceC411Queue;
    const reservation = (async () => {
      await previous;
      controller.signal.throwIfAborted();
      const delay = Math.max(0, serviceC411NextAt - Date.now());
      if (delay > 0) {
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(controller.signal.reason);
          };
          const timer = setTimeout(() => {
            controller.signal.removeEventListener("abort", abort);
            resolve();
          }, delay);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
      }
      controller.signal.throwIfAborted();
      serviceC411NextAt = Date.now() + 4100;
    })();
    serviceC411Queue = (async () => {
      // An aborted reservation releases its slot; its caller observes the abort.
      await Promise.allSettled([reservation]);
    })();
    return yield* Effect.promise(() => reservation);
  });
  const serviceFetchSource = Effect.fn("Plugins.fetchSource")(function* (
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
    const url = new URL(serviceOptions.endpoints[sourceId]);
    if (sourceId === "nyaa") {
      url.searchParams.set("page", "rss");
      url.searchParams.set("q", query);
    }
    if (sourceId === "tsundere") {
      url.searchParams.set("limit", "250");
      url.searchParams.set("provider", "nyaa.si");
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
      sourceId === "c411" ? (controller) => serviceReserveC411(controller) : null,
      (controller) =>
        Effect.gen(function* () {
          // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
          const fetched = yield* Effect.result(
            Effect.tryPromise({
              catch: (cause) => cause,
              try: async () => {
                const response = await fetch(url, { signal: controller.signal });
                let releases: FeedRelease[];
                if (sourceId === "nyaa" && !response.ok) {
                  url.searchParams.delete("page");
                  const fallback = await fetch(url, { signal: controller.signal });
                  if (!fallback.ok) {
                    return problem(502, {
                      detail: `Source unavailable (HTTP ${fallback.status})`,
                    });
                  }
                  releases = parseNyaaHtml(await fallback.text(), url.href);
                } else {
                  if (!response.ok) {
                    return problem(502, {
                      detail: `Source unavailable (HTTP ${response.status})`,
                    });
                  }
                  const text = await response.text();
                  releases =
                    sourceId === "tsundere" ? parseTsundere(text) : parseRss(text, sourceId);
                }
                return releases;
              },
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
          if (!servicePlugins.get(sourceId)?.enabled || serviceLifecycle.closed) {
            return [];
          }
          plugin.error = null;
          plugin.checkedAt = serviceOptions.now();
          return releases;
        }).pipe(Effect.scoped)
    );
  });
  const serviceValidateCredential = Effect.fn("Plugins.validateCredential")(function* (
    id: "c411" | "jev",
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
    if (id === "jev") {
      const reserved = serviceReserveDailyCall(id);
      if (reserved) {
        return reserved;
      }
    }
    const validated = yield* serviceRequest(
      id,
      15_000,
      id === "c411" ? (controller) => serviceReserveC411(controller) : null,
      (controller) =>
        Effect.gen(function* () {
          const rejected = yield* Effect.promise(() =>
            validatePluginCredential({
              apiKey,
              endpoint: serviceOptions.endpoints[id],
              id,
              signal: controller.signal,
            })
          );
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
          Effect.tryPromise({
            catch: (cause) => cause,
            try: async () => {
              if (registered?.download) {
                const bytes = await registered.download({
                  apiKey: apiKey ?? "",
                  release,
                  signal: controller.signal,
                });
                if (bytes.byteLength > 8 * 1024 * 1024) {
                  return problem(400, { detail: "Torrent file too large" });
                }
                return bytes;
              }
              const response = await fetch(release.downloadUrl, { signal: controller.signal });
              if (!response.ok) {
                return problem(502, {
                  detail: `Torrent file unavailable (HTTP ${response.status})`,
                });
              }
              const bytes = new Uint8Array(await response.arrayBuffer());
              if (bytes.byteLength > 8 * 1024 * 1024) {
                return problem(400, { detail: "Torrent file too large" });
              }
              return bytes;
            },
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
      ...(row ? (JSON.parse(row.value) as Partial<StoredPlugin>) : {}),
    });
  }
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await serviceClose();
    })
  );
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
    reserveDailyCall: serviceReserveDailyCall,
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
              readonly detail:
                | "Unable to validate your C411 API key. Check your connection and try again."
                | "Unable to validate your TypeSafe API key. Check your connection and try again.";
            }
          >
        >
      | ReturnType<
          typeof problem<
            400,
            {
              readonly detail:
                | "C411 rejected this API key. Generate a new key and try again."
                | "TypeSafe rejected this API key. Generate a new key and try again.";
            }
          >
        >
      | ReturnType<
          typeof problem<
            502,
            {
              readonly detail:
                | `Unable to validate your C411 API key (HTTP ${number})`
                | `Unable to validate your TypeSafe API key (HTTP ${number})`;
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
      reserve: ((controller: AbortController) => Effect.Effect<void, unknown>) | null,
      run: (controller: AbortController) => Effect.Effect<Result>
    ) => Effect.Effect<
      | Result
      | ReturnType<typeof problem<409, { readonly detail: "Plugin unavailable" }>>
      | ReturnType<typeof problem<409, { readonly detail: "Plugin request cancelled" }>>
    >;
    readonly reserveDailyCall: (
      id: PluginId
    ) => ReturnType<typeof problem<429, { readonly detail: string }>> | null;
    readonly fetchSource: (
      sourceId: SourcePluginId,
      query: string
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
