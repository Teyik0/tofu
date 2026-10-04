import type { Database } from "bun:sqlite";
import { isAbsolute, join, resolve } from "node:path";
import type {
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

interface AniListOptions {
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
        };
      }[];
    }[];
  };
}
const listQuery =
  "query($userId: Int!, $chunk: Int!) { MediaListCollection(userId: $userId, type: ANIME, chunk: $chunk, perChunk: 500) { hasNextChunk lists { entries { status progress media { id title { romaji english native userPreferred } synonyms siteUrl } } } } }";

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
      if (entry.status !== "CURRENT" && entry.status !== "PLANNING") {
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
        mediaId: entry.media.id,
        progress: Math.max(0, entry.progress),
        siteUrl: entry.media.siteUrl ?? null,
        status: entry.status,
        title,
      });
    }
  }
}

export class AniListService {
  private config: AniListConfig = {
    clientId: "",
    clientSecret: "",
    redirectUri: "http://localhost:3000/",
    userName: "",
  };
  private entries: AniListEntry[] = [];
  private connectedUser: string | null = null;
  private account: { id: number; name: string } | null = null;
  private readonly selections = new Map<string, boolean>();
  private readonly subscriptions = new Map<string, AniListSubscription>();
  private readonly runs = new Map<string, Promise<AniListState>>();
  private readonly destinationRuns = new Map<string, Promise<Destination>>();
  private readonly requests = new Set<AbortController>();
  private readonly lifecycle: { closed: boolean } = { closed: false };
  private callbackServer: ReturnType<typeof Bun.serve> | null = null;
  private callbackTimeout: ReturnType<typeof setTimeout> | null = null;
  private oauthState: string | null = null;
  private readonly db: Database;
  private readonly options: AniListOptions;
  constructor(db: Database, options: AniListOptions) {
    this.db = db;
    this.options = options;
    db.exec("CREATE TABLE IF NOT EXISTS anilist (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    for (const row of db
      .query<{ id: string; value: string }, []>("SELECT id, value FROM anilist")
      .all()) {
      if (row.id === "config") {
        this.config = JSON.parse(row.value) as AniListConfig;
      } else if (row.id === "profile") {
        this.account = JSON.parse(row.value) as { id: number; name: string };
      } else if (row.id.startsWith("selection:")) {
        this.selections.set(row.id, JSON.parse(row.value) === true);
      } else {
        const subscription = JSON.parse(row.value) as AniListSubscription;
        this.subscriptions.set(subscription.id, subscription);
      }
    }
  }
  snapshot(): AniListState {
    const { clientSecret, ...config } = this.config;
    return {
      ...config,
      connectedUser: this.connectedUser,
      entries: this.entries,
      hasClientSecret: Boolean(clientSecret),
      selections: this.entries.map((entry) => ({
        enabled: this.accepted(entry.mediaId),
        mediaId: entry.mediaId,
      })),
      subscriptions: [...this.subscriptions.values()],
    };
  }
  configure(input: {
    clientId: string;
    clientSecret?: string;
    redirectUri: string;
    userName: string;
  }) {
    const redirect = new URL(input.redirectUri);
    if (
      redirect.protocol !== "http:" ||
      !["localhost", "127.0.0.1"].includes(redirect.hostname) ||
      !redirect.port ||
      redirect.search ||
      redirect.hash
    ) {
      throw new UserError("Le retour OAuth doit être une URL HTTP locale avec un port explicite", {
        status: 400,
      });
    }
    this.config = { ...input, clientSecret: input.clientSecret ?? this.config.clientSecret };
    this.db
      .query("INSERT OR REPLACE INTO anilist VALUES (?, ?)")
      .run("config", JSON.stringify(this.config));
    return this.snapshot();
  }
  connect(): { url: string } {
    if (!(this.config.clientId && this.config.clientSecret)) {
      throw new UserError("Ajoutez l’ID et le secret de votre client OAuth AniList", {
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
              "Retour OAuth invalide ou expiré. Relancez la connexion depuis Tofu.",
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
              throw new Error("Échange refusé");
            }
            this.options.setToken(token.access_token);
            return new Response(
              "Connexion AniList réussie. Vous pouvez fermer cet onglet et revenir dans Tofu.",
              {
                headers: {
                  "cache-control": "no-store",
                  "content-type": "text/plain; charset=utf-8",
                  "referrer-policy": "no-referrer",
                },
              }
            );
          } catch {
            return new Response(
              "Connexion AniList impossible. Relancez la connexion depuis Tofu.",
              { status: 502 }
            );
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
        "Le port de retour OAuth est occupé. Choisissez le même port libre dans Tofu et dans le client AniList.",
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
    variables: { userId?: number; chunk?: number; name?: string },
    controller: AbortController
  ): Promise<T> {
    const token = this.options.token();
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
      throw new UserError(`AniList indisponible (HTTP ${response.status})`, { status: 502 });
    }
    const result = (await response.json()) as { data?: T; errors?: unknown[] };
    if (!result.data || result.errors?.length) {
      throw new UserError("AniList : compte ou liste inaccessible", { status: 502 });
    }
    return result.data;
  }
  async list(): Promise<AniListState> {
    if (!this.options.enabled() || this.lifecycle.closed) {
      throw new UserError("Plugin AniList désactivé", { status: 409 });
    }
    if (!(this.options.token() || this.config.userName)) {
      throw new UserError("Connectez AniList ou indiquez votre nom de compte public", {
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
        throw new UserError("Compte AniList introuvable", { status: 404 });
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
          throw new UserError("Liste AniList invalide", { status: 502 });
        }
        more = collection.hasNextChunk;
        collectEntries(collection, found);
      }
      if (more) {
        throw new UserError("Liste AniList trop grande pour une synchronisation complète", {
          status: 400,
        });
      }
      if (!this.options.enabled() || this.lifecycle.closed) {
        throw new UserError("Plugin AniList désactivé", { status: 409 });
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
  previewThreads(basePath: string, statuses: AniListStatus[]): AniListThreadProposal[] {
    if (!isAbsolute(basePath)) {
      throw new UserError("Indiquez un chemin de dossier racine absolu", { status: 400 });
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
      throw new UserError("Chargez la liste AniList avant de choisir ses titres", { status: 400 });
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
  subscribe(
    input: Pick<
      AniListSubscription,
      "template" | "statuses" | "enabled" | "intervalMinutes" | "organization"
    >
  ) {
    if (!this.options.destinationExists(input.template.destinationId)) {
      throw new UserError("Destination inconnue", { status: 400 });
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
          throw new UserError("Vérifiez les noms, dossiers et threads proposés", { status: 400 });
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
      throw new UserError("Suivi AniList inconnu", { status: 404 });
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
        subscription.error =
          "Synchronisation AniList interrompue ; réessayez ou vérifiez la connexion";
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
      throw new UserError("Proposition de thread introuvable", { status: 400 });
    }
    if (proposal.destinationId !== null) {
      if (!this.options.destinationExists(proposal.destinationId)) {
        throw new UserError("Le thread choisi n’existe plus", { status: 400 });
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
    const previous = binding ? this.options.rule(binding.ruleId) : undefined;
    const template = previous ?? subscription.template;
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
      enabled: previous && binding?.active ? previous.enabled : subscription.template.enabled,
      query: `Télécharge "${entry.title}". ${subscription.template.query}`,
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
      throw new UserError("Ce suivi appartient à un autre compte AniList", { status: 409 });
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
    await Promise.allSettled(this.runs.values());
  }
}
