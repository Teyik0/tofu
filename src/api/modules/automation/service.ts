import { eq } from "drizzle-orm";
import parseTorrent from "parse-torrent";
import {
  automationDecisions,
  automationJudgements,
  automationPlugins,
  automationPreferences,
  automationReleases,
  automationRules,
} from "../../../db/schema";
import type {
  AniListClient,
  AniListReleases,
  AutomationDecision,
  AutomationDraft,
  AutomationPreferences,
  AutomationRule,
  AutomationState,
  DiscoveryResult,
  EnginePort,
  FeedRelease,
  PluginId,
  PluginState,
  SourcePluginId,
} from "../../../types";
import {
  type DatabaseConnection,
  type DatabaseTransaction,
  openDatabase,
  type TofuDatabase,
} from "../../lib/db";
import { UserError } from "../../lib/errors";
import { refreshRecords } from "../../lib/persisted-cache";
import { AniListService } from "../anilist/service";
import {
  classicDiscovery,
  DiscoveryResolver,
  matchesClassicDiscovery,
  matchesDiscovery,
  parseDiscovery,
} from "../discovery/service";
import {
  interpretationQuestions,
  type JevQuestions,
  type JevResult,
  matchQuestions,
  parseJevResponse,
  safeReleaseState,
} from "../jev/service";
import { parseNyaaHtml, parseRss, parseTsundere } from "../plugins/feeds";
import { type PluginEndpoints, plugins } from "../plugins/service";
import {
  compareQuality,
  compareReleases,
  contentKey,
  defaultAutomationPreferences,
  interpretLocally,
  localMatch,
  normalizeTitle,
  preferred,
} from "./rules";

const feedExpression1 = /^(Source unavailable|Invalid RSS feed|RSS feed missing|Invalid JSON feed)/;

export interface AutomationOptions {
  anilistClient?: AniListClient;
  dataDir: string;
  endpoints: PluginEndpoints;
  engine: () => EnginePort;
  now: () => number;
}
interface StoredPlugin extends PluginState {
  apiKey: string;
  callsDay: string;
}

interface PreparedRule {
  baseline: AutomationDecision[];
  rule: AutomationRule;
}

export class AutomationService {
  readonly db: TofuDatabase;
  private readonly plugins = new Map<PluginId, StoredPlugin>();
  private closed = false;
  private isClosed(): boolean {
    return this.closed;
  }
  private isEnabled(id: PluginId): boolean {
    return this.plugins.get(id)?.enabled === true;
  }
  private readonly requests = new Map<PluginId, Set<AbortController>>();
  private readonly rules = new Map<string, AutomationRule>();
  private readonly decisions = new Map<string, AutomationDecision>();
  private readonly runs = new Map<string, Promise<AutomationState>>();
  private readonly replacements = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly startupState: { started: boolean } = { started: false };
  private readonly releases = new Map<string, FeedRelease>();
  private readonly additions = new Map<string, Promise<{ id: string }>>();
  private c411Queue: Promise<void> = Promise.resolve();
  private c411NextAt = 0;
  private readonly discoveryResolver = new DiscoveryResolver();
  private preferences: AutomationPreferences = defaultAutomationPreferences;

