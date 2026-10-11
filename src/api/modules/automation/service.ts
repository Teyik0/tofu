import { eq } from "drizzle-orm";
import { HTTPError } from "elysia";
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
  AniListMedia,
  AniListReleases,
  AutomationDecision,
  AutomationDraft,
  AutomationPreferences,
  AutomationRule,
  AutomationState,
  DiscoveryResult,
  DiscoverySearch,
  EnginePort,
  FeedRelease,
  PluginId,
  SourcePluginId,
  StoredPlugin,
} from "../../../types";
import {
  type DatabaseConnection,
  type DatabaseTransaction,
  openDatabase,
  type TofuDatabase,
} from "../../lib/db";
import { refreshRecords } from "../../lib/persisted-cache";
import { AniListService } from "../anilist/service";
import {
  animeEpisodeOffset,
  animeEpisodeRelease,
  animeQueries,
  animeReleaseCandidate,
  animeSearchPlan,
  animeSeriesTitle,
  localAnimeSearch,
  matchesAnimeRelease,
} from "../discovery/anime";
import {
  classicDiscovery,
  DiscoveryResolver,
  discoveryCandidate,
  matchesClassicDiscovery,
  matchesDiscovery,
  parseDiscovery,
} from "../discovery/service";
import { collectSourceQueries, uniqueReleases } from "../discovery/sources";
import {
  animeSearchQuestions,
  discoveryMatchQuestions,
  discoveryTitleQuestions,
  interpretationQuestions,
  type JevAnswer,
  type JevQuestions,
  type JevResult,
  matchQuestions,
  safeReleaseState,
} from "../jev/service";
import { ProviderAccess } from "../plugins/providers";
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

