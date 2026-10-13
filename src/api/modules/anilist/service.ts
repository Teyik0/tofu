import { isAbsolute, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { HTTPError } from "elysia";
import { anilistState } from "../../../db/schema";
import type {
  AniListCatalog,
  AniListCatalogFilters,
  AniListCatalogOptions,
  AniListClient,
  AniListEditor,
  AniListEntry,
  AniListListUpdate,
  AniListMedia,
  AniListReleases,
  AniListState,
  AniListStatus,
  AniListSubscription,
  AniListThreadProposal,
  AutomationDraft,
  Destination,
  EnginePort,
  FeedRelease,
} from "../../../types";
import type { DatabaseConnection, TofuDatabase } from "../../lib/db";
import { recordLog } from "../../lib/diagnostics";
import { refreshRecords } from "../../lib/persisted-cache";
import type { ReleaseAutomationService } from "../automation/integration";
import { compareReleases, interpretLocally } from "../automation/rules";
import type { AutomationService } from "../automation/service";
import { classicDiscovery, type DiscoveryService } from "../discovery/service";
import { collectSourceQueries } from "../discovery/sources";
import type { JevService } from "../jev/service";
import { animeSearchQuestions, type JevAnswer } from "../jev/service";
import { publicRelease } from "../plugins/releases";
import type { PluginsService } from "../plugins/service";
import { catalogMedia, catalogVariables } from "./catalog";
import { editorState, validateEntryUpdate } from "./editor";
import type { LibraryQuery } from "./graphql/generated";
import { createAniListSdk } from "./graphql/transport";
import { AniListAuthorization } from "./oauth";
import {
  animeEpisodeOffset,
  animeEpisodeRelease,
  animeQueries,
  animeReleaseCandidate,
  animeSearchPlan,
  animeSeriesTitle,
  localAnimeSearch,
  matchesAnimeRelease,
} from "./releases";

interface AniListOptions {
  automation: AutomationService;
  client?: AniListClient;
  discovery: DiscoveryService;
  endpoint: string;
  engine: EnginePort;
  jev: JevService;
  now: () => number;
  plugins: PluginsService;
  releaseAutomation: ReleaseAutomationService;
  tokenEndpoint: string;
}
interface AniListConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  userName: string;
}
interface AniListCache {
  account: { id: number; name: string };
  entries: AniListEntry[];
  key: string;
  updatedAt: number;
}
export function isAniListStatus(value: string | null): value is AniListStatus {
  return (
    value !== null &&
    ["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"].includes(value)
  );
}

function confidentAnimeNumber(answer: JevAnswer | undefined) {
  if ((answer?.confidence ?? 0) < 0.8) {
    return null;
  }
  const value = Number(answer?.choice);
  return Number.isInteger(value) && value > 0 ? value : null;
}

const folderMarks = /\p{M}/gu;
const folderSeparators = /[^a-z0-9]+/g;
const folderEdges = /^-+|-+$/g;
function animeFolder(entry: AniListEntry) {
  return (
    entry.title
      .normalize("NFKD")
      .replace(folderMarks, "")
      .toLowerCase()
      .replace(folderSeparators, "-")
      .replace(folderEdges, "") || `anime-${entry.mediaId}`
  );
}

function collectEntries(
  collection: NonNullable<LibraryQuery["MediaListCollection"]>,
  found: Map<number, AniListEntry>
) {
  for (const group of collection.lists ?? []) {
    for (const entry of group?.entries ?? []) {
      if (!(entry?.media && isAniListStatus(entry.status))) {
        continue;
      }
      if (entry.progress === null) {
        continue;
      }
      const media = catalogMedia(entry.media);
      const aliases = media.aliases.slice(0, 30);
      const [title] = aliases;
      if (!title) {
        continue;
      }
      found.set(media.mediaId, {
        ...media,
        aliases,
        automationId: null,
        completedEpisodes: [],
        genres: media.genres.slice(0, 30),
        progress: Math.max(0, entry.progress),
        status: entry.status,
        title,
      });
    }
  }
}