  readonly options: AutomationOptions;
  readonly anilist: AniListService;
  private readonly ownsDatabase: boolean;
  private constructor(options: AutomationOptions, db: TofuDatabase, ownsDatabase: boolean) {
    this.options = options;
    this.ownsDatabase = ownsDatabase;
    this.db = db;
    const storedPreferences = this.db
      .select()
      .from(automationPreferences)
      .where(eq(automationPreferences.id, "automation"))
      .get();
    if (storedPreferences) {
      this.preferences = {
        ...defaultAutomationPreferences,
        ...(JSON.parse(storedPreferences.value) as Partial<AutomationPreferences>),
      };
    }
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
    for (const row of this.db.select().from(automationRules).all()) {
      const rule = JSON.parse(row.value) as AutomationRule;
      this.rules.set(rule.id, rule);
    }
    for (const row of this.db.select().from(automationDecisions).all()) {
      const decision = JSON.parse(row.value) as AutomationDecision;
      this.decisions.set(decision.id, decision);
    }
    for (const row of this.db.select().from(automationReleases).all()) {
      const release = JSON.parse(row.value) as FeedRelease;
      this.releases.set(`${release.sourceId}:${release.id}`, release);
    }
    this.anilist = new AniListService(this.db, {
      client: options.anilistClient,
      destinationExists: (id) =>
        options
          .engine()
          .snapshot(null, false)
          .destinations.some((destination) => destination.id === id),
      destinations: () => options.engine().snapshot(null, false).destinations,
      enabled: () => this.isEnabled("anilist"),
      enableRule: (id, enabled, connection) => {
        const rule = this.rules.get(id);
        if (rule) {
          this.persistRule({ ...rule, enabled, nextRunAt: this.options.now() }, connection);
        }
      },
      endpoint: options.endpoints.anilist ?? "https://graphql.anilist.co",
      now: options.now,
      rule: (id) => this.rules.get(id),
      run: (id) => this.run(id),
      save: (id, draft) => this.save(id, draft),
      saveDestination: (input) => options.engine().saveDestination(null, input),
      setToken: (apiKey) => {
        this.configure("anilist", { apiKey, enabled: true });
      },
      token: () => this.plugins.get("anilist")?.apiKey ?? "",
      tokenEndpoint: options.endpoints.anilistToken ?? "https://anilist.co/api/v2/oauth/token",
    });
  }
  static async open(options: AutomationOptions, connection?: TofuDatabase) {
    const db = connection ?? (await openDatabase(options.dataDir));
    try {
      return new AutomationService(options, db, connection === undefined);
    } catch (error) {
      if (!connection) {
        db.$client.close();
      }
      throw error;
    }
  }
  private ruleStatus(rule: AutomationRule): AutomationRule["status"] {
    if (!rule.enabled) {
      return "paused";
    }
    if (!rule.sources.some((id) => this.isEnabled(id))) {
      return "source-disabled";
    }
    if (this.runs.has(rule.id)) {
      return "running";
    }
    if (rule.error) {
      return "error";
    }
    return "active";
  }
  snapshot(): AutomationState {
    return {
      automations: Array.from(this.rules.values(), (rule) => ({
        ...rule,
        status: this.ruleStatus(rule),
      })),
      decisions: Array.from(this.decisions.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 300)
        .map((decision) => ({
          ...decision,
          release: this.publicRelease(decision.release),
          supersedes: decision.supersedes
            ? { ...decision.supersedes, release: this.publicRelease(decision.supersedes.release) }
            : null,
        })),
      plugins: Array.from(this.plugins.values(), ({ apiKey, callsDay, ...plugin }) => ({
        ...plugin,
        callsToday:
          callsDay === new Date(this.options.now()).toISOString().slice(0, 10)
            ? plugin.callsToday
            : 0,
        hasApiKey: Boolean(apiKey),
      })),
      preferences: this.preferences,
      updatedAt: this.options.now(),
    };
  }
  savePreferences(preferences: AutomationPreferences) {
    this.writePreferences(this.db, preferences);
    this.preferences = preferences;
    return this.snapshot();
  }
  writePreferences(db: DatabaseConnection, preferences: AutomationPreferences) {
    const value = JSON.stringify(preferences);
    db.insert(automationPreferences)
      .values({ id: "automation", value })
      .onConflictDoUpdate({ set: { value }, target: automationPreferences.id })
      .run();
    return preferences;
  }
  refreshState() {
    const preferences = this.db
      .select()
      .from(automationPreferences)
      .where(eq(automationPreferences.id, "automation"))
      .get();
    this.preferences = preferences
      ? {
          ...defaultAutomationPreferences,
          ...(JSON.parse(preferences.value) as Partial<AutomationPreferences>),
        }
      : defaultAutomationPreferences;
    refreshRecords(this.rules, this.db.select().from(automationRules).all());
    refreshRecords(this.decisions, this.db.select().from(automationDecisions).all());
  }
  private storePlugin(plugin: StoredPlugin) {
    const value = JSON.stringify(plugin);
    this.db
      .insert(automationPlugins)
      .values({ id: plugin.id, value })
      .onConflictDoUpdate({ set: { value }, target: automationPlugins.id })
      .run();
  }
  private storeRelease(release: FeedRelease) {
    const value = JSON.stringify(release);
    this.db
      .insert(automationReleases)
      .values({ id: `${release.sourceId}:${release.id}`, value })
      .onConflictDoUpdate({ set: { value }, target: automationReleases.id })
      .run();
  }
  private publicRelease(release: FeedRelease) {
    return release.sourceId === "c411"
      ? {
          ...release,
          downloadUrl: `private:c411:${release.id}`,
          pageUrl: release.pageUrl?.includes("apikey=") ? null : release.pageUrl,
        }
      : release;
  }
  configure(id: string, input: { enabled: boolean; apiKey?: string; dailyLimit?: number }) {
    const plugin = this.plugins.get(id as PluginId);
    if (!plugin) {
      throw new UserError("Unknown plugin", { status: 404 });
    }
    const next = {
      ...plugin,
      ...input,
      apiKey: input.apiKey === undefined ? plugin.apiKey : input.apiKey.trim(),
      error: null,
    };
    if (next.enabled && (id === "c411" || id === "jev") && !next.apiKey) {
      throw new UserError("Add your API key before enabling this plugin", { status: 400 });
    }
    this.plugins.set(next.id, next);
    if (!next.enabled) {
      for (const controller of this.requests.get(next.id) ?? []) {
        controller.abort();
      }
      if (next.id === "anilist") {
        this.anilist.suspend();
      }
    }
    this.storePlugin(next);
    return this.snapshot();
  }
  async testPlugin(id: string) {
    if (id === "anilist") {
      await this.anilist.list();
    } else if (id === "jev") {
      await this.askJev(
        { message: "connection test" },
        { connected: { instructions: "Does the message say connection test?", type: "noul" } }
      );
    } else if (id === "nyaa" || id === "tsundere" || id === "c411") {
      await this.fetchSource(id, "");
    } else {
      throw new UserError("Unknown plugin", { status: 404 });
    }
    return this.snapshot();
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
  private async fetchSource(sourceId: SourcePluginId, query: string) {
    const plugin = this.plugins.get(sourceId);
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
    const controller = new AbortController();
    const active = this.requests.get(sourceId) ?? new Set<AbortController>();
    active.add(controller);
    this.requests.set(sourceId, active);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      if (sourceId === "c411") {
        await this.reserveC411(controller);
      }
      timeout = setTimeout(() => controller.abort(), 12_000);
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
      if (!this.plugins.get(sourceId)?.enabled || this.isClosed()) {
        return [];
      }
      plugin.error = null;
      plugin.checkedAt = this.options.now();
      return releases;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      active.delete(controller);
    }
  }
  private async discovery(query: string, sources: SourcePluginId[]): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { errors: [], releases: [] };
    await Promise.all(
      [...new Set(sources)].map(async (sourceId) => {
        try {
          result.releases.push(...(await this.fetchSource(sourceId, query)));
        } catch (cause) {
          if (!this.plugins.get(sourceId)?.enabled || this.isClosed()) {
            return;
          }
          const message =
            cause instanceof Error && feedExpression1.test(cause.message)
              ? cause.message
              : "Unable to connect to the source";
          result.errors.push({ message, sourceId });
          const plugin = this.plugins.get(sourceId);
          if (plugin) {
            plugin.error = message;
            plugin.checkedAt = this.options.now();
          }
        }
      })
    );
    if (this.isClosed()) {
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
    const selected: SourcePluginId[] = sources ?? ["nyaa", "tsundere", "c411"];
    const active = [...new Set(selected)].filter((id) => this.isEnabled(id));
    const jev = this.plugins.get("jev");
    if (!(jev?.enabled && jev.apiKey)) {
      const search = classicDiscovery(query);
      if (!(search.title && active.length) || this.isClosed()) {
        return { errors: [], releases: [], search };
      }
      const result = await this.discovery(query, active);
      return {
        ...result,
        releases: result.releases
          .filter(
            (release) => release.sourceId !== "tsundere" || matchesClassicDiscovery(query, release)
          )
          .map((release) => this.publicRelease(release)),
        search,
      };
    }
    const search = parseDiscovery(query);
    if (!(search.title && active.length) || this.isClosed()) {
      return { errors: [], releases: [], search };
    }
    await this.discoveryResolver.resolve(
      search,
      this.options.endpoints.anilist ?? "https://graphql.anilist.co"
    );
    if (!search.queries.length) {
      search.queries = [search.title];
    }
    const releases = new Map<string, FeedRelease>();
    const errors = new Map<SourcePluginId, DiscoveryResult["errors"][number]>();
    await Promise.all(
      active.map(async (sourceId) => {
        // Tsundere exposes a recent feed, not a search endpoint: fetch it once and filter locally.
        const queries = sourceId === "tsundere" ? [search.title] : search.queries;
        for (const variant of queries) {
          if (this.isClosed() || !this.isEnabled(sourceId)) {
            break;
          }
          // biome-ignore lint/performance/noAwaitInLoops: bound each provider's requests and preserve C411 rate limiting.
          const result = await this.discovery(variant, [sourceId]);
          for (const release of result.releases) {
            if (matchesDiscovery(search, release)) {
              releases.set(`${release.sourceId}:${release.id}`, release);
            }
          }
          const [error] = result.errors;
          if (error) {
            errors.set(sourceId, error);
            break;
          }
        }
      })
    );
    return {
      errors: [...errors.values()],
      releases: [...releases.values()]
        .filter((release) => !this.isClosed() && this.isEnabled(release.sourceId))
        .map((release) => this.publicRelease(release)),
      search,
    };
  }
  async animeReleases(mediaId: number): Promise<AniListReleases> {
    const entry = this.anilist.entry(mediaId);
    const sources = (["nyaa", "tsundere", "c411"] as const).filter((id) => this.isEnabled(id));
    const matcher = {
      ...interpretLocally(entry.title, "default", defaultAutomationPreferences),
      aliases: entry.aliases,
      excludePacks: false,
    };
    const results = await Promise.all(
      [...new Set([entry.title, ...entry.aliases])]
        .slice(0, 2)
        .map((title) => this.discovery(title, sources))
    );
    const stored = [...this.releases.values()].filter(
      (release) => localMatch(matcher, release) === null
    );
    const releases = [
      ...new Map(
        [...stored, ...results.flatMap((result) => result.releases)]
          .filter((release) => localMatch(matcher, release) === null)
          .map((release) => [`${release.sourceId}:${release.id}`, this.publicRelease(release)])
      ).values(),
    ];
    const hashes = new Set(releases.map((release) => release.infoHash));
    for (const release of stored) {
      if (release.infoHash) {
        hashes.add(release.infoHash);
      }
    }
    return {
      errors: [
        ...new Map(
          results.flatMap((result) => result.errors).map((error) => [error.sourceId, error])
        ).values(),
      ],
      releases,
      torrents: this.options
        .engine()
        .snapshot(null, false)
        .torrents.filter((torrent) => hashes.has(torrent.id)),
    };
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
      throw new UserError("Search for this release before adding it", { status: 404 });
    }
    const key = release.infoHash ?? `${sourceId}:${id}`;
    const pending = this.additions.get(key);
    if (pending) {
      return pending;
    }
    const task = this.downloadRelease(release, destinationId, paused, allowed);
    this.additions.set(key, task);
    try {
      return await task;
    } finally {
      this.additions.delete(key);
    }
  }
  private async downloadRelease(
    release: FeedRelease,
    destinationId: string,
    paused: boolean,
    allowed: (() => boolean) | undefined
  ) {
    if (!this.isEnabled(release.sourceId) || this.isClosed()) {
      throw new UserError("Plugin disabled", { status: 409 });
    }
    let input: string | Uint8Array = release.downloadUrl;
    if (!input.startsWith("magnet:")) {
      const controller = new AbortController();
      const active = this.requests.get(release.sourceId) ?? new Set<AbortController>();
      active.add(controller);
      this.requests.set(release.sourceId, active);
      const timeout = setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(input, { signal: controller.signal });
        if (!response.ok) {
          throw new UserError(`Torrent file unavailable (HTTP ${response.status})`, {
            status: 502,
          });
        }
        input = new Uint8Array(await response.arrayBuffer());
        if (input.byteLength > 8 * 1024 * 1024) {
          throw new UserError("Torrent file too large", { status: 400 });
        }
      } finally {
        clearTimeout(timeout);
        active.delete(controller);
      }
    }
    const parsed = await parseTorrent(input);
    if (parsed.infoHash && release.infoHash !== parsed.infoHash) {
      release.infoHash = parsed.infoHash;
      this.storeRelease(release);
    }
    if (this.isClosed() || !this.isEnabled(release.sourceId)) {
      throw new UserError("Plugin disabled", { status: 409 });
    }
    if (allowed && !allowed()) {
      throw new UserError("Automation changed or release ignored", { status: 409 });
    }
    const existing = this.options
      .engine()
      .snapshot(null, false)
      .torrents.find((torrent) => torrent.id === parsed.infoHash);
    if (existing) {
      return { id: existing.id };
    }
    return this.options.engine().add(input, { destinationId, paused });
  }
  private async askJev(state: object, questions: JevQuestions) {
    const plugin = this.plugins.get("jev");
    if (!(plugin?.enabled && plugin.apiKey)) {
      return null;
    }
    const key = Bun.SHA256.hash(JSON.stringify({ model: "jev-latest", questions, state }), "hex");
    const cached = this.db
      .select()
      .from(automationJudgements)
      .where(eq(automationJudgements.id, key))
      .get();
    if (cached && cached.createdAt > this.options.now() - 86_400_000) {
      return JSON.parse(cached.value) as JevResult;
    }
    const day = new Date(this.options.now()).toISOString().slice(0, 10);
    if (plugin.callsDay !== day) {
      plugin.callsDay = day;
      plugin.callsToday = 0;
    }
    if (plugin.callsToday >= plugin.dailyLimit) {
      throw new UserError("Jev daily limit reached", { status: 429 });
    }
    plugin.callsToday += 1;
    this.storePlugin(plugin);
    const controller = new AbortController();
    const active = this.requests.get("jev") ?? new Set<AbortController>();
    active.add(controller);
    this.requests.set("jev", active);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(this.options.endpoints.jev, {
        body: JSON.stringify({ model: "jev-latest", questions, state }),
        headers: { authorization: `Bearer ${plugin.apiKey}`, "content-type": "application/json" },
        method: "POST",
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new UserError(`Jev unavailable (HTTP ${response.status})`, { status: 503 });
      }
      const result = parseJevResponse(await response.json(), questions);
      if (this.isClosed() || !this.isEnabled("jev")) {
        throw new UserError("Jev plugin disabled", { status: 409 });
      }
      plugin.error = null;
      plugin.checkedAt = this.options.now();
      const judgement = { createdAt: this.options.now(), value: JSON.stringify(result) };
      this.db
        .insert(automationJudgements)
        .values({ id: key, ...judgement })
        .onConflictDoUpdate({ set: judgement, target: automationJudgements.id })
        .run();
      return result;
    } catch (cause) {
      if (plugin.enabled) {
        plugin.error = "Jev evaluation unavailable";
      }
      throw cause instanceof UserError
        ? cause
        : new UserError("Unable to connect to Jev", { status: 503 });
    } finally {
      clearTimeout(timeout);
      active.delete(controller);
    }
  }
  async interpret(query: string, destinationId: string): Promise<AutomationDraft> {
    const draft = interpretLocally(query, destinationId, this.preferences);
    const interpretation = interpretationQuestions(draft);
    const result = await this.askJev({ query }, interpretation.questions);
    if (!result) {
      return draft;
    }
    const read = <T>(id: string, values: T[], fallback: T) => {
      const answer = result.answers[id];
      return answer?.confidence !== undefined && answer.confidence >= 0.8
        ? (values[Number(answer.choice)] ?? fallback)
        : fallback;
    };
    return {
      ...draft,
      languages: read("languages", interpretation.languages, draft.languages),
      matchMode: "jev" as const,
      priority: read("priority", interpretation.priorities, draft.priority),
      resolutions: read("resolutions", interpretation.resolutions, draft.resolutions),
      sources: read("sources", interpretation.orders, draft.sources),
      title: read("title", interpretation.titles, draft.title),
    };
  }
  private async automationDiscovery(draft: AutomationDraft): Promise<DiscoveryResult> {
    let titles = [draft.title, ...(draft.aliases ?? [])];
    if (
      draft.matchMode === "jev" &&
      this.isEnabled("jev") &&
      !draft.aliases?.length &&
      draft.sources.some((sourceId) => sourceId !== "tsundere" && this.isEnabled(sourceId))
    ) {
      titles = await this.discoveryResolver.automationTitles(
        draft.title,
        this.options.endpoints.anilist ?? "https://graphql.anilist.co"
      );
    }
    const queries =
      draft.matchMode === "pattern"
        ? [""]
        : [...new Map(titles.map((title) => [normalizeTitle(title), title])).values()].slice(0, 2);
    const result: DiscoveryResult = { errors: [], releases: [] };
    await Promise.all(
      [...new Set(draft.sources)].map(async (sourceId) => {
        const variants = sourceId === "tsundere" ? queries.slice(0, 1) : queries;
        for (const [index, query] of variants.entries()) {
          if (this.isClosed() || !this.isEnabled(sourceId)) {
            break;
          }
          // biome-ignore lint/performance/noAwaitInLoops: try English only after the primary search has no acceptable match.
          const found = await this.discovery(query, [sourceId]);
          result.releases.push(...found.releases);
          result.errors.push(...found.errors);
          if (found.errors.length || index === variants.length - 1) {
            break;
          }
          if (await this.hasAutomationMatch(draft, found.releases)) {
            break;
          }
        }
      })
    );
    result.releases = [
      ...new Map(
        result.releases.map((release) => [`${release.sourceId}:${release.id}`, release])
      ).values(),
    ];
    return result;
  }
  private async hasAutomationMatch(draft: AutomationDraft, releases: FeedRelease[]) {
    for (const release of releases) {
      // biome-ignore lint/performance/noAwaitInLoops: stop evaluating once a primary match is accepted.
      if (!(await this.evaluate(draft, release)).reason) {
        return true;
      }
    }
    return false;
  }
  private async evaluate(draft: AutomationDraft, release: FeedRelease) {
    const reason = localMatch(draft, release);
    if (reason) {
      return { probability: null, reason, uncertain: false };
    }
    if (draft.matchMode !== "jev") {
      return { probability: null, reason: null, uncertain: false };
    }
    if (!this.isEnabled("jev")) {
      const fallback = localMatch({ ...draft, matchMode: "exact" }, release);
      return { probability: null, reason: fallback, uncertain: false };
    }
    const answer = await this.askJev(
      { query: draft.query, release: safeReleaseState(release) },
      matchQuestions()
    );
    const probability = Math.min(
      answer?.answers.identity?.noul ?? 0.5,
      answer?.answers.requirements?.noul ?? 0.5
    );
    return {
      probability,
      reason: probability < 0.75 ? "Jev match confidence below 75%" : null,
      uncertain: probability < 0.95,
    };
  }
  private persistRule(rule: AutomationRule, connection?: DatabaseConnection) {
    const db = connection ?? this.db;
    const value = JSON.stringify(rule);
    db.insert(automationRules)
      .values({ id: rule.id, value })
      .onConflictDoUpdate({ set: { value }, target: automationRules.id })
      .run();
    if (!connection) {
      this.rules.set(rule.id, rule);
    }
  }
  reassignDestination(id: string) {
    this.db.transaction((tx) => {
      for (const rule of this.rules.values()) {
        if (rule.destinationId === id) {
          rule.destinationId = "default";
          this.persistRule(rule, tx);
        }
      }
      this.anilist.reassignDestination(id, tx);
    });
  }
  private persistDecision(decision: AutomationDecision, connection?: DatabaseConnection) {
    const value = JSON.stringify(decision);
    const db = connection ?? this.db;
    db.insert(automationDecisions)
      .values({ id: decision.id, value })
      .onConflictDoUpdate({ set: { value }, target: automationDecisions.id })
      .run();
    if (!connection) {
      this.decisions.set(decision.id, decision);
    }
  }
  private rule(id: string) {
    const rule = this.rules.get(id);
    if (!rule) {
      throw new UserError("Unknown automation", { status: 404 });
    }
    return rule;
  }
  async save(id: string | null, draft: AutomationDraft) {
    const prepared = await this.prepareRule(id, draft);
    const rule = this.db.transaction((tx) => this.writeRule(tx, prepared));
    this.refreshState();
    return rule;
  }
  async prepareRule(id: string | null, draft: AutomationDraft): Promise<PreparedRule> {
    if (
      !this.options
        .engine()
        .snapshot(null, false)
        .destinations.some((destination) => destination.id === draft.destinationId)
    ) {
      throw new UserError("Unknown destination", { status: 400 });
    }
    if (draft.matchMode === "pattern") {
      if (draft.title.length > 256) {
        throw new UserError("Pattern too long", { status: 400 });
      }
      try {
        new RegExp(draft.title, "iu").test("");
      } catch (cause) {
        throw new UserError("Invalid pattern", { cause, status: 400 });
      }
    }
    if (!(draft.title.trim() && draft.sources.length)) {
      throw new UserError("Enter a title and at least one source", { status: 400 });
    }
    const previous = id ? this.rule(id) : null;
    const rule: AutomationRule = {
      ...draft,
      createdAt: previous?.createdAt ?? this.options.now(),
      deleteReplacedFiles: draft.deleteReplacedFiles === true,
      error: null,
      id: previous?.id ?? crypto.randomUUID(),
      lastRunAt: previous?.lastRunAt ?? null,
      nextRunAt: this.options.now(),
      status: "active",
    };
    const baseline: AutomationDecision[] = [];
    if (!(previous || draft.includeExisting)) {
      const result = await this.automationDiscovery(draft);
      for (const release of result.releases) {
        // biome-ignore lint/performance/noAwaitInLoops: validate identity before recording a baseline; stop on provider failure.
        const evaluation = await this.evaluate(draft, release);
        if (!(evaluation.reason || evaluation.uncertain)) {
          baseline.push({
            automationId: rule.id,
            contentKey: contentKey(release),
            createdAt: this.options.now(),
            deadline: null,
            id: `${rule.id}:${contentKey(release)}`,
            probability: null,
            reason: "Present before the rule was enabled",
            release,
            status: "ignored",
            torrentId: null,
          });
        }
      }
    }
    return { baseline, rule };
  }
  writeRule(tx: DatabaseTransaction, prepared: PreparedRule) {
    for (const decision of prepared.baseline) {
      this.persistDecision(decision, tx);
    }
    this.persistRule(prepared.rule, tx);
    return prepared.rule;
  }
  deleteRule(tx: DatabaseConnection, id: string) {
    this.rule(id);
    tx.delete(automationRules).where(eq(automationRules.id, id)).run();
    return { ok: true };
  }
  remove(id: string) {
    const result = this.deleteRule(this.db, id);
    this.rules.delete(id);
    return result;
  }
  async preview(draft: AutomationDraft) {
    const result = await this.automationDiscovery(draft);
    const evaluated = await Promise.all(
      result.releases.map(async (release) => ({
        release,
        ...(await this.evaluate(draft, release)),
      }))
    );
    const candidates = evaluated.filter(
      (candidate) =>
        !candidate.reason && (candidate.probability === null || candidate.probability >= 0.75)
    );
    return {
      ...result,
      candidates: candidates
        .sort((a, b) => compareReleases(draft, a.release, b.release))
        .map((candidate) => ({ ...candidate, release: this.publicRelease(candidate.release) })),
      releases: candidates.map((candidate) => this.publicRelease(candidate.release)),
    };
  }
  async run(id: string): Promise<AutomationState> {
    const existing = this.runs.get(id);
    if (existing) {
      return existing;
    }
    const rule = this.rule(id);
    const task = this.execute(rule).catch(() => {
      if (!this.isClosed() && this.rules.get(id) === rule) {
        rule.error = "Check interrupted; retry scheduled";
        rule.nextRunAt = this.options.now() + 60_000;
        this.persistRule(rule);
      }
      return this.snapshot();
    });
    this.runs.set(id, task);
    try {
      return await task;
    } finally {
      this.runs.delete(id);
    }
  }
  private async candidateGroups(rule: AutomationRule, releases: FeedRelease[]) {
    const candidates = new Map(
      releases.map((release) => [`${release.sourceId}:${release.id}`, release])
    );
    for (const decision of this.decisions.values()) {
      if (
        decision.automationId === rule.id &&
        ["waiting", "adding", "error"].includes(decision.status) &&
        this.isEnabled(decision.release.sourceId)
      ) {
        candidates.set(`${decision.release.sourceId}:${decision.release.id}`, decision.release);
      }
    }
    const groups = new Map<string, FeedRelease[]>();
    const evaluations = new Map<string, Awaited<ReturnType<AutomationService["evaluate"]>>>();
    const handledHashes = new Set(
      [...this.decisions.values()]
        .filter((decision) => decision.status === "added")
        .map((decision) => decision.torrentId)
    );
    const torrentIds = new Set(
      this.options
        .engine()
        .snapshot(null, false)
        .torrents.map((torrent) => torrent.id)
    );
    for (const [key, release] of candidates) {
      const previous = this.decisions.get(`${rule.id}:${contentKey(release)}`);
      const current = previous?.status === "added" ? previous : previous?.supersedes;
      if (
        (previous?.status === "added" && previous.supersedes) ||
        previous?.status === "ignored" ||
        (current &&
          (!(current.torrentId && torrentIds.has(current.torrentId)) ||
            preferred(rule, current.release) ||
            compareQuality(rule, release, current.release) >= 0)) ||
        (release.infoHash !== null && handledHashes.has(release.infoHash))
      ) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: charge the quota before evaluating each candidate; stop on provider failure.
      const evaluation = await this.evaluate(rule, release);
      if (evaluation.reason) {
        continue;
      }
      evaluations.set(key, evaluation);
      const group = groups.get(contentKey(release)) ?? [];
      group.push(release);
      groups.set(contentKey(release), group);
    }
    return { evaluations, groups };
  }
  private choose(
    rule: AutomationRule,
    key: string,
    releases: FeedRelease[],
    evaluations: Map<string, Awaited<ReturnType<AutomationService["evaluate"]>>>
  ) {
    const id = `${rule.id}:${key}`;
    const previous = this.decisions.get(id);
    const [release] = releases.sort((a, b) => compareReleases(rule, a, b));
    if (
      !release ||
      previous?.status === "ignored" ||
      this.isClosed() ||
      this.rules.get(rule.id) !== rule ||
      !this.isEnabled(release.sourceId)
    ) {
      return null;
    }
    const evaluation = evaluations.get(`${release.sourceId}:${release.id}`);
    const deadline = previous?.deadline ?? this.options.now() + rule.waitMinutes * 60_000;
    let status: AutomationDecision["status"] = "adding";
    if (!rule.automatic || evaluation?.uncertain) {
      status = "review";
    } else if (!preferred(rule, release) && this.options.now() < deadline) {
      status = "waiting";
    }
    return {
      automationId: rule.id,
      contentKey: key,
      createdAt: previous?.createdAt ?? this.options.now(),
      deadline,
      id,
      probability: evaluation?.probability ?? null,
      reason: evaluation?.uncertain
        ? "Uncertain Jev match — review required"
        : "Title and formats accepted · ranked by priority",
      release,
      status,
      supersedes:
        previous?.status === "added" && previous.torrentId
          ? { release: previous.release, torrentId: previous.torrentId }
          : (previous?.supersedes ?? null),
      torrentId: null,
    } satisfies AutomationDecision;
  }
  private async execute(rule: AutomationRule) {
    if (!rule.enabled || this.isClosed()) {
      return this.snapshot();
    }
    await this.completeReplacements(rule);
    const result = await this.automationDiscovery(rule);
    if (this.isClosed() || this.rules.get(rule.id) !== rule) {
      return this.snapshot();
    }
    const { groups, evaluations } = await this.candidateGroups(rule, result.releases);
    for (const [key, releases] of groups) {
      const decision = this.choose(rule, key, releases, evaluations);
      if (!decision) {
        continue;
      }
      this.persistDecision(decision);
      if (decision.status === "adding") {
        // biome-ignore lint/performance/noAwaitInLoops: serialize additions so persisted decisions agree with the torrent engine.
        await this.addDecision(decision, rule);
      }
    }
    if (!this.isClosed() && this.rules.get(rule.id) === rule) {
      rule.lastRunAt = this.options.now();
      rule.nextRunAt = rule.lastRunAt + rule.intervalMinutes * 60_000;
      rule.error = result.errors.length
        ? result.errors.map((error) => error.message).join(" · ")
        : null;
      this.persistRule(rule);
    }
    return this.snapshot();
  }
  private async completeReplacements(rule: AutomationRule) {
    const existing = this.replacements.get(rule.id);
    if (existing) {
      return existing;
    }
    const task = this.finishReplacements(rule);
    this.replacements.set(rule.id, task);
    try {
      await task;
    } finally {
      this.replacements.delete(rule.id);
    }
  }
  private async finishReplacements(rule: AutomationRule) {
    for (const decision of this.decisions.values()) {
      if (
        decision.automationId !== rule.id ||
        decision.status !== "added" ||
        !decision.supersedes ||
        !rule.enabled ||
        this.isClosed() ||
        this.rules.get(rule.id) !== rule
      ) {
        continue;
      }
      const { torrents } = this.options.engine().snapshot(null, false);
      const current = torrents.find((torrent) => torrent.id === decision.torrentId);
      if (current?.progress !== 1 || current.error) {
        continue;
      }
      const oldId = decision.supersedes.torrentId;
      const shared = [...this.decisions.values()].some(
        (other) =>
          other !== decision && (other.torrentId === oldId || other.supersedes?.torrentId === oldId)
      );
      try {
        if (
          oldId !== decision.torrentId &&
          !shared &&
          torrents.some((torrent) => torrent.id === oldId)
        ) {
          // biome-ignore lint/performance/noAwaitInLoops: finish each persisted replacement before the next.
          await this.options.engine().remove(oldId, rule.deleteReplacedFiles === true);
        }
        decision.supersedes = null;
        if (shared) {
          decision.reason = "Better version downloaded · old version used by another rule";
        } else {
          decision.reason =
            rule.deleteReplacedFiles === true
              ? "Better version downloaded · old files deleted"
              : "Better version downloaded · old files kept";
        }
      } catch {
        decision.reason = "Better version downloaded · retry removing the old version";
      }
      if (!this.isClosed()) {
        this.persistDecision(decision);
      }
    }
  }
  private async addDecision(decision: AutomationDecision, rule: AutomationRule) {
    if (
      this.isClosed() ||
      !this.plugins.get(decision.release.sourceId)?.enabled ||
      !rule.enabled ||
      this.rules.get(rule.id) !== rule
    ) {
      return;
    }
    try {
      const existing = this.options
        .engine()
        .snapshot(null, false)
        .torrents.find((item) => item.id === decision.release.infoHash);
      const torrent =
        existing ??
        (await this.addRelease(
          decision.release.sourceId,
          decision.release.id,
          rule.destinationId,
          rule.paused,
          () =>
            this.rules.get(rule.id) === rule &&
            rule.enabled &&
            this.decisions.get(decision.id) === decision &&
            decision.status !== "ignored"
        ));
      decision.torrentId = torrent.id;
      decision.status = "added";
      if (existing) {
        decision.reason = "Already in the library";
      } else {
        decision.reason = decision.supersedes
          ? "Better version added · old version kept until the download completes"
          : "Added to the thread folder";
      }
    } catch {
      if (decision.status === "ignored") {
        return;
      }
      decision.status = "error";
      decision.reason = "Unable to add the torrent; retrying on the next check";
    }
    if (!this.isClosed() && this.decisions.get(decision.id) === decision) {
      this.persistDecision(decision);
    }
  }
  async approve(id: string) {
    const decision = this.decisions.get(id);
    if (!decision) {
      throw new UserError("Unknown release", { status: 404 });
    }
    if (decision.status === "added" || decision.status === "ignored") {
      return this.snapshot();
    }
    await this.addDecision(decision, this.rule(decision.automationId));
    return this.snapshot();
  }
  ignore(id: string) {
    this.ignoreDecision(this.db, id);
    this.refreshState();
    return this.snapshot();
  }
  ignoreDecision(tx: DatabaseConnection, id: string) {
    const decision = this.decisions.get(id);
    if (!decision) {
      throw new UserError("Unknown release", { status: 404 });
    }
    this.persistDecision({ ...decision, reason: "Ignored manually", status: "ignored" }, tx);
    return { ok: true };
  }
  async start() {
    if (this.startupState.started || this.isClosed()) {
      return;
    }
    this.startupState.started = true;
    try {
      await this.anilist.tick(true);
      await Promise.all(
        [...this.rules.values()].filter((rule) => rule.enabled).map((rule) => this.run(rule.id))
      );
    } finally {
      if (!this.isClosed()) {
        this.timer = setInterval(() => {
          void this.tick().catch(console.error);
        }, 15_000);
        this.timer.unref();
      }
    }
  }
  async tick() {
    if (this.isClosed()) {
      return;
    }
    await this.anilist.tick(false);
    await Promise.all(
      [...this.rules.values()]
        .filter((rule) => rule.enabled && !this.runs.has(rule.id))
        .map((rule) => this.completeReplacements(rule))
    );
    await Promise.all(
      [...this.rules.values()]
        .filter(
          (rule) =>
            rule.enabled &&
            (rule.nextRunAt === null ||
              rule.nextRunAt <= this.options.now() ||
              [...this.decisions.values()].some(
                (decision) =>
                  decision.automationId === rule.id &&
                  decision.status === "waiting" &&
                  decision.deadline !== null &&
                  decision.deadline <= this.options.now()
              ))
        )
        .map((rule) => this.run(rule.id))
    );
  }
  async close() {
    this.discoveryResolver.close();
    if (this.isClosed()) {
      return;
    }
    this.closed = true;
    await this.anilist.close();
    if (this.timer) {
      clearInterval(this.timer);
    }
    for (const requests of this.requests.values()) {
      for (const controller of requests) {
        controller.abort();
      }
    }
    await Promise.allSettled(this.runs.values());
    await Promise.allSettled(this.replacements.values());
    await Promise.allSettled(this.additions.values());
    if (this.ownsDatabase) {
      this.db.$client.close();
    }
  }
}