function confidentAnimeNumber(answer: JevAnswer | undefined) {
  if ((answer?.confidence ?? 0) < 0.8) {
    return null;
  }
  const value = Number(answer?.choice);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export interface AutomationOptions {
  anilistClient?: AniListClient;
  dataDir: string;
  endpoints: PluginEndpoints;
  engine: () => EnginePort;
  now: () => number;
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
  private readonly providers: ProviderAccess;
  private readonly rules = new Map<string, AutomationRule>();
  private readonly decisions = new Map<string, AutomationDecision>();
  private readonly runs = new Map<string, Promise<AutomationState>>();
  private readonly replacements = new Map<string, Promise<void>>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly startupState: { started: boolean } = { started: false };
  private readonly releases = new Map<string, FeedRelease>();
  private readonly additions = new Map<string, Promise<{ id: string }>>();
  private readonly discoveryResolver = new DiscoveryResolver();
  private preferences: AutomationPreferences = defaultAutomationPreferences;

  readonly options: AutomationOptions;
  readonly anilist: AniListService;
  private readonly ownsDatabase: boolean;
  private constructor(options: AutomationOptions, db: TofuDatabase, ownsDatabase: boolean) {
    this.options = options;
    this.providers = new ProviderAccess({
      ...options,
      isClosed: () => this.isClosed(),
      plugins: this.plugins,
      storePlugin: (plugin) => this.storePlugin(plugin),
    });
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
        db.$client.close(true);
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
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown plugin");
    }
    const next = {
      ...plugin,
      ...input,
      apiKey: input.apiKey === undefined ? plugin.apiKey : input.apiKey.trim(),
      error: null,
    };
    if (next.enabled && (id === "c411" || id === "jev") && !next.apiKey) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Add your API key before enabling this plugin");
    }
    this.plugins.set(next.id, next);
    if (!next.enabled) {
      this.providers.abort(next.id);
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
      await this.providers.fetchSource(id, "");
    } else {
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown plugin");
    }
    return this.snapshot();
  }
  async connectPlugin(
    id: string,
    input: { apiKey?: string; enabled: boolean; dailyLimit?: number }
  ) {
    if (id !== "c411" && id !== "jev") {
      throw new (HTTPError.id("BAD_REQUEST", 400))("This plugin does not use an API key");
    }
    const plugin = this.plugins.get(id);
    if (!plugin || this.isClosed()) {
      throw new (HTTPError.id("CONFLICT", 409))("Plugin unavailable");
    }
    try {
      const apiKey = await this.providers.validateCredential(id, input.apiKey ?? "", plugin);
      this.configure(id, { ...input, apiKey });
      const updated = this.plugins.get(id);
      if (updated) {
        updated.checkedAt = this.options.now();
        this.storePlugin(updated);
      }
      return this.snapshot();
    } catch (cause) {
      throw cause instanceof HTTPError
        ? cause
        : new (HTTPError.id("BAD_GATEWAY", 502))(
            `Unable to validate your ${id === "c411" ? "C411" : "TypeSafe"} API key. Check your connection and try again.`
          );
    }
  }

  private async discovery(query: string, sources: SourcePluginId[]): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { errors: [], releases: [] };
    await Promise.all(
      [...new Set(sources)].map(async (sourceId) => {
        try {
          result.releases.push(...(await this.providers.fetchSource(sourceId, query)));
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
    const interpretation = discoveryTitleQuestions(search.title);
    let semantic = true;
    try {
      const result = await this.askJev({ query }, interpretation.questions);
      const answer = result?.answers.title;
      const title = interpretation.titles[Number(answer?.choice)];
      if (title && answer?.confidence !== undefined && answer.confidence >= 0.8) {
        search.title = title;
        search.aliases = [title];
      }
    } catch {
      semantic = false;
      search.warning = "Jev interpretation unavailable; searching with the entered title.";
    }
    await this.discoveryResolver.resolve(
      search,
      this.options.endpoints.anilist ?? "https://graphql.anilist.co"
    );
    if (!search.queries.length) {
      search.queries = [search.title];
    }
    const result = await collectSourceQueries({
      accept: (release) => discoveryCandidate(search, release),
      active: (source) => !this.isClosed() && this.isEnabled(source),
      enough: () => Promise.resolve(false),
      queries: (source) => (source === "tsundere" ? [search.title] : search.queries),
      search: (variant, source) => this.discovery(variant, [source]),
      sources: active,
    });
    const candidates = uniqueReleases(result.releases);
    const ranked = semantic
      ? await this.rankDiscovery(query, search, candidates, (release) =>
          matchesDiscovery(search, release)
        )
      : candidates.filter((release) => matchesDiscovery(search, release));
    return {
      errors: result.errors,
      releases: ranked
        .filter((release) => !this.isClosed() && this.isEnabled(release.sourceId))
        .map((release) => this.publicRelease(release)),
      search,
    };
  }

  private async rankDiscovery(
    query: string,
    search: DiscoverySearch,
    releases: FeedRelease[],
    locallyMatches: (release: FeedRelease) => boolean
  ) {
    const ranked: { probability: number; release: FeedRelease }[] = [];
    for (let offset = 0; offset < releases.length; offset += 20) {
      if (this.isClosed()) {
        return [];
      }
      const batch = releases.slice(offset, offset + 20);
      try {
        // biome-ignore lint/performance/noAwaitInLoops: bound model requests and respect the daily budget.
        const result = await this.askJev(
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
        if (!result) {
          throw new Error("Jev disabled");
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
      } catch {
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
    }
    return ranked
      .sort(
        (a, b) =>
          b.probability - a.probability || (b.release.seeders ?? -1) - (a.release.seeders ?? -1)
      )
      .map(({ release }) => release);
  }
  private async animeSearch(entry: AniListMedia) {
    const interpretation = animeSearchQuestions(entry);
    const fallback = localAnimeSearch(entry);
    try {
      const result = await this.askJev(
        { anime: { aliases: entry.aliases, titles: interpretation.titles } },
        interpretation.questions
      );
      if (!result) {
        return fallback;
      }
      const season = fallback.season ?? confidentAnimeNumber(result.answers.season);
      const titles = interpretation.prefixes.map((values, index) => {
        const answer = result.answers[`title_${index}`];
        const original = fallback.seriesTitles[index] ?? fallback.seriesTitles[0] ?? entry.title;
        // Equivalent prefixes can split confidence; manual searches still verify each release.
        return answer?.confidence !== undefined && answer.confidence >= 0.5
          ? animeSeriesTitle(values[Number(answer.choice)] ?? original, season)
          : original;
      });
      const part = fallback.part ?? confidentAnimeNumber(result.answers.part);
      return animeSearchPlan(entry, titles, season, part);
    } catch {
      return {
        ...fallback,
        warning: "Jev search interpretation unavailable; searching with local title matching.",
      };
    }
  }
  async animeReleases(mediaId: number): Promise<AniListReleases> {
    const original = await this.anilist.media(mediaId);
    const plan = await this.animeSearch(original);
    const { entry, titles } = plan;
    const sources = (["nyaa", "tsundere", "c411"] as const).filter((id) => this.isEnabled(id));
    const { preferences } = this;
    const offset = animeEpisodeOffset(entry, this.anilist.snapshot().entries);
    const contextual = (release: FeedRelease) => animeEpisodeRelease(entry, offset, release);
    const result = await collectSourceQueries({
      accept: () => true,
      active: () => true,
      enough: () => Promise.resolve(false),
      queries: (source) => {
        if (source === "nyaa") {
          return animeQueries(entry, preferences, titles);
        }
        return source === "tsundere" ? titles.slice(0, 1) : titles;
      },
      search: (sourceQuery, source) => this.discovery(sourceQuery, [source]),
      sources,
    });
    const matches = (release: FeedRelease) => matchesAnimeRelease(entry, preferences, release);
    const stored = [...this.releases.values()]
      .map(contextual)
      .filter((release): release is FeedRelease => release !== null)
      .filter(matches);
    const candidates = [
      ...new Map(
        [...stored, ...result.releases]
          .map(contextual)
          .filter((release): release is FeedRelease => release !== null)
          .filter((release) => animeReleaseCandidate(entry, preferences, release))
          .map((release) => [`${release.sourceId}:${release.id}`, this.publicRelease(release)])
      ).values(),
    ];
    const search = {
      ...classicDiscovery(original.title),
      aliases: entry.aliases,
      resolved: true,
      season: plan.season,
      warning: plan.warning,
    };
    const jev = this.plugins.get("jev");
    const query = `Find releases for "${entry.title}". Allowed languages: ${preferences.languages.join(", ") || "any"}. Allowed resolutions: ${preferences.resolutions.join(", ") || "any"}. Allowed codecs: ${preferences.codecs.join(", ") || "any"}. ${offset ? `The preceding parts have ${offset} episodes; sourceEpisode uses continuous numbering and episode is relative to this part.` : ""}`;
    const ranked =
      jev?.enabled && jev.apiKey
        ? await this.rankDiscovery(query, search, candidates, matches)
        : candidates.filter(matches);
    const matcher = { ...interpretLocally(entry.title, "default", preferences), season: null };
    const releases = ranked
      .filter((release) => !this.isClosed() && this.isEnabled(release.sourceId))
      .sort((a, b) => compareReleases(matcher, a, b));
    const hashes = new Set(releases.map((release) => release.infoHash));
    for (const release of stored) {
      if (release.infoHash) {
        hashes.add(release.infoHash);
      }
    }
    return {
      errors: result.errors,
      releases,
      search,
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
      throw new (HTTPError.id("NOT_FOUND", 404))("Search for this release before adding it");
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
      throw new (HTTPError.id("CONFLICT", 409))("Plugin disabled");
    }
    let input: string | Uint8Array = release.downloadUrl;
    if (!input.startsWith("magnet:")) {
      input = await this.providers.downloadFile(release);
    }
    const parsed = await parseTorrent(input);
    if (parsed.infoHash && release.infoHash !== parsed.infoHash) {
      release.infoHash = parsed.infoHash;
      this.storeRelease(release);
    }
    if (this.isClosed() || !this.isEnabled(release.sourceId)) {
      throw new (HTTPError.id("CONFLICT", 409))("Plugin disabled");
    }
    if (allowed && !allowed()) {
      throw new (HTTPError.id("CONFLICT", 409))("Automation changed or release ignored");
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
    const result = await this.providers.evaluate(state, questions, plugin);
    const judgement = { createdAt: this.options.now(), value: JSON.stringify(result) };
    this.db
      .insert(automationJudgements)
      .values({ id: key, ...judgement })
      .onConflictDoUpdate({ set: judgement, target: automationJudgements.id })
      .run();
    return result;
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
    const result = await collectSourceQueries({
      accept: () => true,
      active: (source) => !this.isClosed() && this.isEnabled(source),
      enough: (releases) => this.hasAutomationMatch(draft, releases),
      queries: (source) => (source === "tsundere" ? queries.slice(0, 1) : queries),
      search: (query, source) => this.discovery(query, [source]),
      sources: draft.sources,
    });
    return { ...result, releases: uniqueReleases(result.releases) };
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
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown automation");
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
      throw new (HTTPError.id("BAD_REQUEST", 400))("Unknown destination");
    }
    if (draft.matchMode === "pattern") {
      if (draft.title.length > 256) {
        throw new (HTTPError.id("BAD_REQUEST", 400))("Pattern too long");
      }
      try {
        new RegExp(draft.title, "iu").test("");
      } catch (cause) {
        throw new (HTTPError.id("BAD_REQUEST", 400))("Invalid pattern", { cause });
      }
    }
    if (!(draft.title.trim() && draft.sources.length)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Enter a title and at least one source");
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
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown release");
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
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown release");
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
    this.providers.close();
    await Promise.allSettled(this.runs.values());
    await Promise.allSettled(this.replacements.values());
    await Promise.allSettled(this.additions.values());
    if (this.ownsDatabase) {
      this.db.$client.close(true);
    }
  }
}