export class AniListService {
  private config: AniListConfig = {
    clientId: "9037",
    clientSecret: "",
    redirectUri: "tofu://oauth/anilist",
    userName: "",
  };
  private visibleStatuses: AniListStatus[] = ["CURRENT", "PLANNING"];
  private entries: AniListEntry[] = [];
  private connectedUser: string | null = null;
  private account: { id: number; name: string } | null = null;
  private cache: AniListCache | null = null;
  private listFlight: { key: string; promise: Promise<AniListState> } | null = null;
  private refreshError: string | null = null;
  private retryAt = 0;
  private readonly selections = new Map<string, boolean>();
  private readonly watched = new Map<string, number[]>();
  private readonly animeRules = new Map<string, string>();
  private readonly episodeRuns = new Map<number, Promise<unknown>>();
  private listRevision = 0;
  private readonly subscriptions = new Map<string, AniListSubscription>();
  private readonly runs = new Map<string, Promise<AniListState>>();
  private readonly destinationRuns = new Map<string, Promise<Destination>>();
  private readonly requests = new Set<AbortController>();
  private readonly lifecycle: { closed: boolean; started: boolean } = {
    closed: false,
    started: false,
  };
  private timer: ReturnType<typeof setInterval> | null = null;
  private callbackServer: ReturnType<typeof Bun.serve> | null = null;
  private callbackTimeout: ReturnType<typeof setTimeout> | null = null;
  private oauthState: string | null = null;
  private readonly authorization: AniListAuthorization;
  private readonly db: TofuDatabase;
  private readonly options: AniListOptions;
  private readonly sdk: ReturnType<typeof createAniListSdk>;
  constructor(db: TofuDatabase, options: AniListOptions) {
    this.db = db;
    this.options = options;
    this.sdk = createAniListSdk(options.endpoint, () => options.plugins.plugin("anilist").apiKey);
    this.authorization = new AniListAuthorization((token, current) =>
      this.authorize(token, current)
    );
    this.restore();
    if (
      options.client &&
      (this.config.clientId === "9037" || this.config.redirectUri.startsWith("tofu"))
    ) {
      this.config = { ...this.config, ...options.client, clientSecret: "" };
    } else if (
      this.config.clientId === "9037" &&
      this.config.redirectUri === "http://localhost:3000/"
    ) {
      this.config.redirectUri = "tofu://oauth/anilist";
      this.config.clientSecret = "";
    }
    this.checkCacheIdentity();
    if (this.cache) {
      this.entries = this.cache.entries;
      this.account = this.cache.account;
      this.connectedUser = this.account.name;
    }
  }
  private async animeSearch(entry: AniListMedia) {
    const interpretation = animeSearchQuestions(entry);
    const fallback = localAnimeSearch(entry);
    try {
      const result = await this.options.jev.evaluate(
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
  async releases(mediaId: number): Promise<AniListReleases> {
    const original = await this.media(mediaId);
    const library = this.snapshot().entries;
    const plan = await this.animeSearch(original);
    const { entry, titles } = plan;
    const sources = (["nyaa", "tsundere", "c411"] as const).filter(
      (id) => this.options.plugins.plugin(id).enabled
    );
    const { preferences } = this.options.automation.snapshot();
    const offset = animeEpisodeOffset(entry, library);
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
      search: (sourceQuery, source) => this.options.discovery.search(sourceQuery, [source]),
      sources,
    });
    const matches = (release: FeedRelease) => matchesAnimeRelease(entry, preferences, release);
    const stored = this.options.discovery
      .cachedReleases()
      .map(contextual)
      .filter((release): release is FeedRelease => release !== null)
      .filter(matches);
    const candidates = [
      ...new Map(
        [...stored, ...result.releases]
          .map(contextual)
          .filter((release): release is FeedRelease => release !== null)
          .filter((release) => animeReleaseCandidate(entry, preferences, release))
          .map((release) => [`${release.sourceId}:${release.id}`, publicRelease(release)])
      ).values(),
    ];
    const search = {
      ...classicDiscovery(original.title),
      aliases: entry.aliases,
      resolved: true,
      season: plan.season,
      warning: plan.warning,
    };
    const jev = this.options.plugins.plugin("jev");
    const query = `Find releases for "${entry.title}". Allowed languages: ${preferences.languages.join(", ") || "any"}. Allowed resolutions: ${preferences.resolutions.join(", ") || "any"}. Allowed codecs: ${preferences.codecs.join(", ") || "any"}. ${offset ? `The preceding parts have ${offset} episodes; sourceEpisode uses continuous numbering and episode is relative to this part.` : ""}`;
    const ranked =
      jev?.enabled && jev.apiKey
        ? await this.options.discovery.rank(query, search, candidates, matches)
        : candidates.filter(matches);
    const matcher = { ...interpretLocally(entry.title, "default", preferences), season: null };
    const releases = ranked
      .filter(
        (release) => !this.lifecycle.closed && this.options.plugins.plugin(release.sourceId).enabled
      )
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
      torrents: this.options.engine
        .snapshot(null, false)
        .torrents.filter((torrent) => hashes.has(torrent.id)),
    };
  }
  private restore() {
    for (const row of this.db.select().from(anilistState).all()) {
      if (row.id === "preferences") {
        this.visibleStatuses = JSON.parse(row.value) as AniListStatus[];
      } else if (row.id === "config") {
        this.config = { ...this.config, ...(JSON.parse(row.value) as AniListConfig) };
        this.config.clientId ||= "9037";
      } else if (row.id === "profile") {
        this.account = JSON.parse(row.value) as { id: number; name: string };
      } else if (row.id === "list-cache") {
        this.cache = JSON.parse(row.value) as AniListCache;
      } else if (row.id.startsWith("anime-rule:")) {
        this.animeRules.set(row.id, JSON.parse(row.value) as string);
      } else if (row.id.startsWith("watched:")) {
        this.watched.set(row.id, JSON.parse(row.value) as number[]);
      } else if (row.id.startsWith("selection:")) {
        this.selections.set(row.id, JSON.parse(row.value) === true);
      } else {
        const subscription = JSON.parse(row.value) as AniListSubscription;
        this.subscriptions.set(subscription.id, subscription);
      }
    }
  }
  private writeState(id: string, value: string, connection?: DatabaseConnection) {
    const db = connection ?? this.db;
    db.insert(anilistState)
      .values({ id, value })
      .onConflictDoUpdate({ set: { value }, target: anilistState.id })
      .run();
  }
  private cacheKey() {
    const token = this.options.plugins.plugin("anilist").apiKey;
    return Bun.SHA256.hash(
      JSON.stringify([
        this.options.endpoint,
        token ? ["token", token] : ["public", this.config.userName.trim().toLowerCase()],
      ]),
      "hex"
    );
  }
  private checkCacheIdentity() {
    if (this.cache && this.cache.key !== this.cacheKey()) {
      this.cache = null;
      this.entries = [];
      this.account = null;
      this.connectedUser = null;
      this.refreshError = null;
      this.retryAt = 0;
      this.db.delete(anilistState).where(eq(anilistState.id, "list-cache")).run();
    }
  }
  snapshot(): AniListState {
    this.checkCacheIdentity();
    const { clientSecret, ...config } = this.config;
    return {
      ...config,
      authenticated: Boolean(this.options.plugins.plugin("anilist").apiKey),
      authorizationError: this.authorization.error,
      authorizationPending: this.authorization.pending || this.oauthState !== null,
      connectedUser: this.connectedUser,
      entries: this.entries.map((entry) => ({
        ...entry,
        automationId: this.animeRule(entry.mediaId)?.id ?? null,
        completedEpisodes: this.completedEpisodes(entry),
      })),
      hasClientSecret: Boolean(clientSecret),
      lastSyncedAt: this.cache?.updatedAt ?? null,
      refreshError: this.refreshError,
      refreshing: this.listFlight?.key === this.cacheKey(),
      selections: this.entries.map((entry) => ({
        enabled: this.accepted(entry.mediaId),
        mediaId: entry.mediaId,
      })),
      subscriptions: [...this.subscriptions.values()],
      visibleStatuses: this.visibleStatuses,
    };
  }
  preferences(visibleStatuses: AniListStatus[]) {
    this.writePreferences(this.db, visibleStatuses);
    this.visibleStatuses = visibleStatuses;
    return this.snapshot();
  }
  writePreferences(tx: DatabaseConnection, visibleStatuses: AniListStatus[]) {
    this.writeState("preferences", JSON.stringify(visibleStatuses), tx);
    return { visibleStatuses };
  }
  refreshState() {
    const rows = this.db.select().from(anilistState).all();
    const preferences = rows.find(({ id }) => id === "preferences");
    this.visibleStatuses = preferences
      ? (JSON.parse(preferences.value) as AniListStatus[])
      : ["CURRENT", "PLANNING"];
    refreshRecords(
      this.selections,
      rows.filter(({ id }) => id.startsWith("selection:"))
    );
    refreshRecords(
      this.animeRules,
      rows.filter(({ id }) => id.startsWith("anime-rule:"))
    );
    refreshRecords(
      this.subscriptions,
      rows.filter(
        ({ id }) =>
          !(
            ["preferences", "config", "profile", "list-cache"].includes(id) ||
            ["selection:", "anime-rule:", "watched:"].some((prefix) => id.startsWith(prefix))
          )
      )
    );
  }
  configure(input: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    userName: string;
  }) {
    const redirectUri = input.redirectUri ?? this.config.redirectUri;
    const redirect = new URL(redirectUri);
    if (
      !["tofu://oauth/anilist", "tofu-dev://oauth/anilist"].includes(redirect.href) &&
      (redirect.protocol !== "http:" ||
        !["localhost", "127.0.0.1"].includes(redirect.hostname) ||
        !redirect.port ||
        redirect.search ||
        redirect.hash)
    ) {
      throw new (HTTPError.id("BAD_REQUEST", 400))(
        "The OAuth callback must be a local HTTP URL with an explicit port"
      );
    }
    this.stopCallback();
    this.config = {
      ...this.config,
      ...input,
      clientId: input.clientId || this.config.clientId,
      redirectUri,
    };
    this.writeState("config", JSON.stringify(this.config));
    return this.snapshot();
  }
  connect(): { url: string } {
    if (this.lifecycle.closed) {
      throw new (HTTPError.id("CONFLICT", 409))("AniList unavailable");
    }
    if (
      !this.config.clientId ||
      (this.config.clientId === "9037" && this.config.redirectUri === "tofu-dev://oauth/anilist")
    ) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "This development build needs its own AniList client. Set TOFU_ANILIST_CLIENT_ID and rebuild Tofu Dev."
      );
    }
    if (this.config.clientId === "9037" || !this.config.clientSecret) {
      this.stopCallback();
      return this.authorization.connect(this.config.clientId, this.config.redirectUri);
    }
    if (!(this.config.clientId && this.config.clientSecret)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Add your AniList OAuth client ID and secret");
    }
    this.stopCallback();
    const config = { ...this.config };
    const redirect = new URL(config.redirectUri);
    const state = crypto.randomUUID();
    this.oauthState = state;
    try {
      this.callbackServer = Bun.serve({
        fetch: async (request) => {
          const url = new URL(request.url);
          if (
            url.pathname !== redirect.pathname ||
            url.searchParams.get("state") !== this.oauthState ||
            this.oauthState !== state ||
            !url.searchParams.get("code")
          ) {
            return new Response(
              "Invalid or expired OAuth callback. Restart the connection from Tofu.",
              { headers: { "cache-control": "no-store" }, status: 400 }
            );
          }
          this.oauthState = null;
          const controller = new AbortController();
          this.requests.add(controller);
          const timeout = setTimeout(
            () => controller.abort(new DOMException("AniList request timed out", "TimeoutError")),
            15_000
          );
          try {
            const response = await fetch(this.options.tokenEndpoint, {
              body: JSON.stringify({
                client_id: config.clientId,
                client_secret: config.clientSecret,
                code: url.searchParams.get("code"),
                grant_type: "authorization_code",
                redirect_uri: config.redirectUri,
              }),
              headers: { accept: "application/json", "content-type": "application/json" },
              method: "POST",
              signal: controller.signal,
            });
            const token = (await response.json()) as { access_token?: string };
            if (
              !(response.ok && token.access_token) ||
              this.lifecycle.closed ||
              this.config.clientId !== config.clientId
            ) {
              throw new Error("Exchange rejected");
            }
            this.options.plugins.configure("anilist", {
              apiKey: token.access_token,
              enabled: true,
            });
            return new Response(
              "AniList connected successfully. You can close this tab and return to Tofu.",
              {
                headers: {
                  "cache-control": "no-store",
                  "content-type": "text/plain; charset=utf-8",
                  "referrer-policy": "no-referrer",
                },
              }
            );
          } catch {
            return new Response("Unable to connect AniList. Restart the connection from Tofu.", {
              status: 502,
            });
          } finally {
            clearTimeout(timeout);
            this.requests.delete(controller);
          }
        },
        hostname: "127.0.0.1",
        port: Number(redirect.port),
      });
    } catch (cause) {
      this.oauthState = null;
      throw new (HTTPError.id("CONFLICT", 409))(
        "The OAuth callback port is busy. Choose the same available port in Tofu and your AniList client.",
        { cause }
      );
    }
    this.callbackTimeout = setTimeout(() => this.stopCallback(), 600_000);
    this.callbackTimeout.unref();
    const url = new URL("https://anilist.co/api/v2/oauth/authorize");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return { url: url.href };
  }
  private stopCallback() {
    this.authorization.close();
    this.callbackServer?.stop(true);
    this.callbackServer = null;
    if (this.callbackTimeout) {
      clearTimeout(this.callbackTimeout);
      this.callbackTimeout = null;
    }
    this.oauthState = null;
  }
  async media(mediaId: number): Promise<AniListMedia> {
    if (this.lifecycle.closed) {
      throw new (HTTPError.id("CONFLICT", 409))("AniList service closed");
    }
    const entry = this.entries.find((item) => item.mediaId === mediaId);
    if (entry) {
      return entry;
    }
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("AniList request timed out", "TimeoutError")),
      15_000
    );
    try {
      const { Media } = await this.sdk.Anime(
        { mediaId },
        { accessToken: "", signal: controller.signal }
      );
      if (!Media || Media.id !== mediaId) {
        throw new (HTTPError.id("NOT_FOUND", 404))("Anime not found on AniList");
      }
      return catalogMedia(Media);
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }
  async catalog(filters: AniListCatalogFilters): Promise<AniListCatalog> {
    const variables = catalogVariables(filters);
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("AniList request timed out", "TimeoutError")),
      15_000
    );
    try {
      const { Page: page } = await this.sdk.Catalog(variables, {
        accessToken: "",
        signal: controller.signal,
      });
      if (
        !page?.pageInfo ||
        page.pageInfo.currentPage === null ||
        page.pageInfo.hasNextPage === null ||
        !page.media
      ) {
        throw new (HTTPError.id("BAD_GATEWAY", 502))("Invalid AniList catalog");
      }
      return {
        hasNextPage: page.pageInfo.hasNextPage,
        media: page.media.flatMap((media) => (media ? [catalogMedia(media)] : [])),
        page: page.pageInfo.currentPage,
      };
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }
  private catalogOptionsCache: AniListCatalogOptions | null = null;
  private async authenticatedRequest<Result>(
    run: (accessToken: string, signal: AbortSignal, assertCurrent: () => void) => Promise<Result>
  ): Promise<Result> {
    this.checkCacheIdentity();
    if (!this.options.plugins.plugin("anilist").enabled || this.lifecycle.closed) {
      throw new (HTTPError.id("CONFLICT", 409))("AniList plugin disabled");
    }
    const accessToken = this.options.plugins.plugin("anilist").apiKey;
    if (!accessToken) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "Connect your AniList account to edit your list or favourites"
      );
    }
    const key = this.cacheKey();
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("AniList request timed out", "TimeoutError")),
      15_000
    );
    const assertCurrent = () => {
      if (
        this.lifecycle.closed ||
        !this.options.plugins.plugin("anilist").enabled ||
        key !== this.cacheKey()
      ) {
        throw new (HTTPError.id("CONFLICT", 409))(
          "AniList account changed; reopen the anime editor"
        );
      }
    };
    try {
      const result = await run(accessToken, controller.signal, assertCurrent);
      assertCurrent();
      return result;
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }
  private async readEditor(mediaId: number, accessToken: string, signal: AbortSignal) {
    const result = await this.sdk.Editor({ mediaId }, { accessToken, signal });
    if (!result.Viewer?.id || (this.account && result.Viewer.id !== this.account.id)) {
      throw new (HTTPError.id("CONFLICT", 409))("Reload your AniList list after changing accounts");
    }
    return { editor: editorState(result, mediaId), result };
  }
  editor(mediaId: number): Promise<AniListEditor> {
    return this.authenticatedRequest(
      async (accessToken, signal) => (await this.readEditor(mediaId, accessToken, signal)).editor
    );
  }
  saveEntry(mediaId: number, body: AniListListUpdate): Promise<AniListState> {
    return this.mutateMedia(mediaId, () =>
      this.authenticatedRequest(async (accessToken, signal, assertCurrent) => {
        const { editor, result } = await this.readEditor(mediaId, accessToken, signal);
        assertCurrent();
        validateEntryUpdate(body, editor, result.Media?.episodes ?? null);
        const { SaveMediaListEntry: saved } = await this.sdk.SaveEntry(
          {
            ...body,
            mediaId,
            ...(editor.entry || body.status ? {} : { status: "PLANNING" as const }),
          },
          { accessToken, signal }
        );
        assertCurrent();
        if (
          !(
            saved?.media &&
            saved.mediaId === mediaId &&
            isAniListStatus(saved.status) &&
            saved.progress !== null
          )
        ) {
          throw new (HTTPError.id("BAD_GATEWAY", 502))("AniList did not save the list entry");
        }
        const found = new Map<number, AniListEntry>();
        collectEntries({ hasNextChunk: false, lists: [{ entries: [saved] }] }, found);
        const entry = found.get(mediaId);
        if (!entry) {
          throw new (HTTPError.id("BAD_GATEWAY", 502))("Invalid AniList list entry");
        }
        this.entries = [...this.entries.filter((item) => item.mediaId !== mediaId), entry];
        if (body.progress !== undefined) {
          const key = `watched:${result.Viewer?.id}:${mediaId}`;
          const episodes = Array.from({ length: entry.progress }, (_, index) => index + 1);
          this.watched.set(key, episodes);
          this.writeState(key, JSON.stringify(episodes));
        }
        this.persistEditedList();
        const rule = this.animeRule(mediaId);
        if (rule) {
          await this.options.releaseAutomation.save(rule.id, {
            ...rule,
            afterEpisode: entry.progress,
          });
        }
        return this.snapshot();
      })
    );
  }
  private persistEditedList() {
    this.listRevision += 1;
    if (this.cache) {
      this.cache = { ...this.cache, entries: this.entries };
      this.writeState("list-cache", JSON.stringify(this.cache));
    }
    for (const subscription of this.subscriptions.values()) {
      subscription.nextSyncAt = this.options.now();
      this.persist(subscription);
    }
  }
  favourite(mediaId: number, enabled: boolean): Promise<{ isFavourite: boolean }> {
    return this.mutateMedia(mediaId, () =>
      this.authenticatedRequest(async (accessToken, signal, assertCurrent) => {
        const { editor } = await this.readEditor(mediaId, accessToken, signal);
        assertCurrent();
        if (editor.isFavourite === null) {
          throw new (HTTPError.id("BAD_GATEWAY", 502))("AniList favourite state unavailable");
        }
        if (editor.isFavourite === enabled) {
          return { isFavourite: enabled };
        }
        if (editor.isFavouriteBlocked) {
          throw new (HTTPError.id("CONFLICT", 409))(
            "AniList does not allow favouriting this anime"
          );
        }
        await this.sdk.ToggleAnimeFavourite({ mediaId }, { accessToken, signal });
        assertCurrent();
        const updated = await this.readEditor(mediaId, accessToken, signal);
        if (updated.editor.isFavourite !== enabled) {
          throw new (HTTPError.id("BAD_GATEWAY", 502))("AniList did not update the favourite");
        }
        return { isFavourite: enabled };
      })
    );
  }
  deleteEntry(mediaId: number): Promise<AniListState> {
    return this.mutateMedia(mediaId, () =>
      this.authenticatedRequest(async (accessToken, signal, assertCurrent) => {
        const { editor } = await this.readEditor(mediaId, accessToken, signal);
        assertCurrent();
        if (editor.entry) {
          const { DeleteMediaListEntry } = await this.sdk.DeleteEntry(
            { id: editor.entry.id },
            { accessToken, signal }
          );
          assertCurrent();
          if (DeleteMediaListEntry?.deleted !== true) {
            throw new (HTTPError.id("BAD_GATEWAY", 502))("AniList did not delete the list entry");
          }
        }
        const rule = this.animeRule(mediaId);
        if (rule) {
          this.options.automation.enableRule(rule.id, false);
        }
        this.entries = this.entries.filter((item) => item.mediaId !== mediaId);
        const watchedKey = `watched:${this.account?.id}:${mediaId}`;
        this.watched.delete(watchedKey);
        this.db.delete(anilistState).where(eq(anilistState.id, watchedKey)).run();
        this.persistEditedList();
        return this.snapshot();
      })
    );
  }
  async catalogOptions(): Promise<AniListCatalogOptions> {
    if (this.catalogOptionsCache) {
      return this.catalogOptionsCache;
    }
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("AniList request timed out", "TimeoutError")),
      15_000
    );
    try {
      const result = await this.sdk.CatalogOptions(
        {},
        { accessToken: "", signal: controller.signal }
      );
      this.catalogOptionsCache = {
        genres: (result.GenreCollection ?? [])
          .filter((genre): genre is string => genre !== null)
          .toSorted((a, b) => a.localeCompare(b, "en-US")),
        streaming: (result.ExternalLinkSourceCollection ?? [])
          .flatMap((link) =>
            link?.type === "STREAMING" && !link.isDisabled ? [{ id: link.id, name: link.site }] : []
          )
          .toSorted((a, b) => a.name.localeCompare(b.name, "en-US")),
        tags: (result.MediaTagCollection ?? [])
          .flatMap((tag) =>
            tag && tag.isAdult === false && tag.category !== null
              ? [{ category: tag.category, isAdult: tag.isAdult, name: tag.name }]
              : []
          )
          .toSorted((a, b) => a.name.localeCompare(b.name, "en-US")),
      };
      return this.catalogOptionsCache;
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }
  private async authorize(token: string, current: () => boolean) {
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("AniList request timed out", "TimeoutError")),
      15_000
    );
    try {
      const { Viewer: identity } = await this.sdk.Viewer(
        {},
        { accessToken: token, signal: controller.signal }
      );
      if (!(identity?.id && identity.name && current()) || this.lifecycle.closed) {
        throw new (HTTPError.id("BAD_REQUEST", 400))("AniList authorization expired");
      }
      this.options.plugins.configure("anilist", { apiKey: token, enabled: true });
      this.entries = [];
      this.account = identity;
      this.writeState("profile", JSON.stringify(identity));
      this.connectedUser = identity.name;
      await this.list();
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }
  async receiveAuthorizationUrl(input: string) {
    await this.authorization.receiveUrl(input);
    return this.snapshot();
  }

  cancelAuthorization() {
    this.stopCallback();
    return this.snapshot();
  }
  needsRefresh() {
    this.checkCacheIdentity();
    return (
      this.options.plugins.plugin("anilist").enabled &&
      !this.lifecycle.closed &&
      Boolean(this.options.plugins.plugin("anilist").apiKey || this.config.userName) &&
      this.options.now() >= this.retryAt &&
      (!this.cache || this.options.now() - this.cache.updatedAt >= 5 * 60_000)
    );
  }
  refresh(): Promise<AniListState> {
    return this.needsRefresh() ? this.list() : Promise.resolve(this.snapshot());
  }
  list(): Promise<AniListState> {
    this.checkCacheIdentity();
    const key = this.cacheKey();
    if (this.listFlight?.key === key) {
      return this.listFlight.promise;
    }
    this.refreshError = null;
    const promise = this.loadList(key, this.options.plugins.plugin("anilist").apiKey)
      .catch((error: unknown) => {
        if (key === this.cacheKey() && !this.lifecycle.closed) {
          this.refreshError = error instanceof Error ? error.message : "Unable to refresh AniList";
          this.retryAt = this.options.now() + 30_000;
        }
        throw error;
      })
      .finally(() => {
        if (this.listFlight?.promise === promise) {
          this.listFlight = null;
        }
      })
      .then(() => this.snapshot());
    this.listFlight = { key, promise };
    return promise;
  }
  private async loadList(key: string, token: string): Promise<void> {
    const revision = this.listRevision;
    if (!this.options.plugins.plugin("anilist").enabled || this.lifecycle.closed) {
      throw new (HTTPError.id("CONFLICT", 409))("AniList plugin disabled");
    }
    if (!(this.options.plugins.plugin("anilist").apiKey || this.config.userName)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))(
        "Connect AniList or enter your public account name"
      );
    }
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("AniList request timed out", "TimeoutError")),
      15_000
    );
    try {
      const identity = token
        ? (await this.sdk.Viewer({}, { accessToken: token, signal: controller.signal })).Viewer
        : (
            await this.sdk.User(
              { name: this.config.userName },
              { accessToken: token, signal: controller.signal }
            )
          ).User;
      if (!identity?.id) {
        throw new (HTTPError.id("NOT_FOUND", 404))("AniList account not found");
      }
      const found = new Map<number, AniListEntry>();
      let more = true;
      for (let chunk = 1; more && chunk <= 30; chunk += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: AniList chunks are sequential and must stop when hasNextChunk is false.
        const response = await this.sdk.Library(
          { chunk, userId: identity.id },
          { accessToken: token, signal: controller.signal }
        );
        const collection = response.MediaListCollection;
        if (
          !(collection && Array.isArray(collection.lists)) ||
          typeof collection.hasNextChunk !== "boolean"
        ) {
          throw new (HTTPError.id("BAD_GATEWAY", 502))("Invalid AniList list");
        }
        more = collection.hasNextChunk;
        collectEntries(collection, found);
      }
      if (more) {
        throw new (HTTPError.id("BAD_REQUEST", 400))("AniList list too large for a full sync");
      }
      if (!this.options.plugins.plugin("anilist").enabled || this.lifecycle.closed) {
        throw new (HTTPError.id("CONFLICT", 409))("AniList plugin disabled");
      }
      if (key !== this.cacheKey()) {
        throw new (HTTPError.id("CONFLICT", 409))("The AniList account changed during refresh");
      }
      if (revision !== this.listRevision) {
        return;
      }
      this.entries = [...found.values()];
      this.account = identity;
      this.writeState("profile", JSON.stringify(identity));
      this.connectedUser = identity.name;
      this.cache = { account: identity, entries: this.entries, key, updatedAt: this.options.now() };
      this.writeState("list-cache", JSON.stringify(this.cache));
      this.retryAt = 0;
      this.refreshError = null;
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }
  private accepted(mediaId: number) {
    return (
      this.account !== null &&
      this.selections.get(`selection:${this.account.id}:${mediaId}`) === true
    );
  }
  entry(mediaId: number) {
    if (!this.options.plugins.plugin("anilist").enabled || this.lifecycle.closed) {
      throw new (HTTPError.id("CONFLICT", 409))("AniList plugin disabled");
    }
    const entry = this.entries.find((item) => item.mediaId === mediaId);
    if (!(entry && this.account)) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Load this anime from your AniList list first");
    }
    return entry;
  }
  private completedEpisodes(entry: AniListEntry) {
    const local = this.watched.get(`watched:${this.account?.id}:${entry.mediaId}`) ?? [];
    return [
      ...new Set([...Array.from({ length: entry.progress }, (_, index) => index + 1), ...local]),
    ].sort((a, b) => a - b);
  }
  private animeRule(mediaId: number) {
    const id =
      this.animeRules.get(`anime-rule:${this.account?.id}:${mediaId}`) ??
      [...this.subscriptions.values()]
        .filter((subscription) => subscription.userId === this.account?.id)
        .flatMap((subscription) => subscription.bindings)
        .find((binding) => binding.mediaId === mediaId)?.ruleId;
    return id ? this.options.automation.ruleSnapshot(id) : undefined;
  }
  prepareAutomation(mediaId: number, draft: AutomationDraft) {
    const entry = this.entry(mediaId);
    const accountId = this.account?.id;
    if (accountId === undefined) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Load this anime from your AniList list first");
    }
    return {
      accountId,
      draft: { ...draft, afterEpisode: entry.progress, aliases: entry.aliases, title: entry.title },
      id: this.animeRule(mediaId)?.id ?? null,
      key: `anime-rule:${accountId}:${mediaId}`,
    };
  }
  writeAutomationLink(
    tx: DatabaseConnection,
    input: ReturnType<AniListService["prepareAutomation"]>,
    ruleId: string
  ) {
    if (this.lifecycle.closed || this.account?.id !== input.accountId) {
      throw new (HTTPError.id("CONFLICT", 409))("AniList account changed; reload your list");
    }
    this.writeState(input.key, JSON.stringify(ruleId), tx);
  }
  async saveAutomation(mediaId: number, draft: AutomationDraft) {
    const input = this.prepareAutomation(mediaId, draft);
    const prepared = await this.options.releaseAutomation.prepareRule(input.id, input.draft, {
      key: input.key,
      ownerId: "tofu.anilist",
    });
    const rule = this.db.transaction((tx) => {
      const saved = this.options.automation.writeRule(tx, prepared);
      this.writeAutomationLink(tx, input, saved.id);
      return saved;
    });
    this.options.automation.refreshState();
    this.refreshState();
    return rule;
  }
  completeEpisode(mediaId: number, episode: number, completed: boolean): Promise<AniListState> {
    return this.mutateMedia(mediaId, () => this.updateEpisode(mediaId, episode, completed));
  }
  private async mutateMedia<Result>(mediaId: number, run: () => Promise<Result>): Promise<Result> {
    const pending = this.episodeRuns.get(mediaId);
    if (pending) {
      await pending.catch(() => undefined);
      return this.mutateMedia(mediaId, run);
    }
    const task = run();
    this.episodeRuns.set(mediaId, task);
    try {
      return await task;
    } finally {
      this.episodeRuns.delete(mediaId);
    }
  }
  private async updateEpisode(mediaId: number, episode: number, completed: boolean) {
    const entry = this.entry(mediaId);
    const accessToken = this.options.plugins.plugin("anilist").apiKey;
    if (!accessToken) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "Connect your AniList account to sync episode progress"
      );
    }
    if (entry.episodes !== null && episode > entry.episodes) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Episode exceeds the anime episode count");
    }
    const accountId = this.account?.id;
    const watched = new Set(this.completedEpisodes(entry));
    if (completed) {
      watched.add(episode);
    } else {
      watched.delete(episode);
    }
    let progress = 0;
    while (watched.has(progress + 1)) {
      progress += 1;
    }
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(
      () => controller.abort(new DOMException("AniList request timed out", "TimeoutError")),
      15_000
    );
    try {
      const { Viewer } = await this.sdk.Viewer({}, { accessToken, signal: controller.signal });
      if (
        Viewer?.id !== accountId ||
        this.options.plugins.plugin("anilist").apiKey !== accessToken
      ) {
        throw new (HTTPError.id("CONFLICT", 409))(
          "Reload your AniList list after changing accounts"
        );
      }
      if (progress !== entry.progress) {
        const { SaveMediaListEntry } = await this.sdk.SaveProgress(
          { mediaId, progress },
          { accessToken, signal: controller.signal }
        );
        if (SaveMediaListEntry?.progress !== progress) {
          throw new (HTTPError.id("BAD_GATEWAY", 502))("AniList did not save the episode progress");
        }
      }
      if (
        this.lifecycle.closed ||
        !this.options.plugins.plugin("anilist").enabled ||
        this.account?.id !== accountId
      ) {
        throw new (HTTPError.id("CONFLICT", 409))(
          "AniList account changed during episode sync; reload the list"
        );
      }
      const key = `watched:${accountId}:${mediaId}`;
      const episodes = [...watched].sort((a, b) => a - b);
      this.watched.set(key, episodes);
      this.writeState(key, JSON.stringify(episodes));
      this.entries = this.entries.map((item) =>
        item.mediaId === mediaId ? { ...item, progress } : item
      );
      this.listRevision += 1;
      if (this.cache) {
        this.cache = { ...this.cache, entries: this.entries };
        this.writeState("list-cache", JSON.stringify(this.cache));
      }
      const rule = this.animeRule(mediaId);
      if (rule) {
        await this.options.releaseAutomation.save(rule.id, { ...rule, afterEpisode: progress });
      }
      for (const subscription of this.subscriptions.values()) {
        subscription.nextSyncAt = this.options.now();
        this.persist(subscription);
      }
      return this.snapshot();
    } finally {
      clearTimeout(timeout);
      this.requests.delete(controller);
    }
  }
  previewThreads(basePath: string, statuses: AniListStatus[]): AniListThreadProposal[] {
    if (!isAbsolute(basePath)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Enter an absolute root folder path");
    }
    const { destinations } = this.options.engine.snapshot(null, false);
    const trackedStatuses = new Set(statuses);
    return this.entries
      .filter((entry) => trackedStatuses.has(entry.status) && this.accepted(entry.mediaId))
      .map((entry) => {
        const folder = animeFolder(entry);
        const collision = this.entries.some(
          (other) => other.mediaId !== entry.mediaId && animeFolder(other) === folder
        );
        const downloadPath = join(basePath, collision ? `${folder}-${entry.mediaId}` : folder);
        const existing = destinations.find(
          (destination) => destination.downloadPath === downloadPath
        );
        return {
          destinationId: existing?.id ?? null,
          downloadPath,
          mediaId: entry.mediaId,
          name: existing?.name ?? entry.title,
        };
      });
  }
  select(mediaIds: number[], enabled: boolean) {
    const selectedIds = new Set(mediaIds);
    if (
      !this.account ||
      mediaIds.some((id) => !this.entries.some((entry) => entry.mediaId === id))
    ) {
      throw new (HTTPError.id("BAD_REQUEST", 400))(
        "Load the AniList list before choosing its titles"
      );
    }
    for (const mediaId of mediaIds) {
      const key = `selection:${this.account.id}:${mediaId}`;
      this.selections.set(key, enabled);
      this.writeState(key, JSON.stringify(enabled));
    }
    for (const subscription of this.subscriptions.values()) {
      for (const binding of subscription.bindings) {
        if (!enabled && selectedIds.has(binding.mediaId)) {
          this.options.automation.enableRule(binding.ruleId, false);
          binding.active = false;
        }
      }
      subscription.nextSyncAt = this.options.now();
      this.persist(subscription);
    }
    return this.snapshot();
  }
  writeSelection(tx: DatabaseConnection, mediaIds: number[], enabled: boolean) {
    const selectedIds = new Set(mediaIds);
    if (
      !this.account ||
      mediaIds.some((id) => !this.entries.some((entry) => entry.mediaId === id))
    ) {
      throw new (HTTPError.id("BAD_REQUEST", 400))(
        "Load the AniList list before choosing its titles"
      );
    }
    for (const mediaId of mediaIds) {
      this.writeState(`selection:${this.account.id}:${mediaId}`, JSON.stringify(enabled), tx);
    }
    for (const current of this.subscriptions.values()) {
      const subscription = structuredClone(current);
      for (const binding of subscription.bindings) {
        if (!enabled && selectedIds.has(binding.mediaId)) {
          this.options.automation.enableRule(binding.ruleId, false, tx);
          binding.active = false;
        }
      }
      subscription.nextSyncAt = this.options.now();
      this.writeState(subscription.id, JSON.stringify(subscription), tx);
    }
    return { enabled, mediaIds };
  }
  private persist(subscription: AniListSubscription, connection?: DatabaseConnection) {
    this.subscriptions.set(subscription.id, subscription);
    this.writeState(subscription.id, JSON.stringify(subscription), connection);
  }
  reassignDestination(id: string, connection?: DatabaseConnection) {
    for (const subscription of this.subscriptions.values()) {
      if (subscription.template.destinationId === id) {
        subscription.template.destinationId = "default";
      }
      if (subscription.organization?.mode === "per-anime") {
        for (const override of subscription.organization.overrides) {
          if (override.destinationId === id) {
            override.destinationId = "default";
          }
        }
      }
      this.persist(subscription, connection);
    }
  }
  subscribe(
    input: Pick<
      AniListSubscription,
      "template" | "statuses" | "enabled" | "intervalMinutes" | "organization"
    >
  ) {
    const subscription = this.writeSubscription(this.db, input);
    this.subscriptions.set(subscription.id, subscription);
    return subscription;
  }
  writeSubscription(
    tx: DatabaseConnection,
    input: Pick<
      AniListSubscription,
      "template" | "statuses" | "enabled" | "intervalMinutes" | "organization"
    >
  ) {
    const { destinations } = this.options.engine.snapshot(null, false);
    if (!destinations.some((destination) => destination.id === input.template.destinationId)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Unknown destination");
    }
    if (input.organization?.mode === "per-anime") {
      this.previewThreads(input.organization.basePath, input.statuses);
      const ids = new Set<number>();
      for (const override of input.organization.overrides) {
        if (
          ids.has(override.mediaId) ||
          !override.name.trim() ||
          !isAbsolute(override.downloadPath) ||
          (override.destinationId !== null &&
            !destinations.some((destination) => destination.id === override.destinationId))
        ) {
          throw new (HTTPError.id("BAD_REQUEST", 400))(
            "Check the proposed names, folders, and threads"
          );
        }
        ids.add(override.mediaId);
      }
    }
    const subscription: AniListSubscription = {
      ...input,
      bindings: [],
      error: null,
      id: crypto.randomUUID(),
      lastSyncAt: null,
      nextSyncAt: this.options.now(),
      userId: this.account?.id,
    };
    this.writeState(subscription.id, JSON.stringify(subscription), tx);
    return subscription;
  }
  private subscription(id: string) {
    const subscription = this.subscriptions.get(id);
    if (!subscription) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Unknown AniList tracking");
    }
    return subscription;
  }
  async sync(id: string): Promise<AniListState> {
    const pending = this.runs.get(id);
    if (pending) {
      return pending;
    }
    const subscription = this.subscription(id);
    const task = this.reconcile(subscription).catch(() => {
      if (!this.lifecycle.closed && this.subscriptions.get(id) === subscription) {
        subscription.error = "AniList sync interrupted; retry or check the connection";
        subscription.nextSyncAt = this.options.now() + 60_000;
        this.persist(subscription);
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
  private current(subscription: AniListSubscription) {
    return (
      !this.lifecycle.closed &&
      this.options.plugins.plugin("anilist").enabled &&
      subscription.enabled &&
      this.subscriptions.get(subscription.id) === subscription
    );
  }
  private async destinationId(subscription: AniListSubscription, entry: AniListEntry) {
    const { organization } = subscription;
    if (organization?.mode !== "per-anime") {
      return subscription.template.destinationId;
    }
    const proposal =
      organization.overrides.find((item) => item.mediaId === entry.mediaId) ??
      this.previewThreads(organization.basePath, subscription.statuses).find(
        (item) => item.mediaId === entry.mediaId
      );
    if (!proposal) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Thread proposal not found");
    }
    if (proposal.destinationId !== null) {
      if (
        !this.options.engine
          .snapshot(null, false)
          .destinations.some((destination) => destination.id === proposal.destinationId)
      ) {
        throw new (HTTPError.id("BAD_REQUEST", 400))("The selected thread no longer exists");
      }
      return proposal.destinationId;
    }
    const downloadPath = resolve(proposal.downloadPath);
    const existing = this.options.engine
      .snapshot(null, false)
      .destinations.find((destination) => destination.downloadPath === downloadPath);
    if (existing) {
      return existing.id;
    }
    const pending = this.destinationRuns.get(downloadPath);
    if (pending) {
      return (await pending).id;
    }
    const task = this.options.engine.saveDestination(null, { downloadPath, name: proposal.name });
    this.destinationRuns.set(downloadPath, task);
    try {
      return (await task).id;
    } finally {
      this.destinationRuns.delete(downloadPath);
    }
  }
  private async follow(subscription: AniListSubscription, entry: AniListEntry) {
    const binding = subscription.bindings.find((item) => item.mediaId === entry.mediaId);
    const previous =
      this.animeRule(entry.mediaId) ??
      (binding ? this.options.automation.ruleSnapshot(binding.ruleId) : undefined);
    const template = previous ?? subscription.template;
    const overridden = this.animeRules.has(`anime-rule:${this.account?.id}:${entry.mediaId}`);
    const destinationId =
      previous?.destinationId ?? (await this.destinationId(subscription, entry));
    if (!(this.current(subscription) && this.accepted(entry.mediaId))) {
      return;
    }
    const rule = await this.options.releaseAutomation.save(
      previous?.id ?? null,
      {
        ...template,
        afterEpisode: entry.progress,
        aliases: entry.aliases,
        destinationId,
        enabled:
          previous && (overridden || binding?.active)
            ? previous.enabled
            : subscription.template.enabled,
        query: previous?.query ?? `Download "${entry.title}". ${subscription.template.query}`,
        title: entry.title,
      },
      { key: `anime-rule:${this.account?.id}:${entry.mediaId}`, ownerId: "tofu.anilist" }
    );
    if (binding) {
      binding.ruleId = rule.id;
      binding.active = true;
    } else {
      subscription.bindings.push({ active: true, mediaId: entry.mediaId, ruleId: rule.id });
    }
    if (!(this.current(subscription) && this.accepted(entry.mediaId))) {
      this.options.automation.enableRule(rule.id, false);
      return;
    }
    this.persist(subscription);
    await this.options.releaseAutomation.run(rule.id);
  }
  private async reconcile(subscription: AniListSubscription) {
    if (
      !(subscription.enabled && this.options.plugins.plugin("anilist").enabled) ||
      this.lifecycle.closed
    ) {
      return this.snapshot();
    }
    const { entries } = await this.list();
    if (!this.current(subscription)) {
      return this.snapshot();
    }
    if (subscription.userId !== undefined && subscription.userId !== this.account?.id) {
      this.pause(subscription);
      throw new (HTTPError.id("CONFLICT", 409))("This tracking belongs to another AniList account");
    }
    subscription.userId = this.account?.id;
    const trackedStatuses = new Set(subscription.statuses);
    const selected = entries.filter(
      (entry) => trackedStatuses.has(entry.status) && this.accepted(entry.mediaId)
    );
    for (const entry of selected) {
      if (
        !this.options.plugins.plugin("anilist").enabled ||
        this.lifecycle.closed ||
        this.subscriptions.get(subscription.id) !== subscription
      ) {
        break;
      }
      // biome-ignore lint/performance/noAwaitInLoops: preserve each title binding before running the next rule.
      await this.follow(subscription, entry);
    }
    if (this.lifecycle.closed || this.subscriptions.get(subscription.id) !== subscription) {
      return this.snapshot();
    }
    for (const binding of subscription.bindings) {
      if (!selected.some((entry) => entry.mediaId === binding.mediaId)) {
        this.options.automation.enableRule(binding.ruleId, false);
        binding.active = false;
      }
    }
    subscription.lastSyncAt = this.options.now();
    subscription.nextSyncAt = subscription.lastSyncAt + subscription.intervalMinutes * 60_000;
    subscription.error = null;
    this.persist(subscription);
    return this.snapshot();
  }
  toggle(id: string, enabled: boolean) {
    const subscription = { ...this.subscription(id), enabled, nextSyncAt: this.options.now() };
    this.persist(subscription);
    if (!enabled) {
      this.pause(subscription);
    }
    return this.snapshot();
  }
  writeToggle(tx: DatabaseConnection, id: string, enabled: boolean) {
    const subscription = {
      ...structuredClone(this.subscription(id)),
      enabled,
      nextSyncAt: this.options.now(),
    };
    if (!enabled) {
      for (const binding of subscription.bindings) {
        this.options.automation.enableRule(binding.ruleId, false, tx);
        binding.active = false;
      }
    }
    this.writeState(id, JSON.stringify(subscription), tx);
    return { enabled, id };
  }
  deleteSubscription(tx: DatabaseConnection, id: string) {
    for (const binding of this.subscription(id).bindings) {
      this.options.automation.enableRule(binding.ruleId, false, tx);
    }
    tx.delete(anilistState).where(eq(anilistState.id, id)).run();
    return { id, ok: true };
  }
  private pause(subscription: AniListSubscription) {
    for (const binding of subscription.bindings) {
      this.options.automation.enableRule(binding.ruleId, false);
      binding.active = false;
    }
    this.persist(subscription);
  }
  remove(id: string) {
    this.pause(this.subscription(id));
    this.subscriptions.delete(id);
    this.db.delete(anilistState).where(eq(anilistState.id, id)).run();
    return this.snapshot();
  }
  suspend() {
    this.stopCallback();
    for (const controller of this.requests) {
      controller.abort();
    }
    for (const subscription of this.subscriptions.values()) {
      this.pause(subscription);
    }
  }
  async start() {
    if (this.lifecycle.started || this.lifecycle.closed) {
      return;
    }
    this.lifecycle.started = true;
    try {
      await this.tick(true);
    } finally {
      if (!this.lifecycle.closed) {
        this.timer = setInterval(() => {
          void this.tick(false).catch((error: unknown) => {
            recordLog({ component: "anilist", error, level: "error", operation: "poll" });
          });
        }, 15_000);
        this.timer.unref();
      }
    }
  }
  async tick(force: boolean) {
    if (this.lifecycle.closed) {
      return;
    }
    await Promise.all(
      [...this.subscriptions.values()]
        .filter(
          (subscription) =>
            subscription.enabled &&
            (force ||
              subscription.nextSyncAt === null ||
              subscription.nextSyncAt <= this.options.now())
        )
        .map((subscription) => this.sync(subscription.id))
    );
  }
  async close() {
    this.lifecycle.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.stopCallback();
    for (const controller of this.requests) {
      controller.abort();
    }
    await Promise.allSettled([
      ...this.runs.values(),
      ...this.episodeRuns.values(),
      ...(this.listFlight ? [this.listFlight.promise] : []),
    ]);
  }
}
