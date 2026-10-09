import type { Database } from "bun:sqlite";
import { isAbsolute, join, resolve } from "node:path";
import type {
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
} from "../../types";
import { UserError } from "../engine";
import { AniListAuthorization } from "./anilist-oauth";

interface AniListOptions {
  client?: AniListClient;
  destinationExists: (id: string) => boolean;
  destinations: () => Destination[];
  enabled: () => boolean;
  enableRule: (id: string, enabled: boolean) => void;
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
interface ListResponse {
  MediaListCollection: {
    hasNextChunk: boolean;
    lists: {
      entries: {
        status: string;
        progress: number;
        media: {
          id: number;
          title: {
            romaji: string | null;
            english: string | null;
            native: string | null;
            userPreferred: string | null;
          };
          synonyms: string[];
          siteUrl: string | null;
          coverImage?: { extraLarge: string | null; large: string | null };
          bannerImage?: string | null;
          episodes?: number | null;
          format?: string | null;
          seasonYear?: number | null;
        };
      }[];
    }[];
  };
}
const listQuery =
  "query($userId: Int!, $chunk: Int!) { MediaListCollection(userId: $userId, type: ANIME, chunk: $chunk, perChunk: 500) { hasNextChunk lists { entries { status progress media { id title { romaji english native userPreferred } synonyms siteUrl coverImage { extraLarge large } bannerImage episodes format seasonYear } } } } }";

export function isAniListStatus(value: string): value is AniListStatus {
  return ["CURRENT", "PLANNING", "COMPLETED", "PAUSED", "DROPPED", "REPEATING"].includes(value);
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
  collection: ListResponse["MediaListCollection"],
  found: Map<number, AniListEntry>
) {
  for (const group of collection.lists) {
    for (const entry of group.entries) {
      if (!isAniListStatus(entry.status)) {
        continue;
      }
      const aliases = [
        ...new Set(
          [
            entry.media.title.romaji,
            entry.media.title.english,
            entry.media.title.native,
            entry.media.title.userPreferred,
            ...entry.media.synonyms,
          ].filter((name): name is string => typeof name === "string" && name.trim().length > 0)
        ),
      ].slice(0, 30);
      const [title] = aliases;
      if (!title) {
        continue;
      }
      found.set(entry.media.id, {
        aliases,
        automationId: null,
        bannerImage: entry.media.bannerImage ?? null,
        completedEpisodes: [],
        coverImage: entry.media.coverImage?.extraLarge ?? entry.media.coverImage?.large ?? null,
        episodes: entry.media.episodes ?? null,
        format: entry.media.format ?? null,
        mediaId: entry.media.id,
        progress: Math.max(0, entry.progress),
        seasonYear: entry.media.seasonYear ?? null,
        siteUrl: entry.media.siteUrl ?? null,
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
  private readonly db: Database;
  private readonly options: AniListOptions;
  constructor(db: Database, options: AniListOptions) {
    this.db = db;
    this.options = options;
    this.authorization = new AniListAuthorization((token, current) =>
      this.authorize(token, current)
    );
    db.exec("CREATE TABLE IF NOT EXISTS anilist (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const row of db
      .query<{ id: string; value: string }, []>("SELECT id, value FROM anilist")
      .all()) {
      if (row.id === "preferences") {
        this.visibleStatuses = JSON.parse(row.value) as AniListStatus[];
      } else if (row.id === "config") {
        this.config = { ...this.config, ...(JSON.parse(row.value) as AniListConfig) };
        this.config.clientId ||= "9037";
      } else if (row.id === "profile") {
        this.account = JSON.parse(row.value) as { id: number; name: string };
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
  }
  snapshot(): AniListState {
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
      selections: this.entries.map((entry) => ({
        enabled: this.accepted(entry.mediaId),
        mediaId: entry.mediaId,
      })),
      subscriptions: [...this.subscriptions.values()],
      visibleStatuses: this.visibleStatuses,
    };
  }
  preferences(visibleStatuses: AniListStatus[]) {
    this.visibleStatuses = visibleStatuses;
    this.db
      .query("INSERT OR REPLACE INTO anilist VALUES (?, ?)")
      .run("preferences", JSON.stringify(visibleStatuses));
    return this.snapshot();
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
    this.db
      .query("INSERT OR REPLACE INTO anilist VALUES (?, ?)")
      .run("config", JSON.stringify(this.config));
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
          const timeout = setTimeout(() => controller.abort(), 15_000);
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
  private async request<T>(
    query: string,
    variables: {
      userId?: number;
      chunk?: number;
      name?: string;
      mediaId?: number;
      progress?: number;
    },
    controller: AbortController,
    accessToken?: string
  ): Promise<T> {
    const token = accessToken ?? this.options.token();
    const response = await fetch(this.options.endpoint, {
      body: JSON.stringify({ query, variables }),
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      method: "POST",
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new UserError(`AniList unavailable (HTTP ${response.status})`, { status: 502 });
    }
    const result = (await response.json()) as { data?: T; errors?: unknown[] };
    if (!result.data || result.errors?.length) {
      throw new UserError("AniList: account or list inaccessible", { status: 502 });
    }
    return result.data;
  }
  private async authorize(token: string, current: () => boolean) {
    const controller = new AbortController();
    this.requests.add(controller);
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const { Viewer: identity } = await this.request<{ Viewer: { id: number; name: string } }>(
        "query { Viewer { id name } }",
        {},
        controller,
        token
      );
      if (!(identity?.id && identity.name && current()) || this.lifecycle.closed) {
        throw new UserError("AniList authorization expired", { status: 400 });
      }
      this.options.setToken(token);
      this.entries = [];
      this.account = identity;
      this.db
        .query("INSERT OR REPLACE INTO anilist VALUES (?, ?)")
        .run("profile", JSON.stringify(identity));
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
  async list(): Promise<AniListState> {
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
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const identity = this.options.token()
        ? (
            await this.request<{ Viewer: { id: number; name: string } }>(
              "query { Viewer { id name } }",
              {},
              controller
            )
          ).Viewer
        : (
            await this.request<{ User: { id: number; name: string } }>(
              "query($name: String!) { User(name: $name) { id name } }",
              { name: this.config.userName },
              controller
            )
          ).User;
      if (!identity?.id) {
        throw new UserError("AniList account not found", { status: 404 });
      }
      const found = new Map<number, AniListEntry>();
      let more = true;
      for (let chunk = 1; more && chunk <= 30; chunk += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: AniList chunks are sequential and must stop when hasNextChunk is false.
        const response = await this.request<ListResponse>(
          listQuery,
          { chunk, userId: identity.id },
          controller
        );
        const collection = response.MediaListCollection;
        if (!Array.isArray(collection?.lists)) {
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
      this.entries = [...found.values()];
      this.account = identity;
      this.db
        .query("INSERT OR REPLACE INTO anilist VALUES (?, ?)")
        .run("profile", JSON.stringify(identity));
      this.connectedUser = identity.name;
      return this.snapshot();
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
  async saveAutomation(mediaId: number, draft: AutomationDraft) {
    const entry = this.entry(mediaId);
    const accountId = this.account?.id;
    const rule = await this.options.save(this.animeRule(mediaId)?.id ?? null, {
      ...draft,
      afterEpisode: entry.progress,
      aliases: entry.aliases,
      title: entry.title,
    });
    if (this.lifecycle.closed || this.account?.id !== accountId) {
      throw new UserError("AniList account changed; reload your list", { status: 409 });
    }
    const key = `anime-rule:${accountId}:${mediaId}`;
    this.animeRules.set(key, rule.id);
    this.db.query("INSERT OR REPLACE INTO anilist VALUES (?, ?)").run(key, JSON.stringify(rule.id));
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
    const timeout = setTimeout(() => controller.abort(), 15_000);
    try {
      const { Viewer } = await this.request<{ Viewer: { id: number } }>(
        "query { Viewer { id } }",
        {},
        controller
      );
      if (Viewer.id !== accountId || this.options.token() !== accessToken) {
        throw new UserError("Reload your AniList list after changing accounts", { status: 409 });
      }
      if (progress !== entry.progress) {
        const { SaveMediaListEntry } = await this.request<{
          SaveMediaListEntry: { progress: number };
        }>(
          "mutation($mediaId: Int!, $progress: Int!) { SaveMediaListEntry(mediaId: $mediaId, progress: $progress) { progress } }",
          { mediaId, progress },
          controller
        );
        if (SaveMediaListEntry.progress !== progress) {
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
      this.db
        .query("INSERT OR REPLACE INTO anilist VALUES (?, ?)")
        .run(key, JSON.stringify(episodes));
      this.entries = this.entries.map((item) =>
        item.mediaId === mediaId ? { ...item, progress } : item
      );
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
      this.db
        .query("INSERT OR REPLACE INTO anilist VALUES (?, ?)")
        .run(key, JSON.stringify(enabled));
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
  private persist(subscription: AniListSubscription) {
    this.subscriptions.set(subscription.id, subscription);
    this.db
      .query("INSERT OR REPLACE INTO anilist VALUES (?, ?)")
      .run(subscription.id, JSON.stringify(subscription));
  }
  reassignDestination(id: string) {
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
      this.persist(subscription);
    }
  }
  subscribe(
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
    this.persist(subscription);
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
    this.db.query("DELETE FROM anilist WHERE id = ?").run(id);
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
    await Promise.allSettled([...this.runs.values(), ...this.episodeRuns.values()]);
  }
}
