import { isAbsolute, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { anilistState } from "../../../db/schema";
import type {
  AniListCatalog,
  AniListCatalogFilters,
  AniListCatalogOptions,
  AniListClient,
  AniListEntry,
  AniListState,
  AniListStatus,
  AniListSubscription,
  AniListThreadProposal,
  AutomationDraft,
  AutomationRule,
  Destination,
  DestinationInput,
} from "../../../types";
import type { DatabaseConnection, TofuDatabase } from "../../lib/db";
import { UserError } from "../../lib/errors";
import { refreshRecords } from "../../lib/persisted-cache";
import { catalogMedia, catalogVariables } from "./catalog";
import type { LibraryQuery } from "./graphql/generated";
import { createAniListSdk } from "./graphql/transport";
import { AniListAuthorization } from "./oauth";

interface AniListOptions {
  client?: AniListClient;
  destinationExists: (id: string) => boolean;
  destinations: () => Destination[];
  enabled: () => boolean;
  enableRule: (id: string, enabled: boolean, connection?: DatabaseConnection) => void;
  endpoint: string;
  now: () => number;
  rule: (id: string) => AutomationRule | undefined;
  run: (id: string) => Promise<unknown>;
  save: (id: string | null, draft: AutomationDraft) => Promise<AutomationRule>;
  saveDestination: (input: DestinationInput) => Promise<Destination>;
  setToken: (token: string) => void;
  token: () => string;
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
  private readonly episodeRuns = new Map<number, Promise<AniListState>>();
  private readonly subscriptions = new Map<string, AniListSubscription>();
  private readonly runs = new Map<string, Promise<AniListState>>();
  private readonly destinationRuns = new Map<string, Promise<Destination>>();
  private readonly requests = new Set<AbortController>();
  private readonly lifecycle: { closed: boolean } = { closed: false };
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
    this.sdk = createAniListSdk(options.endpoint, options.token);
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
    const token = this.options.token();
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
      authenticated: Boolean(this.options.token()),
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
      throw new UserError("The OAuth callback must be a local HTTP URL with an explicit port", {
        status: 400,
      });
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
      throw new UserError("AniList unavailable", { status: 409 });
    }
    if (
      !this.config.clientId ||
      (this.config.clientId === "9037" && this.config.redirectUri === "tofu-dev://oauth/anilist")
    ) {
      throw new UserError(
        "This development build needs its own AniList client. Set TOFU_ANILIST_CLIENT_ID and rebuild Tofu Dev.",
        { status: 409 }
      );
    }
    if (this.config.clientId === "9037" || !this.config.clientSecret) {
      this.stopCallback();
      return this.authorization.connect(this.config.clientId, this.config.redirectUri);
    }
    if (!(this.config.clientId && this.config.clientSecret)) {
      throw new UserError("Add your AniList OAuth client ID and secret", {
        status: 400,
      });
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
            this.options.setToken(token.access_token);
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
      throw new UserError(
        "The OAuth callback port is busy. Choose the same available port in Tofu and your AniList client.",
        { cause, status: 409 }
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
        throw new UserError("Invalid AniList catalog", { status: 502 });
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
        throw new UserError("AniList authorization expired", { status: 400 });
      }
      this.options.setToken(token);
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
      this.options.enabled() &&
      !this.lifecycle.closed &&
      Boolean(this.options.token() || this.config.userName) &&
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
    const promise = this.loadList(key, this.options.token())
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
    if (!this.options.enabled() || this.lifecycle.closed) {
      throw new UserError("AniList plugin disabled", { status: 409 });
    }
    if (!(this.options.token() || this.config.userName)) {
      throw new UserError("Connect AniList or enter your public account name", {
        status: 400,
      });
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
        throw new UserError("AniList account not found", { status: 404 });
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
          throw new UserError("Invalid AniList list", { status: 502 });
        }
        more = collection.hasNextChunk;
        collectEntries(collection, found);
      }
      if (more) {
        throw new UserError("AniList list too large for a full sync", {
          status: 400,
        });
      }
      if (!this.options.enabled() || this.lifecycle.closed) {
        throw new UserError("AniList plugin disabled", { status: 409 });
      }
      if (key !== this.cacheKey()) {
        throw new UserError("The AniList account changed during refresh", { status: 409 });
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
    if (!this.options.enabled() || this.lifecycle.closed) {
      throw new UserError("AniList plugin disabled", { status: 409 });
    }
    const entry = this.entries.find((item) => item.mediaId === mediaId);
    if (!(entry && this.account)) {
      throw new UserError("Load this anime from your AniList list first", { status: 404 });
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
    return id ? this.options.rule(id) : undefined;
  }
  prepareAutomation(mediaId: number, draft: AutomationDraft) {
    const entry = this.entry(mediaId);
    const accountId = this.account?.id;
    if (accountId === undefined) {
      throw new UserError("Load this anime from your AniList list first", { status: 404 });
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
      throw new UserError("AniList account changed; reload your list", { status: 409 });
    }
    this.writeState(input.key, JSON.stringify(ruleId), tx);
  }
  async saveAutomation(mediaId: number, draft: AutomationDraft) {
    const input = this.prepareAutomation(mediaId, draft);
    const rule = await this.options.save(input.id, input.draft);
    this.writeAutomationLink(this.db, input, rule.id);
    this.animeRules.set(input.key, rule.id);
    return rule;
  }
  async completeEpisode(
    mediaId: number,
    episode: number,
    completed: boolean
  ): Promise<AniListState> {
    const pending = this.episodeRuns.get(mediaId);
    if (pending) {
      await pending.catch(() => undefined);
      return this.completeEpisode(mediaId, episode, completed);
    }
    const task = this.updateEpisode(mediaId, episode, completed);
    this.episodeRuns.set(mediaId, task);
    try {
      return await task;
    } finally {
      this.episodeRuns.delete(mediaId);
    }
  }
  private async updateEpisode(mediaId: number, episode: number, completed: boolean) {
    const entry = this.entry(mediaId);
    const accessToken = this.options.token();
    if (!accessToken) {
      throw new UserError("Connect your AniList account to sync episode progress", { status: 409 });
    }
    if (entry.episodes !== null && episode > entry.episodes) {
      throw new UserError("Episode exceeds the anime episode count", { status: 400 });
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
      if (Viewer?.id !== accountId || this.options.token() !== accessToken) {
        throw new UserError("Reload your AniList list after changing accounts", { status: 409 });
      }
      if (progress !== entry.progress) {
        const { SaveMediaListEntry } = await this.sdk.SaveProgress(
          { mediaId, progress },
          { accessToken, signal: controller.signal }
        );
        if (SaveMediaListEntry?.progress !== progress) {
          throw new UserError("AniList did not save the episode progress", { status: 502 });
        }
      }
      if (this.lifecycle.closed || !this.options.enabled() || this.account?.id !== accountId) {
        throw new UserError("AniList account changed during episode sync; reload the list", {
          status: 409,
        });
      }
      const key = `watched:${accountId}:${mediaId}`;
      const episodes = [...watched].sort((a, b) => a - b);
      this.watched.set(key, episodes);
      this.writeState(key, JSON.stringify(episodes));
      this.entries = this.entries.map((item) =>
        item.mediaId === mediaId ? { ...item, progress } : item
      );
      if (this.cache) {
        this.cache = { ...this.cache, entries: this.entries };
        this.writeState("list-cache", JSON.stringify(this.cache));
      }
      const rule = this.animeRule(mediaId);
      if (rule) {
        await this.options.save(rule.id, { ...rule, afterEpisode: progress });
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
      throw new UserError("Enter an absolute root folder path", { status: 400 });
    }
    const destinations = this.options.destinations();
    return this.entries
      .filter((entry) => statuses.includes(entry.status) && this.accepted(entry.mediaId))
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
    if (
      !this.account ||
      mediaIds.some((id) => !this.entries.some((entry) => entry.mediaId === id))
    ) {
      throw new UserError("Load the AniList list before choosing its titles", { status: 400 });
    }
    for (const mediaId of mediaIds) {
      const key = `selection:${this.account.id}:${mediaId}`;
      this.selections.set(key, enabled);
      this.writeState(key, JSON.stringify(enabled));
    }
    for (const subscription of this.subscriptions.values()) {
      for (const binding of subscription.bindings) {
        if (!enabled && mediaIds.includes(binding.mediaId)) {
          this.options.enableRule(binding.ruleId, false);
          binding.active = false;
        }
      }
      subscription.nextSyncAt = this.options.now();
      this.persist(subscription);
    }
    return this.snapshot();
  }
  writeSelection(tx: DatabaseConnection, mediaIds: number[], enabled: boolean) {
    if (
      !this.account ||
      mediaIds.some((id) => !this.entries.some((entry) => entry.mediaId === id))
    ) {
      throw new UserError("Load the AniList list before choosing its titles", { status: 400 });
    }
    for (const mediaId of mediaIds) {
      this.writeState(`selection:${this.account.id}:${mediaId}`, JSON.stringify(enabled), tx);
    }
    for (const current of this.subscriptions.values()) {
      const subscription = structuredClone(current);
      for (const binding of subscription.bindings) {
        if (!enabled && mediaIds.includes(binding.mediaId)) {
          this.options.enableRule(binding.ruleId, false, tx);
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
    if (!this.options.destinationExists(input.template.destinationId)) {
      throw new UserError("Unknown destination", { status: 400 });
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
            !this.options.destinationExists(override.destinationId))
        ) {
          throw new UserError("Check the proposed names, folders, and threads", { status: 400 });
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
      throw new UserError("Unknown AniList tracking", { status: 404 });
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
      this.options.enabled() &&
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
      throw new UserError("Thread proposal not found", { status: 400 });
    }
    if (proposal.destinationId !== null) {
      if (!this.options.destinationExists(proposal.destinationId)) {
        throw new UserError("The selected thread no longer exists", { status: 400 });
      }
      return proposal.destinationId;
    }
    const downloadPath = resolve(proposal.downloadPath);
    const existing = this.options
      .destinations()
      .find((destination) => destination.downloadPath === downloadPath);
    if (existing) {
      return existing.id;
    }
    const pending = this.destinationRuns.get(downloadPath);
    if (pending) {
      return (await pending).id;
    }
    const task = this.options.saveDestination({ downloadPath, name: proposal.name });
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
      this.animeRule(entry.mediaId) ?? (binding ? this.options.rule(binding.ruleId) : undefined);
    const template = previous ?? subscription.template;
    const overridden = this.animeRules.has(`anime-rule:${this.account?.id}:${entry.mediaId}`);
    const destinationId =
      previous?.destinationId ?? (await this.destinationId(subscription, entry));
    if (!(this.current(subscription) && this.accepted(entry.mediaId))) {
      return;
    }
    const rule = await this.options.save(previous?.id ?? null, {
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
    });
    if (binding) {
      binding.ruleId = rule.id;
      binding.active = true;
    } else {
      subscription.bindings.push({ active: true, mediaId: entry.mediaId, ruleId: rule.id });
    }
    if (!(this.current(subscription) && this.accepted(entry.mediaId))) {
      this.options.enableRule(rule.id, false);
      return;
    }
    this.persist(subscription);
    await this.options.run(rule.id);
  }
  private async reconcile(subscription: AniListSubscription) {
    if (!(subscription.enabled && this.options.enabled()) || this.lifecycle.closed) {
      return this.snapshot();
    }
    const { entries } = await this.list();
    if (!this.current(subscription)) {
      return this.snapshot();
    }
    if (subscription.userId !== undefined && subscription.userId !== this.account?.id) {
      this.pause(subscription);
      throw new UserError("This tracking belongs to another AniList account", { status: 409 });
    }
    subscription.userId = this.account?.id;
    const selected = entries.filter(
      (entry) => subscription.statuses.includes(entry.status) && this.accepted(entry.mediaId)
    );
    for (const entry of selected) {
      if (
        !this.options.enabled() ||
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
        this.options.enableRule(binding.ruleId, false);
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
        this.options.enableRule(binding.ruleId, false, tx);
        binding.active = false;
      }
    }
    this.writeState(id, JSON.stringify(subscription), tx);
    return { enabled, id };
  }
  deleteSubscription(tx: DatabaseConnection, id: string) {
    for (const binding of this.subscription(id).bindings) {
      this.options.enableRule(binding.ruleId, false, tx);
    }
    tx.delete(anilistState).where(eq(anilistState.id, id)).run();
    return { id, ok: true };
  }
  private pause(subscription: AniListSubscription) {
    for (const binding of subscription.bindings) {
      this.options.enableRule(binding.ruleId, false);
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
  async tick(force: boolean) {
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
