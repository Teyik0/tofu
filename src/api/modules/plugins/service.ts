import { eq } from "drizzle-orm";
import { Effect, Result } from "effect";
import { ElysiaStatus, problem } from "elysia";
import { automationPlugins } from "../../../db/schema";
import type { Database } from "../../lib/database-layer";
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

export class PluginsService {
  private readonly plugins = new Map<PluginId, StoredPlugin>();
  private readonly sources = new Map<SourcePluginId, SourceRegistration>();
  private readonly lifecycle: { closed: boolean } = { closed: false };
  private readonly db: Database;
  private readonly options: PluginsOptions;
  constructor(db: Database, options: PluginsOptions) {
    this.db = db;
    this.options = options;
    for (const plugin of plugins) {
      const row = this.db
        .select()
        .from(automationPlugins)
        .where(eq(automationPlugins.id, plugin.id))
        .get();
      this.plugins.set(plugin.id, {
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
  }
  snapshot() {
    return Array.from(this.plugins.values(), ({ apiKey, callsDay, ...plugin }) => ({
      ...plugin,
      callsToday:
        callsDay === new Date(this.options.now()).toISOString().slice(0, 10)
          ? plugin.callsToday
          : 0,
      hasApiKey: Boolean(apiKey),
    }));
  }
  registerSource(source: SourceRegistration) {
    // Registration is application wiring, not client input: a bad source is a programming error.
    if (!namespacedSourceId.test(source.id) || this.plugins.has(source.id)) {
      throw new Error("Use a unique namespaced source identifier");
    }
    if (this.lifecycle.closed) {
      throw new Error("Plugin unavailable");
    }
    const row = this.db
      .select()
      .from(automationPlugins)
      .where(eq(automationPlugins.id, source.id))
      .get();
    const stored = row ? (JSON.parse(row.value) as Partial<StoredPlugin>) : {};
    this.plugins.set(source.id, {
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
    this.sources.set(source.id, { ...source });
  }
  sourceIds() {
    return ["nyaa", "tsundere", "c411", ...this.sources.keys()];
  }
  recordFailure(id: PluginId, message: string) {
    if (this.lifecycle.closed) {
      return;
    }
    const plugin = this.plugins.get(id);
    if (plugin) {
      plugin.error = message;
      plugin.checkedAt = this.options.now();
      this.storePlugin(plugin);
    }
  }
  recordSuccess(id: PluginId) {
    if (this.lifecycle.closed) {
      return;
    }
    const plugin = this.plugins.get(id);
    if (plugin) {
      plugin.error = null;
      plugin.checkedAt = this.options.now();
      this.storePlugin(plugin);
    }
  }
  private storePlugin(plugin: StoredPlugin) {
    const value = JSON.stringify(plugin);
    this.db
      .insert(automationPlugins)
      .values({ id: plugin.id, value })
      .onConflictDoUpdate({ set: { value }, target: automationPlugins.id })
      .run();
  }
  /** A known plugin; callers validate client-supplied identifiers before reading it. */
  plugin(id: string) {
    const plugin = this.plugins.get(id as PluginId);
    if (!plugin) {
      throw new Error(`Unknown plugin ${id}`);
    }
    return structuredClone(plugin);
  }
  configure(id: string, input: { enabled: boolean; apiKey?: string; dailyLimit?: number }) {
    const stored = this.plugins.get(id as PluginId);
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
    this.plugins.set(next.id, next);
    if (!next.enabled) {
      this.abort(next.id);
    }
    this.storePlugin(next);
    return this.snapshot();
  }
  async test(id: string) {
    if (!(id === "nyaa" || id === "tsundere" || id === "c411" || this.sources.has(id))) {
      return problem(404, { detail: "Unknown plugin" });
    }
    const releases = await this.fetchSource(id, "");
    if (releases instanceof ElysiaStatus) {
      return releases;
    }
    return this.snapshot();
  }
  async connect(id: string, input: { apiKey?: string; enabled: boolean; dailyLimit?: number }) {
    if (id !== "c411" && id !== "jev") {
      return problem(400, { detail: "This plugin does not use an API key" });
    }
    const plugin = this.plugins.get(id);
    if (!plugin || this.lifecycle.closed) {
      return problem(409, { detail: "Plugin unavailable" });
    }
    const apiKey = await this.validateCredential(id, input.apiKey ?? "", plugin);
    if (apiKey instanceof ElysiaStatus) {
      return apiKey;
    }
    const configured = this.configure(id, { ...input, apiKey });
    if (configured instanceof ElysiaStatus) {
      return configured;
    }
    const updated = this.plugins.get(id);
    if (updated) {
      updated.checkedAt = this.options.now();
      this.storePlugin(updated);
    }
    return this.snapshot();
  }

  private readonly requests = new Map<PluginId, Set<AbortController>>();
  private c411Queue: Promise<void> = Promise.resolve();
  private c411NextAt = 0;

  async request<Result>(
    id: PluginId,
    timeoutMs: number,
    reserve: ((controller: AbortController) => Promise<void>) | null,
    run: (controller: AbortController) => Promise<Result>
  ) {
    if (this.lifecycle.closed) {
      return problem(409, { detail: "Plugin unavailable" });
    }
    const controller = new AbortController();
    const active = this.requests.get(id) ?? new Set<AbortController>();
    active.add(controller);
    this.requests.set(id, active);
    let timer: ReturnType<typeof setTimeout> | null = null;
    using cleanup = new DisposableStack();
    cleanup.defer(() => {
      if (timer !== null) {
        clearTimeout(timer);
      }
      active.delete(controller);
    });
    if (reserve) {
      const reserved = await Effect.runPromise(
        Effect.result(
          Effect.tryPromise({
            catch: (cause) => cause,
            try: () => reserve(controller),
          })
        )
      );
      if (Result.isFailure(reserved) && !controller.signal.aborted) {
        throw reserved.failure;
      }
    }
    if (controller.signal.aborted) {
      return problem(409, { detail: "Plugin request cancelled" });
    }
    timer = setTimeout(() => controller.abort(), timeoutMs);
    const result = await run(controller);
    if (controller.signal.aborted && !(result instanceof ElysiaStatus)) {
      return problem(409, { detail: "Plugin request cancelled" });
    }
    return result;
  }

  /** Counts one call against the daily budget, or returns 429 once it is spent. */
  reserveDailyCall(id: PluginId) {
    const plugin = this.plugins.get(id);
    if (!plugin) {
      throw new Error(`Unknown plugin ${id}`);
    }
    const day = new Date(this.options.now()).toISOString().slice(0, 10);
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
    this.storePlugin(plugin);
    return null;
  }
  /** Spaces C411 calls; the queue slot is taken synchronously, before any await. */
  private reserveC411(controller: AbortController) {
    const previous = this.c411Queue;
    const reservation = (async () => {
      await previous;
      controller.signal.throwIfAborted();
      const delay = Math.max(0, this.c411NextAt - Date.now());
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
      this.c411NextAt = Date.now() + 4100;
    })();
    this.c411Queue = (async () => {
      // An aborted reservation releases its slot; its caller observes the abort.
      await Promise.allSettled([reservation]);
    })();
    return reservation;
  }
  async fetchSource(sourceId: SourcePluginId, query: string) {
    const plugin = this.plugins.get(sourceId);
    if (!plugin?.enabled) {
      return [];
    }
    const registered = this.sources.get(sourceId);
    if (registered) {
      return this.request(sourceId, 12_000, null, async (controller) => {
        const fetched = await Effect.runPromise(
          Effect.result(
            Effect.tryPromise({
              catch: (cause) => cause,
              try: () =>
                registered.search({ apiKey: plugin.apiKey, query, signal: controller.signal }),
            })
          )
        );
        if (Result.isFailure(fetched)) {
          return problem(502, { detail: "Unable to connect to the source" });
        }
        const releases = fetched.success;
        if (this.plugins.get(sourceId) !== plugin || !plugin.enabled || this.lifecycle.closed) {
          return [];
        }
        if (
          !Array.isArray(releases) ||
          releases.some((release) => !release || release.sourceId !== sourceId || !release.id)
        ) {
          return problem(502, { detail: "Invalid source release identity" });
        }
        this.recordSuccess(sourceId);
        return releases.map((release) => ({
          ...release,
          privateDownload: registered.privateDownloads === true || release.privateDownload === true,
        }));
      });
    }
    if (sourceId !== "nyaa" && sourceId !== "tsundere" && sourceId !== "c411") {
      throw new Error(`Unknown source ${sourceId}`);
    }
    const url = new URL(this.options.endpoints[sourceId]);
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
    return await this.request(
      sourceId,
      12_000,
      sourceId === "c411" ? (controller) => this.reserveC411(controller) : null,
      async (controller) => {
        const fetched = await Effect.runPromise(
          Effect.result(
            Effect.tryPromise({
              catch: (cause) => cause,
              try: async () => {
                const response = await fetch(url, { signal: controller.signal });
                let releases: FeedRelease[];
                if (sourceId === "nyaa" && !response.ok) {
                  url.searchParams.delete("page");
                  const fallback = await fetch(url, { signal: controller.signal });
                  if (!fallback.ok) {
                    return problem(502, { detail: `Source unavailable (HTTP ${fallback.status})` });
                  }
                  releases = parseNyaaHtml(await fallback.text(), url.href);
                } else {
                  if (!response.ok) {
                    return problem(502, { detail: `Source unavailable (HTTP ${response.status})` });
                  }
                  const text = await response.text();
                  releases =
                    sourceId === "tsundere" ? parseTsundere(text) : parseRss(text, sourceId);
                }
                return releases;
              },
            })
          )
        );
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
        if (!this.plugins.get(sourceId)?.enabled || this.lifecycle.closed) {
          return [];
        }
        plugin.error = null;
        plugin.checkedAt = this.options.now();
        return releases;
      }
    );
  }

  private async validateCredential(id: "c411" | "jev", input: string, plugin: StoredPlugin) {
    const apiKey = normalizePluginCredential(id, input);
    if (apiKey instanceof ElysiaStatus) {
      return apiKey;
    }
    if (!apiKey) {
      return problem(400, { detail: "Paste your API key before validating the connection" });
    }
    if (id === "jev") {
      const reserved = this.reserveDailyCall(id);
      if (reserved) {
        return reserved;
      }
    }
    const validated = await this.request(
      id,
      15_000,
      id === "c411" ? (controller) => this.reserveC411(controller) : null,
      async (controller) => {
        const rejected = await validatePluginCredential({
          apiKey,
          endpoint: this.options.endpoints[id],
          id,
          signal: controller.signal,
        });
        if (rejected) {
          return rejected;
        }
        if (this.lifecycle.closed || controller.signal.aborted || this.plugins.get(id) !== plugin) {
          return problem(409, { detail: "Plugin settings changed. Try validating the key again." });
        }
        return null;
      }
    );
    return validated ?? apiKey;
  }

  downloadFile(release: FeedRelease) {
    return this.request(release.sourceId, 15_000, null, async (controller) => {
      const registered = this.sources.get(release.sourceId);
      const apiKey = registered?.download ? this.plugin(release.sourceId).apiKey : undefined;
      const downloaded = await Effect.runPromise(
        Effect.result(
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
        )
      );
      if (Result.isFailure(downloaded)) {
        return problem(502, { detail: "Unable to download the torrent file" });
      }
      return downloaded.success;
    });
  }

  private abort(id: PluginId) {
    for (const controller of this.requests.get(id) ?? []) {
      controller.abort();
    }
  }
  close() {
    this.lifecycle.closed = true;
    for (const id of this.requests.keys()) {
      this.abort(id);
    }
  }
}
