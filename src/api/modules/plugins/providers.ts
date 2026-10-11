import { HTTPError } from "elysia";
import type { FeedRelease, PluginId, SourcePluginId, StoredPlugin } from "../../../types";
import { type JevQuestions, parseJevResponse } from "../jev/service";
import { normalizePluginCredential, validatePluginCredential } from "./credentials";
import { parseNyaaHtml, parseRss, parseTsundere } from "./feeds";
import type { PluginEndpoints } from "./service";

interface ProviderOptions {
  endpoints: PluginEndpoints;
  isClosed: () => boolean;
  now: () => number;
  plugins: Map<PluginId, StoredPlugin>;
  storePlugin: (plugin: StoredPlugin) => void;
}

/** Owns provider limits and cancellation for every network operation in the automation service. */
export class ProviderAccess {
  private readonly requests = new Map<PluginId, Set<AbortController>>();
  private c411Queue: Promise<void> = Promise.resolve();
  private c411NextAt = 0;
  private readonly options: ProviderOptions;
  constructor(options: ProviderOptions) {
    this.options = options;
  }

  private async request<Result>(
    id: PluginId,
    timeoutMs: number,
    reserve: ((controller: AbortController) => Promise<void>) | null,
    run: (controller: AbortController) => Promise<Result>
  ) {
    const controller = new AbortController();
    const active = this.requests.get(id) ?? new Set<AbortController>();
    active.add(controller);
    this.requests.set(id, active);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await reserve?.(controller);
      controller.signal.throwIfAborted();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      return await run(controller);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
      active.delete(controller);
    }
  }

  private reserveJevCall(plugin: StoredPlugin) {
    const day = new Date(this.options.now()).toISOString().slice(0, 10);
    if (plugin.callsDay !== day) {
      plugin.callsDay = day;
      plugin.callsToday = 0;
    }
    if (plugin.callsToday >= plugin.dailyLimit) {
      throw new (HTTPError.id("TOO_MANY_REQUESTS", 429))("Jev daily limit reached");
    }
    plugin.callsToday += 1;
    this.options.storePlugin(plugin);
  }
  private reserveC411(controller: AbortController) {
    const reservation = this.c411Queue.then(async () => {
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
    });
    this.c411Queue = reservation.catch(() => undefined);
    return reservation;
  }
  async fetchSource(sourceId: SourcePluginId, query: string) {
    const plugin = this.options.plugins.get(sourceId);
    if (!plugin?.enabled) {
      return [];
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
        const response = await fetch(url, { signal: controller.signal });
        let releases: FeedRelease[];
        if (sourceId === "nyaa" && !response.ok) {
          url.searchParams.delete("page");
          const fallback = await fetch(url, { signal: controller.signal });
          if (!fallback.ok) {
            throw new Error(`Source unavailable (HTTP ${fallback.status})`);
          }
          releases = parseNyaaHtml(await fallback.text(), url.href);
        } else {
          if (!response.ok) {
            throw new Error(`Source unavailable (HTTP ${response.status})`);
          }
          const text = await response.text();
          releases = sourceId === "tsundere" ? parseTsundere(text) : parseRss(text, sourceId);
        }
        if (!this.options.plugins.get(sourceId)?.enabled || this.options.isClosed()) {
          return [];
        }
        plugin.error = null;
        plugin.checkedAt = this.options.now();
        return releases;
      }
    );
  }

  async validateCredential(id: "c411" | "jev", input: string, plugin: StoredPlugin) {
    const apiKey = normalizePluginCredential(id, input);
    if (!apiKey) {
      throw new (HTTPError.id("BAD_REQUEST", 400))(
        "Paste your API key before validating the connection"
      );
    }
    if (id === "jev") {
      this.reserveJevCall(plugin);
    }
    await this.request(
      id,
      15_000,
      id === "c411" ? (controller) => this.reserveC411(controller) : null,
      async (controller) => {
        await validatePluginCredential({
          apiKey,
          endpoint: this.options.endpoints[id],
          id,
          signal: controller.signal,
        });
        if (
          this.options.isClosed() ||
          controller.signal.aborted ||
          this.options.plugins.get(id) !== plugin
        ) {
          throw new (HTTPError.id("CONFLICT", 409))(
            "Plugin settings changed. Try validating the key again."
          );
        }
      }
    );
    return apiKey;
  }

  downloadFile(release: FeedRelease) {
    return this.request(release.sourceId, 15_000, null, async (controller) => {
      const response = await fetch(release.downloadUrl, { signal: controller.signal });
      if (!response.ok) {
        throw new (HTTPError.id("BAD_GATEWAY", 502))(
          `Torrent file unavailable (HTTP ${response.status})`
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > 8 * 1024 * 1024) {
        throw new (HTTPError.id("BAD_REQUEST", 400))("Torrent file too large");
      }
      return bytes;
    });
  }

  evaluate(state: object, questions: JevQuestions, plugin: StoredPlugin) {
    this.reserveJevCall(plugin);
    return this.request("jev", 15_000, null, async (controller) => {
      try {
        const response = await fetch(this.options.endpoints.jev, {
          body: JSON.stringify({ model: "jev-latest", questions, state }),
          headers: { authorization: `Bearer ${plugin.apiKey}`, "content-type": "application/json" },
          method: "POST",
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new (HTTPError.id("SERVICE_UNAVAILABLE", 503))(
            `Jev unavailable (HTTP ${response.status})`
          );
        }
        const result = parseJevResponse(await response.json(), questions);
        if (this.options.isClosed() || !this.options.plugins.get("jev")?.enabled) {
          throw new (HTTPError.id("CONFLICT", 409))("Jev plugin disabled");
        }
        plugin.error = null;
        plugin.checkedAt = this.options.now();
        return result;
      } catch (cause) {
        if (plugin.enabled) {
          plugin.error = "Jev evaluation unavailable";
        }
        throw cause instanceof HTTPError
          ? cause
          : new (HTTPError.id("SERVICE_UNAVAILABLE", 503))("Unable to connect to Jev");
      }
    });
  }

  abort(id: PluginId) {
    for (const controller of this.requests.get(id) ?? []) {
      controller.abort();
    }
  }
  close() {
    for (const id of this.requests.keys()) {
      this.abort(id);
    }
  }
}
