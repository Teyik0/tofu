import { isAbsolute, join, resolve } from "node:path";
import { invalidateSync, type SyncRuntimeOptions } from "@teyik0/furin/sync";
import { eq } from "drizzle-orm";
import { Cause, Context, Effect, Fiber, Layer, Result, Schedule, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { ElysiaStatus, problem } from "elysia";
import { createLogger } from "evlog";
import { anilistState } from "../../../db/schema";
import { Database, type DatabaseConnection } from "../../lib/db";
import { instance } from "../../lib/instance";
import { refreshRecords } from "../../lib/persisted-cache";
import type { ReleaseAutomationService } from "../automation/integration";
import { ReleaseAutomation } from "../automation/integration";
import type { AutomationDraft } from "../automation/model";
import { compareReleases, interpretLocally } from "../automation/rules";
import type { AutomationService } from "../automation/service";
import { Automation } from "../automation/service";
import { mappedAnimeQueries, mappedAnimeRelease } from "../discovery/anime-mapping";
import type { DiscoveryResult, FeedRelease } from "../discovery/model";
import { classicDiscovery, Discovery, type DiscoveryService } from "../discovery/service";
import { collectSourceQueries } from "../discovery/sources";
import { type EpisodeSource, findEpisodeSources } from "../library-links/availability";
import type { SourcePluginId } from "../plugins/model";
import { publicRelease } from "../plugins/releases";
import type { PluginsService } from "../plugins/service";
import { Plugins } from "../plugins/service";
import { TorrentClient } from "../torrents/layer";
import type { EnginePort } from "../torrents/service";
import type { TorrentSummary } from "../torrents/types";
import type { AniListCatalogFilters } from "./catalog";
import { catalogMedia, catalogVariables } from "./catalog";
import type { AniListClient } from "./client";
import { readAniListClient } from "./client";
import { editorState, validateEntryUpdate } from "./editor";
import type { LibraryQuery, MediaListStatus, ScoreFormat } from "./graphql/generated";
import {
  type AniListCancelled,
  AniListUnavailable,
  anilistRequestError,
  createAniListSdk,
} from "./graphql/transport";
import type { AniListListUpdate, AniListThreadProposal, NotificationFilters } from "./model";
import {
  notificationAvailabilityQueries,
  notificationTypes,
  notificationView,
} from "./notifications";
import { AniListAuthorization } from "./oauth";
import {
  decodeAniListAccount,
  decodeAniListCache,
  decodeAniListConfig,
  decodeAniListRule,
  decodeAniListSelection,
  decodeAniListStatuses,
  decodeAniListSubscription,
  decodeAniListWatched,
} from "./persistence";
import {
  animeQueries,
  animeReleaseCandidate,
  localAnimeSearch,
  matchesAnimeRelease,
} from "./releases";
import type {
  AniListCatalogOptions,
  AniListEntry,
  AniListMedia,
  AniListState,
  AniListStatus,
  AniListSubscription,
} from "./types";

interface AniListOptions {
  automation: AutomationService;
  client?: AniListClient;
  discovery: DiscoveryService;
  endpoint: string;
  engine: EnginePort;
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
  account: ReturnType<typeof decodeAniListAccount>;
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

type ListFailure = Exclude<
  | ReturnType<typeof problem<409, { readonly detail: "AniList plugin disabled" }>>
  | ReturnType<
      typeof problem<400, { readonly detail: "Connect AniList or enter your public account name" }>
    >
  | ReturnType<typeof problem<404, { readonly detail: "AniList account not found" }>>
  | ReturnType<typeof problem<400, { readonly detail: "AniList list too large for a full sync" }>>
  | ReturnType<
      typeof problem<409, { readonly detail: "The AniList account changed during refresh" }>
    >
  | ReturnType<typeof problem<502, { readonly detail: string }>>
  | null,
  null
>;

const make = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const decodeToken = HttpClientResponse.schemaBodyJson(
    Schema.Struct({ access_token: Schema.NonEmptyString })
  );
  const db = yield* Database;
  const automation = yield* Automation;
  const discovery = yield* Discovery;
  const engine = yield* TorrentClient;
  const plugins = yield* Plugins;
  const releaseAutomation = yield* ReleaseAutomation;
  const client = yield* Effect.tryPromise(() =>
    readAniListClient(instance.profile, process.env.TOFU_ANILIST_CLIENT_ID, process.execPath)
  );
  const options: AniListOptions = {
    automation,
    client,
    discovery,
    endpoint: "https://graphql.anilist.co",
    engine,
    now: Date.now,
    plugins,
    releaseAutomation,
    tokenEndpoint: "https://anilist.co/api/v2/oauth/token",
  };
  const serviceDb = db;
  const serviceOptions = options;
  const scope = yield* Effect.scope;

  let serviceConfig: AniListConfig = {
    clientId: "9037",
    clientSecret: "",
    redirectUri: "tofu://oauth/anilist",
    userName: "",
  };
  let serviceVisibleStatuses: AniListStatus[] = ["CURRENT", "PLANNING"];
  let serviceEntries: AniListEntry[] = [];
  let serviceConnectedUser: string | null = null;
  let serviceAccount: ReturnType<typeof decodeAniListAccount> | null = null;
  let serviceCache: AniListCache | null = null;
  let serviceListFlight: {
    key: string;
    operation: Effect.Effect<AniListState | ListFailure>;
  } | null = null;
  let serviceRefreshError: string | null = null;
  let serviceRetryAt = 0;
  const serviceSelections = new Map<string, boolean>();
  const serviceWatched = new Map<string, number[]>();
  const serviceAnimeRules = new Map<string, string>();
  const serviceEpisodeRuns = new Map<number, Promise<void>>();
  let serviceListRevision = 0;
  const serviceSubscriptions = new Map<string, AniListSubscription>();
  const serviceRuns = new Map<string, ReturnType<typeof serviceReconcile>>();
  const serviceDestinationRuns = new Map<
    string,
    Promise<Awaited<ReturnType<typeof serviceOptions.engine.call<"saveDestination">>>>
  >();
  const serviceRequests = new Set<AbortController>();
  const serviceLifecycle: { closed: boolean; started: boolean } = {
    closed: false,
    started: false,
  };
  let serviceTimer: Fiber.Fiber<void> | null = null;
  let notificationTimer: Fiber.Fiber<void> | null = null;
  let notificationStarted = false;
  let notificationSync: SyncRuntimeOptions | null = null;
  let notificationKey: string | null = null;
  let notificationSignature: string | null = null;
  let notificationIds = new Set<number>();
  let notificationHasUpdates = false;
  let notificationRevision = 0;
  let notificationReadRevision = 0;
  let notificationCheckedAt = 0;
  let notificationNextCheckAt = 0;
  let notificationBackoff = 0;
  let notificationDirty = false;
  let notificationFlight: {
    key: string;
    operation: ReturnType<typeof servicePollNotifications>;
  } | null = null;
  let serviceCallbackServer: ReturnType<typeof Bun.serve> | null = null;
  let serviceCallbackTimeout: ReturnType<typeof setTimeout> | null = null;
  let serviceOauthState: string | null = null;
  let serviceAuthorization: AniListAuthorization;
  const serviceSdk = createAniListSdk(
    serviceOptions.endpoint,
    () => serviceOptions.plugins.plugin("anilist").apiKey
  );
  let serviceCatalogOptionsCache: AniListCatalogOptions | null = null;
  const serviceReleases = Effect.fn("AniList.releases")(function* (
    mediaId: number,
    onProgress?: (releases: FeedRelease[]) => void
  ) {
    const original = yield* serviceMedia(mediaId);
    if (original instanceof ElysiaStatus) {
      return original;
    }
    const plan = localAnimeSearch(original);
    const { entry } = plan;
    const mapping = yield* serviceOptions.discovery.animeMapping(mediaId);
    if (!mapping) {
      return problem(502, { detail: "Episode mapping unavailable" });
    }
    const titles = mappedAnimeQueries(mapping, plan.titles);
    const sources = (["nyaa", "tsundere", "c411"] as const).filter(
      (id) => serviceOptions.plugins.plugin(id).enabled
    );
    const { preferences } = serviceOptions.automation.snapshot();
    const project = (result: DiscoveryResult) => {
      const matches = (release: FeedRelease) => matchesAnimeRelease(entry, preferences, release);
      const stored = serviceOptions.discovery
        .cachedReleases()
        .map((release) => mappedAnimeRelease(entry, mapping, release))
        .filter((release): release is FeedRelease => release !== null)
        .filter(matches);
      const candidates = [
        ...new Map(
          [...stored, ...result.releases]
            .map((release) => mappedAnimeRelease(entry, mapping, release))
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
      const ranked = candidates.filter(matches);
      const matcher = { ...interpretLocally(entry.title, "default", preferences), season: null };
      const releases = ranked
        .filter(
          (release) =>
            !serviceLifecycle.closed && serviceOptions.plugins.plugin(release.sourceId).enabled
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
        torrents: serviceOptions.engine
          .snapshot(null, false)
          .torrents.filter((torrent) => hashes.has(torrent.id)),
      };
    };
    onProgress?.(project({ errors: [], releases: [] }).releases);
    const collected = yield* collectSourceQueries({
      accept: () => true,
      active: () => true,
      concurrency: 3,
      enough: () => Effect.succeed(false),
      progress: onProgress ? (partial) => onProgress(project(partial).releases) : undefined,
      queries: (source) => {
        if (source === "nyaa") {
          return animeQueries(entry, preferences, titles);
        }
        return source === "tsundere" ? titles.slice(0, 1) : titles;
      },
      search: (sourceQuery, source) => serviceOptions.discovery.search(sourceQuery, [source], true),
      sources,
    });
    return project(collected);
  });

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  function serviceRestore() {
    for (const row of serviceDb.select().from(anilistState).all()) {
      if (row.id === "preferences") {
        serviceVisibleStatuses = decodeAniListStatuses(row.value);
      } else if (row.id === "config") {
        serviceConfig = { ...serviceConfig, ...decodeAniListConfig(row.value) };
        serviceConfig.clientId ||= "9037";
      } else if (row.id === "profile") {
        serviceAccount = decodeAniListAccount(row.value);
      } else if (row.id === "list-cache") {
        const cached = decodeAniListCache(row.value);
        serviceCache = Result.isSuccess(cached) ? cached.success : null;
      } else if (row.id.startsWith("anime-rule:")) {
        serviceAnimeRules.set(row.id, decodeAniListRule(row.value));
      } else if (row.id.startsWith("watched:")) {
        serviceWatched.set(row.id, decodeAniListWatched(row.value));
      } else if (row.id.startsWith("selection:")) {
        serviceSelections.set(row.id, decodeAniListSelection(row.value));
      } else {
        const subscription = decodeAniListSubscription(row.value);
        serviceSubscriptions.set(subscription.id, subscription);
      }
    }
  }
  function serviceWriteState(id: string, value: string, connection?: DatabaseConnection) {
    const currentDb = connection ?? serviceDb;
    currentDb
      .insert(anilistState)
      .values({ id, value })
      .onConflictDoUpdate({ set: { value }, target: anilistState.id })
      .run();
  }
  function serviceCacheKey() {
    const token = serviceOptions.plugins.plugin("anilist").apiKey;
    return Bun.SHA256.hash(
      JSON.stringify([
        serviceOptions.endpoint,
        token ? ["token", token] : ["public", serviceConfig.userName.trim().toLowerCase()],
      ]),
      "hex"
    );
  }
  function serviceCheckCacheIdentity() {
    if (serviceCache && serviceCache.key !== serviceCacheKey()) {
      serviceCache = null;
      serviceEntries = [];
      serviceAccount = null;
      serviceConnectedUser = null;
      serviceRefreshError = null;
      serviceRetryAt = 0;
      serviceDb.delete(anilistState).where(eq(anilistState.id, "list-cache")).run();
    }
  }
  function serviceSnapshot(): AniListState {
    serviceCheckCacheIdentity();
    const { clientSecret, ...config } = serviceConfig;
    return {
      ...config,
      accountId: serviceAccount?.id ?? null,
      authenticated: Boolean(serviceOptions.plugins.plugin("anilist").apiKey),
      authorizationError: serviceAuthorization.error,
      authorizationPending: serviceAuthorization.pending || serviceOauthState !== null,
      avatarImage: serviceAccount?.avatar?.large ?? null,
      connectedUser: serviceConnectedUser,
      entries: serviceEntries.map((entry) => ({
        ...entry,
        automationId: serviceAnimeRule(entry.mediaId)?.id ?? null,
        completedEpisodes: serviceCompletedEpisodes(entry),
      })),
      hasClientSecret: Boolean(clientSecret),
      lastSyncedAt: serviceCache?.updatedAt ?? null,
      refreshError: serviceRefreshError,
      refreshing: serviceListFlight?.key === serviceCacheKey(),
      selections: serviceEntries.map((entry) => ({
        enabled: serviceAccepted(entry.mediaId),
        mediaId: entry.mediaId,
      })),
      subscriptions: [...serviceSubscriptions.values()],
      visibleStatuses: serviceVisibleStatuses,
    };
  }
  function serviceWritePreferences(tx: DatabaseConnection, visibleStatuses: AniListStatus[]) {
    serviceWriteState("preferences", JSON.stringify(visibleStatuses), tx);
    return { visibleStatuses };
  }
  function serviceRefreshState() {
    const rows = serviceDb.select().from(anilistState).all();
    const preferences = rows.find(({ id }) => id === "preferences");
    serviceVisibleStatuses = preferences
      ? decodeAniListStatuses(preferences.value)
      : ["CURRENT", "PLANNING"];
    refreshRecords(
      serviceSelections,
      rows.filter(({ id }) => id.startsWith("selection:")),
      decodeAniListSelection
    );
    refreshRecords(
      serviceAnimeRules,
      rows.filter(({ id }) => id.startsWith("anime-rule:")),
      decodeAniListRule
    );
    refreshRecords(
      serviceSubscriptions,
      rows.filter(
        ({ id }) =>
          !(
            ["preferences", "config", "profile", "list-cache"].includes(id) ||
            ["selection:", "anime-rule:", "watched:"].some((prefix) => id.startsWith(prefix))
          )
      ),
      decodeAniListSubscription
    );
  }
  function serviceConfigure(input: {
    clientId?: string;
    clientSecret?: string;
    redirectUri?: string;
    userName: string;
  }) {
    const redirectUri = input.redirectUri ?? serviceConfig.redirectUri;
    const redirect = new URL(redirectUri);
    if (
      !["tofu://oauth/anilist", "tofu-dev://oauth/anilist"].includes(redirect.href) &&
      (redirect.protocol !== "http:" ||
        !["localhost", "127.0.0.1"].includes(redirect.hostname) ||
        !redirect.port ||
        redirect.search ||
        redirect.hash)
    ) {
      return problem(400, {
        detail: "The OAuth callback must be a local HTTP URL with an explicit port",
      });
    }
    serviceStopCallback();
    serviceConfig = {
      ...serviceConfig,
      ...input,
      clientId: input.clientId || serviceConfig.clientId,
      redirectUri,
    };
    serviceWriteState("config", JSON.stringify(serviceConfig));
    return serviceSnapshot();
  }
  const serviceConnect = Effect.fn("AniList.connect")(function* (deviceId?: string) {
    if (serviceLifecycle.closed) {
      return problem(409, { detail: "AniList unavailable" });
    }
    if (
      !serviceConfig.clientId ||
      (serviceConfig.clientId === "9037" &&
        serviceConfig.redirectUri === "tofu-dev://oauth/anilist")
    ) {
      return problem(409, {
        detail:
          "This development build needs its own AniList client. Set TOFU_ANILIST_CLIENT_ID and rebuild Tofu Dev.",
      });
    }
    if (serviceConfig.clientId === "9037" || !serviceConfig.clientSecret) {
      serviceStopCallback();
      return serviceAuthorization.connect(
        serviceConfig.clientId,
        serviceConfig.redirectUri,
        deviceId
      );
    }
    if (!(serviceConfig.clientId && serviceConfig.clientSecret)) {
      return problem(400, { detail: "Add your AniList OAuth client ID and secret" });
    }
    serviceStopCallback();
    const config = { ...serviceConfig };
    const redirect = new URL(config.redirectUri);
    const state = crypto.randomUUID();
    serviceOauthState = state;

    // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
    const server = yield* Effect.result(
      Effect.try({
        catch: (cause) => cause,
        try: () =>
          Bun.serve({
            fetch: async (request) => {
              const url = new URL(request.url);
              if (
                url.pathname !== redirect.pathname ||
                url.searchParams.get("state") !== serviceOauthState ||
                serviceOauthState !== state ||
                !url.searchParams.get("code")
              ) {
                return new Response(
                  "Invalid or expired OAuth callback. Restart the connection from Tofu.",
                  { headers: { "cache-control": "no-store" }, status: 400 }
                );
              }
              serviceOauthState = null;
              const controller = new AbortController();
              serviceRequests.add(controller);
              using cleanup = new DisposableStack();
              cleanup.defer(() => {
                controller.abort();
                serviceRequests.delete(controller);
              });
              const exchanged = await Effect.runPromise(
                Effect.result(
                  http
                    .execute(
                      HttpClientRequest.post(serviceOptions.tokenEndpoint, {
                        headers: { accept: "application/json" },
                      }).pipe(
                        HttpClientRequest.bodyJsonUnsafe({
                          client_id: config.clientId,
                          client_secret: config.clientSecret,
                          code: url.searchParams.get("code"),
                          grant_type: "authorization_code",
                          redirect_uri: config.redirectUri,
                        })
                      )
                    )
                    .pipe(
                      Effect.flatMap(
                        Effect.fnUntraced(function* (response) {
                          if (response.status < 200 || response.status >= 300) {
                            return yield* new AniListUnavailable({
                              message: `AniList unavailable (HTTP ${response.status})`,
                            });
                          }
                          return yield* decodeToken(response);
                        })
                      ),
                      Effect.timeout("15 seconds")
                    )
                ).pipe(Effect.scoped),
                { signal: controller.signal }
              );
              if (Result.isFailure(exchanged)) {
                return new Response(
                  "Unable to connect AniList. Restart the connection from Tofu.",
                  { status: 502 }
                );
              }
              const token = exchanged.success;
              if (serviceLifecycle.closed || serviceConfig.clientId !== config.clientId) {
                return new Response(
                  "Unable to connect AniList. Restart the connection from Tofu.",
                  { status: 502 }
                );
              }
              const configured = serviceOptions.plugins.configure("anilist", {
                apiKey: token.access_token,
                enabled: true,
              });
              if (configured instanceof ElysiaStatus) {
                return new Response(
                  "Unable to connect AniList. Restart the connection from Tofu.",
                  { status: configured.status }
                );
              }
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
            },
            hostname: "127.0.0.1",
            port: Number(redirect.port),
          }),
      })
    );
    // biome-ignore-end lint/complexity/noExcessiveCognitiveComplexity: End of the existing operation.
    if (Result.isFailure(server)) {
      serviceOauthState = null;
      return problem(409, {
        detail:
          "The OAuth callback port is busy. Choose the same available port in Tofu and your AniList client.",
      });
    }
    serviceCallbackServer = server.success;
    serviceCallbackTimeout = setTimeout(() => serviceStopCallback(), 600_000);
    serviceCallbackTimeout.unref();
    const url = new URL("https://anilist.co/api/v2/oauth/authorize");
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return { url: url.href };
  });
  function serviceStopCallback() {
    serviceAuthorization.close();
    serviceCallbackServer?.stop(true);
    serviceCallbackServer = null;
    if (serviceCallbackTimeout) {
      clearTimeout(serviceCallbackTimeout);
      serviceCallbackTimeout = null;
    }
    serviceOauthState = null;
  }
  const serviceProvider = Effect.fn("AniList.provider")(function* <Result>(
    run: (signal: AbortSignal) => Effect.Effect<Result, AniListUnavailable | AniListCancelled>
  ) {
    const controller = new AbortController();
    serviceRequests.add(controller);
    const cleanup = yield* Effect.acquireRelease(
      Effect.sync(() => new DisposableStack()),
      (resource) => Effect.sync(() => resource.dispose())
    );
    cleanup.defer(() => {
      controller.abort();
      serviceRequests.delete(controller);
    });
    return yield* run(controller.signal).pipe(
      Effect.timeout("15 seconds"),
      Effect.catchTag("AniListUnavailable", (error) =>
        Effect.succeed(problem(502, { detail: error.message }))
      ),
      Effect.catchTag("TimeoutError", () =>
        Effect.succeed(problem(502, { detail: "AniList unavailable" }))
      ),
      Effect.catchTag("AniListCancelled", () => Effect.interrupt)
    );
  }, Effect.scoped);
  const serviceMedia = Effect.fn("AniList.media")(function* (mediaId: number) {
    if (serviceLifecycle.closed) {
      return problem(409, { detail: "AniList service closed" });
    }
    const entry = serviceEntries.find((item) => item.mediaId === mediaId);
    if (entry) {
      return entry as AniListMedia;
    }
    return yield* serviceProvider((signal) =>
      Effect.gen(function* () {
        const { Media } = yield* Effect.tryPromise({
          catch: (cause) => anilistRequestError(cause, signal),
          try: (requestSignal) =>
            serviceSdk.Anime(
              { mediaId },
              { accessToken: "", signal: AbortSignal.any([signal, requestSignal]) }
            ),
        });
        if (!Media || Media.id !== mediaId) {
          return problem(404, { detail: "Anime not found on AniList" });
        }
        return catalogMedia(Media);
      }).pipe(Effect.scoped)
    );
  });
  const serviceCatalog = Effect.fn("AniList.catalog")(function* (filters: AniListCatalogFilters) {
    const variables = catalogVariables(filters);
    if (variables instanceof ElysiaStatus) {
      return variables;
    }
    return yield* serviceProvider((signal) =>
      Effect.gen(function* () {
        const { Page: page } = yield* Effect.tryPromise({
          catch: (cause) => anilistRequestError(cause, signal),
          try: (requestSignal) =>
            serviceSdk.Catalog(variables, {
              accessToken: "",
              signal: AbortSignal.any([signal, requestSignal]),
            }),
        });
        if (
          !page?.pageInfo ||
          page.pageInfo.currentPage === null ||
          page.pageInfo.hasNextPage === null ||
          !page.media
        ) {
          return problem(502, { detail: "Invalid AniList catalog" });
        }
        return {
          hasNextPage: page.pageInfo.hasNextPage,
          media: page.media.flatMap((media) => (media ? [catalogMedia(media)] : [])),
          page: page.pageInfo.currentPage,
        };
      }).pipe(Effect.scoped)
    );
  });
  const serviceAuthenticatedRequest = Effect.fn("AniList.authenticatedRequest")(function* <Result>(
    run: (
      accessToken: string,
      signal: AbortSignal,
      stale: () => ReturnType<typeof serviceStaleAccount>
    ) => Effect.Effect<Result, AniListUnavailable | AniListCancelled>
  ) {
    serviceCheckCacheIdentity();
    if (!serviceOptions.plugins.plugin("anilist").enabled || serviceLifecycle.closed) {
      return problem(409, { detail: "AniList plugin disabled" });
    }
    const accessToken = serviceOptions.plugins.plugin("anilist").apiKey;
    if (!accessToken) {
      return problem(409, {
        detail: "Connect your AniList account to edit your list or favourites",
      });
    }
    const key = serviceCacheKey();
    const stale = () => serviceStaleAccount(key);
    return yield* serviceProvider((signal) =>
      Effect.gen(function* () {
        const result = yield* run(accessToken, signal, stale);
        return stale() ?? result;
      }).pipe(Effect.scoped)
    );
  });
  function serviceStaleAccount(key: string) {
    return serviceLifecycle.closed ||
      !serviceOptions.plugins.plugin("anilist").enabled ||
      key !== serviceCacheKey()
      ? problem(409, { detail: "AniList account changed; reopen the anime editor" })
      : null;
  }
  const serviceReadEditor = Effect.fn("AniList.readEditor")(function* (
    mediaId: number,
    accessToken: string,
    signal: AbortSignal
  ) {
    const result = yield* Effect.tryPromise({
      catch: (cause) => anilistRequestError(cause, signal),
      try: (requestSignal) =>
        serviceSdk.Editor(
          { mediaId },
          { accessToken, signal: AbortSignal.any([signal, requestSignal]) }
        ),
    });
    if (!result.Viewer?.id || (serviceAccount && result.Viewer.id !== serviceAccount.id)) {
      return problem(409, { detail: "Reload your AniList list after changing accounts" });
    }
    const editor = editorState(result, mediaId);
    if (editor instanceof ElysiaStatus) {
      return editor;
    }
    return { editor, result };
  });
  const serviceReadNotifications = Effect.fn("AniList.readNotifications")(function* (
    filters: NotificationFilters,
    reset: boolean,
    accessToken: string,
    signal: AbortSignal
  ) {
    const result = yield* Effect.tryPromise({
      catch: (cause) => anilistRequestError(cause, signal),
      try: (requestSignal) =>
        serviceSdk.Notifications(
          { page: filters.page, reset, types: notificationTypes[filters.category] },
          { accessToken, signal: AbortSignal.any([signal, requestSignal]) }
        ),
    });
    if (
      !(result.Viewer && result.Page?.notifications && result.Page.pageInfo) ||
      result.Page.pageInfo.hasNextPage === null ||
      result.Viewer.unreadNotificationCount === null
    ) {
      return problem(502, { detail: "Invalid AniList notifications" });
    }
    if (serviceAccount && result.Viewer.id !== serviceAccount.id) {
      return problem(409, { detail: "Reload your AniList list after changing accounts" });
    }
    const notifications = result.Page.notifications.flatMap((notification) =>
      notification && "id" in notification ? [notificationView(notification)] : []
    );

    return {
      hasNextPage: result.Page.pageInfo.hasNextPage,
      notifications,
      page: filters.page,
      unreadCount: reset ? 0 : result.Viewer.unreadNotificationCount,
    };
  });
  const serviceNotifications = Effect.fn("AniList.notifications")(function* (
    filters: NotificationFilters,
    reset = false
  ) {
    return yield* serviceAuthenticatedRequest((accessToken, signal) =>
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep authorization, read state and local availability in one authenticated operation.
      Effect.gen(function* () {
        const inbox = yield* serviceReadNotifications(filters, reset, accessToken, signal);
        if (inbox instanceof ElysiaStatus) {
          return inbox;
        }
        if (reset) {
          notificationReadRevision += 1;
          notificationHasUpdates = false;
          notificationRevision += 1;
          notificationDirty = true;
          yield* servicePublishNotifications();
        }
        const queries = notificationAvailabilityQueries(inbox.notifications, serviceEntries);
        const availability = yield* Effect.promise(() =>
          findEpisodeSources(serviceOptions.engine, queries)
        );
        if (availability instanceof ElysiaStatus) {
          return availability;
        }
        const sources = new Map<string, EpisodeSource[]>();
        for (const item of availability) {
          if (item instanceof ElysiaStatus) {
            return item;
          }
          sources.set(item.key, item.sources);
        }
        return {
          ...inbox,
          notifications: inbox.notifications.map((notification) => ({
            ...notification,
            sources: sources.get(String(notification.id)) ?? [],
          })),
        };
      })
    );
  });

  function serviceNotificationStatus() {
    return {
      hasUpdates:
        notificationKey === serviceCacheKey() &&
        serviceOptions.plugins.plugin("anilist").enabled &&
        Boolean(serviceOptions.plugins.plugin("anilist").apiKey) &&
        notificationHasUpdates,
      revision: notificationRevision,
    };
  }

  const servicePublishNotifications = Effect.fn("AniList.publishNotifications")(function* () {
    if (!(notificationSync && notificationDirty)) {
      return;
    }
    const revision = notificationRevision;
    const sync = notificationSync;
    yield* Effect.promise(async () => {
      await invalidateSync(sync, "/api/anilist/notifications/status");
      await invalidateSync(sync, { path: "/anilist/notifications", type: "page" });
    }).pipe(Effect.uninterruptible);
    if (notificationRevision === revision) {
      notificationDirty = false;
    }
  });

  const servicePollNotifications = Effect.fn("AniList.pollNotifications")(function* (key: string) {
    const readRevision = notificationReadRevision;
    yield* servicePublishNotifications();
    const result = yield* serviceAuthenticatedRequest((token, signal) =>
      serviceReadNotifications({ category: "all", page: 1 }, false, token, signal).pipe(
        Effect.tapError((error) =>
          Effect.sync(() => {
            if (
              key === serviceCacheKey() &&
              error._tag === "AniListUnavailable" &&
              error.retryAfter
            ) {
              notificationNextCheckAt = Math.max(
                notificationNextCheckAt,
                serviceOptions.now() + error.retryAfter
              );
            }
          })
        )
      )
    );
    if (
      key !== serviceCacheKey() ||
      readRevision !== notificationReadRevision ||
      serviceLifecycle.closed ||
      !serviceOptions.plugins.plugin("anilist").enabled
    ) {
      return result instanceof ElysiaStatus ? result : serviceNotificationStatus();
    }
    if (result instanceof ElysiaStatus) {
      notificationBackoff = Math.min(Math.max(120_000, notificationBackoff * 2), 15 * 60_000);
      notificationNextCheckAt = Math.max(
        notificationNextCheckAt,
        serviceOptions.now() + notificationBackoff
      );
      const log = createLogger({ component: "anilist", operation: "poll-notifications" });
      log.set({ upstreamError: result.response.detail });
      log.setLevel("warn");
      log.emit();
      return result;
    }
    notificationCheckedAt = serviceOptions.now();
    notificationNextCheckAt = notificationCheckedAt + 60_000;
    notificationBackoff = 0;
    const signature = JSON.stringify([result.notifications, result.unreadCount]);
    if (signature !== notificationSignature) {
      const incoming = result.notifications.some((item) => !notificationIds.has(item.id));
      notificationHasUpdates =
        result.unreadCount > 0 &&
        (notificationHasUpdates || (notificationSignature !== null && incoming));
      notificationIds = new Set(result.notifications.map((item) => item.id));
      notificationSignature = signature;
      notificationRevision += 1;
      notificationDirty = true;
    }
    yield* servicePublishNotifications();
    return serviceNotificationStatus();
  });

  const serviceCheckNotifications = Effect.fn("AniList.checkNotifications")(function* (
    force = false
  ) {
    const key = serviceCacheKey();
    if (notificationKey !== key || !serviceOptions.plugins.plugin("anilist").enabled) {
      const changed = notificationSignature !== null || notificationHasUpdates;
      notificationKey = key;
      notificationSignature = null;
      notificationReadRevision += 1;
      notificationIds.clear();
      notificationHasUpdates = false;
      notificationCheckedAt = 0;
      notificationNextCheckAt = 0;
      notificationBackoff = 0;
      if (changed) {
        notificationRevision += 1;
        notificationDirty = true;
      }
    }
    if (
      serviceLifecycle.closed ||
      !serviceOptions.plugins.plugin("anilist").enabled ||
      !serviceOptions.plugins.plugin("anilist").apiKey
    ) {
      yield* servicePublishNotifications();
      return serviceNotificationStatus();
    }
    if (notificationFlight?.key === key) {
      return yield* notificationFlight.operation;
    }
    const now = serviceOptions.now();
    if (
      now < notificationNextCheckAt &&
      (!force || notificationBackoff || now - notificationCheckedAt < 5000)
    ) {
      yield* servicePublishNotifications();
      return serviceNotificationStatus();
    }
    const operation = yield* Effect.cached(
      servicePollNotifications(key).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (notificationFlight?.operation === operation) {
              notificationFlight = null;
            }
          })
        )
      )
    );
    notificationFlight = { key, operation };
    return yield* operation;
  });

  const serviceStartNotifications = Effect.fn("AniList.startNotifications")(function* (
    sync: SyncRuntimeOptions
  ) {
    if (notificationStarted || serviceLifecycle.closed) {
      return;
    }
    notificationStarted = true;
    notificationSync = sync;
    const poll = serviceCheckNotifications().pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (!Cause.hasInterruptsOnly(cause)) {
            const log = createLogger({
              component: "anilist",
              error: Cause.squash(cause),
              operation: "poll-notifications",
            });
            log.setLevel("error");
            log.emit();
            notificationBackoff = Math.min(Math.max(120_000, notificationBackoff * 2), 15 * 60_000);
            notificationNextCheckAt = serviceOptions.now() + notificationBackoff;
          }
        })
      )
    );
    notificationTimer = yield* Effect.forkIn(
      Effect.forever(
        Effect.gen(function* () {
          yield* poll;
          const remaining = notificationNextCheckAt - serviceOptions.now();
          yield* Effect.sleep(remaining > 0 ? Math.max(1000, Math.min(60_000, remaining)) : 60_000);
        })
      ),
      scope
    );
  });
  const serviceEditor = Effect.fn("AniList.editor")(function* (mediaId: number) {
    return yield* serviceAuthenticatedRequest((accessToken, signal) =>
      Effect.gen(function* () {
        const read = yield* serviceReadEditor(mediaId, accessToken, signal);
        return read instanceof ElysiaStatus ? read : read.editor;
      }).pipe(Effect.scoped)
    );
  });

  // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceSaveEntry = Effect.fn("AniList.saveEntry")(function* (
    mediaId: number,
    body: AniListListUpdate
  ) {
    return yield* serviceMutateMedia(mediaId, () =>
      serviceAuthenticatedRequest((accessToken, signal, stale) =>
        Effect.gen(function* () {
          const read = yield* serviceReadEditor(mediaId, accessToken, signal);
          if (read instanceof ElysiaStatus) {
            return read;
          }
          const { editor, result } = read;
          const invalid =
            stale() ?? validateEntryUpdate(body, editor, result.Media?.episodes ?? null);
          if (invalid) {
            return invalid;
          }
          const { SaveMediaListEntry: saved } = yield* Effect.tryPromise({
            catch: (cause) => anilistRequestError(cause, signal),
            try: (requestSignal) =>
              serviceSdk.SaveEntry(
                {
                  ...body,
                  mediaId,
                  ...(editor.entry || body.status ? {} : { status: "PLANNING" as const }),
                },
                { accessToken, signal: AbortSignal.any([signal, requestSignal]) }
              ),
          });
          const changed = stale();
          if (changed) {
            return changed;
          }
          if (
            !(
              saved?.media &&
              saved.mediaId === mediaId &&
              isAniListStatus(saved.status) &&
              saved.progress !== null
            )
          ) {
            return problem(502, { detail: "AniList did not save the list entry" });
          }
          const found = new Map<number, AniListEntry>();
          collectEntries({ hasNextChunk: false, lists: [{ entries: [saved] }] }, found);
          const entry = found.get(mediaId);
          if (!entry) {
            return problem(502, { detail: "Invalid AniList list entry" });
          }
          serviceEntries = [...serviceEntries.filter((item) => item.mediaId !== mediaId), entry];
          if (body.progress !== undefined) {
            const key = `watched:${result.Viewer?.id}:${mediaId}`;
            const episodes = Array.from({ length: entry.progress }, (_, index) => index + 1);
            serviceWatched.set(key, episodes);
            serviceWriteState(key, JSON.stringify(episodes));
          }
          servicePersistEditedList();
          const rule = serviceAnimeRule(mediaId);
          if (rule) {
            const ruleSaved = yield* serviceOptions.releaseAutomation.save(rule.id, {
              ...rule,
              afterEpisode: entry.progress,
            });
            if (ruleSaved instanceof ElysiaStatus) {
              return ruleSaved;
            }
          }
          return serviceSnapshot();
        }).pipe(Effect.scoped)
      )
    );
  });
  // biome-ignore-end lint/complexity/noExcessiveCognitiveComplexity: End of the existing operation.
  function servicePersistEditedList() {
    serviceListRevision += 1;
    if (serviceCache) {
      serviceCache = { ...serviceCache, entries: serviceEntries };
      serviceWriteState("list-cache", JSON.stringify(serviceCache));
    }
    for (const subscription of serviceSubscriptions.values()) {
      subscription.nextSyncAt = serviceOptions.now();
      servicePersist(subscription);
    }
  }

  // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceFavourite = Effect.fn("AniList.favourite")(function* (
    mediaId: number,
    enabled: boolean
  ) {
    return yield* serviceMutateMedia(mediaId, () =>
      serviceAuthenticatedRequest((accessToken, signal, stale) =>
        Effect.gen(function* () {
          const read = yield* serviceReadEditor(mediaId, accessToken, signal);
          if (read instanceof ElysiaStatus) {
            return read;
          }
          const { editor } = read;
          const changed = stale();
          if (changed) {
            return changed;
          }
          if (editor.isFavourite === null) {
            return problem(502, { detail: "AniList favourite state unavailable" });
          }
          if (editor.isFavourite === enabled) {
            return { isFavourite: enabled };
          }
          if (editor.isFavouriteBlocked) {
            return problem(409, { detail: "AniList does not allow favouriting this anime" });
          }
          yield* Effect.tryPromise({
            catch: (cause) => anilistRequestError(cause, signal),
            try: (requestSignal) =>
              serviceSdk.ToggleAnimeFavourite(
                { mediaId },
                { accessToken, signal: AbortSignal.any([signal, requestSignal]) }
              ),
          });
          const toggled = stale();
          if (toggled) {
            return toggled;
          }
          const updated = yield* serviceReadEditor(mediaId, accessToken, signal);
          if (updated instanceof ElysiaStatus) {
            return updated;
          }
          if (updated.editor.isFavourite !== enabled) {
            return problem(502, { detail: "AniList did not update the favourite" });
          }
          return { isFavourite: enabled };
        }).pipe(Effect.scoped)
      )
    );
  });
  // biome-ignore-end lint/complexity/noExcessiveCognitiveComplexity: End of the existing operation.

  // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceDeleteEntry = Effect.fn("AniList.deleteEntry")(function* (mediaId: number) {
    return yield* serviceMutateMedia(mediaId, () =>
      serviceAuthenticatedRequest((accessToken, signal, stale) =>
        Effect.gen(function* () {
          const read = yield* serviceReadEditor(mediaId, accessToken, signal);
          if (read instanceof ElysiaStatus) {
            return read;
          }
          const { editor } = read;
          const changed = stale();
          if (changed) {
            return changed;
          }
          if (editor.entry) {
            const entryId = editor.entry.id;
            const { DeleteMediaListEntry } = yield* Effect.tryPromise({
              catch: (cause) => anilistRequestError(cause, signal),
              try: (requestSignal) =>
                serviceSdk.DeleteEntry(
                  { id: entryId },
                  { accessToken, signal: AbortSignal.any([signal, requestSignal]) }
                ),
            });
            const deleted = stale();
            if (deleted) {
              return deleted;
            }
            if (DeleteMediaListEntry?.deleted !== true) {
              return problem(502, { detail: "AniList did not delete the list entry" });
            }
          }
          const rule = serviceAnimeRule(mediaId);
          if (rule) {
            serviceOptions.automation.enableRule(rule.id, false);
          }
          serviceEntries = serviceEntries.filter((item) => item.mediaId !== mediaId);
          const watchedKey = `watched:${serviceAccount?.id}:${mediaId}`;
          serviceWatched.delete(watchedKey);
          serviceDb.delete(anilistState).where(eq(anilistState.id, watchedKey)).run();
          servicePersistEditedList();
          return serviceSnapshot();
        }).pipe(Effect.scoped)
      )
    );
  });
  // biome-ignore-end lint/complexity/noExcessiveCognitiveComplexity: End of the existing operation.
  const serviceCatalogOptions = Effect.fn("AniList.catalogOptions")(function* () {
    if (serviceCatalogOptionsCache) {
      return serviceCatalogOptionsCache;
    }
    return yield* serviceProvider((signal) =>
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise({
          catch: (cause) => anilistRequestError(cause, signal),
          try: (requestSignal) =>
            serviceSdk.CatalogOptions(
              {},
              { accessToken: "", signal: AbortSignal.any([signal, requestSignal]) }
            ),
        });
        serviceCatalogOptionsCache = {
          genres: (result.GenreCollection ?? [])
            .filter((genre): genre is string => genre !== null)
            .toSorted((a, b) => a.localeCompare(b, "en-US")),
          streaming: (result.ExternalLinkSourceCollection ?? [])
            .flatMap((link) =>
              link?.type === "STREAMING" && !link.isDisabled
                ? [{ id: link.id, name: link.site }]
                : []
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
        return serviceCatalogOptionsCache;
      }).pipe(Effect.scoped)
    );
  });
  const serviceAuthorize = Effect.fn("AniList.authorize")(function* (
    token: string,
    current: () => boolean
  ) {
    const identity = yield* serviceProvider((signal) =>
      Effect.gen(function* () {
        const { Viewer } = yield* Effect.tryPromise({
          catch: (cause) => anilistRequestError(cause, signal),
          try: (requestSignal) =>
            serviceSdk.Viewer(
              {},
              { accessToken: token, signal: AbortSignal.any([signal, requestSignal]) }
            ),
        });
        return Viewer;
      }).pipe(Effect.scoped)
    );
    if (identity instanceof ElysiaStatus) {
      return identity;
    }
    if (!(identity?.id && identity.name && current()) || serviceLifecycle.closed) {
      return problem(400, { detail: "AniList authorization expired" });
    }
    serviceOptions.plugins.configure("anilist", { apiKey: token, enabled: true });
    serviceEntries = [];
    serviceAccount = { avatar: identity.avatar, id: identity.id, name: identity.name };
    serviceWriteState("profile", JSON.stringify(serviceAccount));
    serviceConnectedUser = identity.name;
    return yield* serviceList();
  });
  const serviceReceiveAuthorizationUrl = Effect.fn("AniList.receiveAuthorizationUrl")(function* (
    input: string,
    deviceId?: string
  ) {
    const received = yield* Effect.promise(() => serviceAuthorization.receiveUrl(input, deviceId));
    if (received instanceof ElysiaStatus) {
      return received;
    }
    return serviceSnapshot();
  });
  function serviceCancelAuthorization() {
    serviceStopCallback();
    return serviceSnapshot();
  }
  function serviceNeedsRefresh() {
    serviceCheckCacheIdentity();
    return (
      serviceOptions.plugins.plugin("anilist").enabled &&
      !serviceLifecycle.closed &&
      Boolean(serviceOptions.plugins.plugin("anilist").apiKey || serviceConfig.userName) &&
      serviceOptions.now() >= serviceRetryAt &&
      (!serviceCache || serviceOptions.now() - serviceCache.updatedAt >= 5 * 60_000)
    );
  }
  const serviceRefresh = Effect.fn("AniList.refresh")(function* () {
    return serviceNeedsRefresh() ? yield* serviceList() : serviceSnapshot();
  });
  const serviceList = Effect.fn("AniList.list")(function* () {
    serviceCheckCacheIdentity();
    const key = serviceCacheKey();
    if (serviceListFlight && serviceListFlight.key === key) {
      return yield* serviceListFlight.operation;
    }
    serviceRefreshError = null;
    const operation = yield* Effect.cached(
      serviceLoadList(key, serviceOptions.plugins.plugin("anilist").apiKey).pipe(
        Effect.map((result) => {
          if (result instanceof ElysiaStatus) {
            if (key === serviceCacheKey() && !serviceLifecycle.closed) {
              serviceRefreshError = result.response.detail;
              serviceRetryAt = serviceOptions.now() + 30_000;
            }
            return result;
          }
          return serviceSnapshot();
        }),
        Effect.tapCause((cause) =>
          Effect.sync(() => {
            if (key !== serviceCacheKey() || serviceLifecycle.closed) {
              return;
            }
            const error = Cause.squash(cause);
            serviceRefreshError =
              error instanceof Error ? error.message : "Unable to refresh AniList";
            serviceRetryAt = serviceOptions.now() + 30_000;
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (serviceListFlight?.operation === operation) {
              serviceListFlight = null;
            }
          })
        )
      )
    );
    serviceListFlight = { key, operation };
    return yield* operation;
  });

  // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceLoadList = Effect.fn("AniList.loadList")(function* (key: string, token: string) {
    const revision = serviceListRevision;
    if (!serviceOptions.plugins.plugin("anilist").enabled || serviceLifecycle.closed) {
      return problem(409, { detail: "AniList plugin disabled" });
    }
    if (!(serviceOptions.plugins.plugin("anilist").apiKey || serviceConfig.userName)) {
      return problem(400, { detail: "Connect AniList or enter your public account name" });
    }
    // Paging, identity and staleness checks belong to one list snapshot.
    return yield* serviceProvider((signal) =>
      Effect.gen(function* () {
        const identity = token
          ? (yield* Effect.tryPromise({
              catch: (cause) => anilistRequestError(cause, signal),
              try: (requestSignal) =>
                serviceSdk.Viewer(
                  {},
                  { accessToken: token, signal: AbortSignal.any([signal, requestSignal]) }
                ),
            })).Viewer
          : (yield* Effect.tryPromise({
              catch: (cause) => anilistRequestError(cause, signal),
              try: (requestSignal) =>
                serviceSdk.User(
                  { name: serviceConfig.userName },
                  { accessToken: token, signal: AbortSignal.any([signal, requestSignal]) }
                ),
            })).User;
        if (!identity?.id) {
          return problem(404, { detail: "AniList account not found" });
        }
        const found = new Map<number, AniListEntry>();
        let more = true;
        for (let chunk = 1; more && chunk <= 30; chunk += 1) {
          // AniList chunks are sequential and must stop when hasNextChunk is false.
          const response = yield* Effect.tryPromise({
            catch: (cause) => anilistRequestError(cause, signal),
            try: (requestSignal) =>
              serviceSdk.Library(
                { chunk, userId: identity.id },
                { accessToken: token, signal: AbortSignal.any([signal, requestSignal]) }
              ),
          });
          const collection = response.MediaListCollection;
          if (
            !(collection && Array.isArray(collection.lists)) ||
            typeof collection.hasNextChunk !== "boolean"
          ) {
            return problem(502, { detail: "Invalid AniList list" });
          }
          more = collection.hasNextChunk;
          collectEntries(collection, found);
        }
        if (more) {
          return problem(400, { detail: "AniList list too large for a full sync" });
        }
        if (!serviceOptions.plugins.plugin("anilist").enabled || serviceLifecycle.closed) {
          return problem(409, { detail: "AniList plugin disabled" });
        }
        if (key !== serviceCacheKey()) {
          return problem(409, { detail: "The AniList account changed during refresh" });
        }
        if (revision !== serviceListRevision) {
          return null;
        }
        serviceEntries = [...found.values()];
        serviceAccount = identity;
        serviceWriteState("profile", JSON.stringify(identity));
        serviceConnectedUser = identity.name;
        serviceCache = {
          account: identity,
          entries: serviceEntries,
          key,
          updatedAt: serviceOptions.now(),
        };
        serviceWriteState("list-cache", JSON.stringify(serviceCache));
        serviceRetryAt = 0;
        serviceRefreshError = null;
        return null;
      }).pipe(Effect.scoped)
    );
  });
  // biome-ignore-end lint/complexity/noExcessiveCognitiveComplexity: End of the existing operation.
  function serviceAccepted(mediaId: number) {
    return (
      serviceAccount !== null &&
      serviceSelections.get(`selection:${serviceAccount.id}:${mediaId}`) === true
    );
  }
  function serviceEntry(mediaId: number) {
    if (!serviceOptions.plugins.plugin("anilist").enabled || serviceLifecycle.closed) {
      return problem(409, { detail: "AniList plugin disabled" });
    }
    const entry = serviceEntries.find((item) => item.mediaId === mediaId);
    if (!(entry && serviceAccount)) {
      return problem(404, { detail: "Load this anime from your AniList list first" });
    }
    return entry;
  }
  function serviceCompletedEpisodes(entry: AniListEntry) {
    const local = serviceWatched.get(`watched:${serviceAccount?.id}:${entry.mediaId}`) ?? [];
    return [
      ...new Set([...Array.from({ length: entry.progress }, (_, index) => index + 1), ...local]),
    ].sort((a, b) => a - b);
  }
  function serviceAnimeRule(mediaId: number) {
    const id =
      serviceAnimeRules.get(`anime-rule:${serviceAccount?.id}:${mediaId}`) ??
      [...serviceSubscriptions.values()]
        .filter((subscription) => subscription.userId === serviceAccount?.id)
        .flatMap((subscription) => subscription.bindings)
        .find((binding) => binding.mediaId === mediaId)?.ruleId;
    return id ? serviceOptions.automation.ruleSnapshot(id) : undefined;
  }
  function servicePrepareAutomation(mediaId: number, draft: AutomationDraft) {
    const entry = serviceEntry(mediaId);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    const accountId = serviceAccount?.id;
    if (accountId === undefined) {
      return problem(404, { detail: "Load this anime from your AniList list first" });
    }
    return {
      accountId,
      draft: {
        ...draft,
        afterEpisode: entry.progress,
        aliases: entry.aliases,
        anilistId: entry.mediaId,
        episodeCount: entry.episodes ?? undefined,
        title: entry.title,
      },
      id: serviceAnimeRule(mediaId)?.id ?? null,
      key: `anime-rule:${accountId}:${mediaId}`,
    };
  }
  function serviceWriteAutomationLink(
    tx: DatabaseConnection,
    input: { accountId: number; key: string },
    ruleId: string
  ) {
    if (serviceLifecycle.closed || serviceAccount?.id !== input.accountId) {
      return problem(409, { detail: "AniList account changed; reload your list" });
    }
    serviceWriteState(input.key, JSON.stringify(ruleId), tx);
    return null;
  }
  const serviceCompleteEpisode = Effect.fn("AniList.completeEpisode")(function* (
    mediaId: number,
    episode: number,
    completed: boolean,
    expectedAccountId?: number
  ) {
    return yield* serviceMutateMedia(mediaId, () =>
      serviceUpdateEpisode(mediaId, episode, completed, expectedAccountId)
    );
  });
  const serviceMutateMedia = Effect.fn("AniList.mutateMedia")(function* <Result>(
    mediaId: number,
    run: () => Effect.Effect<Result>
  ) {
    const previous = serviceEpisodeRuns.get(mediaId);
    const reservation = Promise.withResolvers<void>();
    serviceEpisodeRuns.set(mediaId, reservation.promise);
    const cleanup = yield* Effect.acquireRelease(
      Effect.sync(() => new DisposableStack()),
      (resource) => Effect.sync(() => resource.dispose())
    );
    cleanup.defer(() => {
      if (serviceEpisodeRuns.get(mediaId) === reservation.promise) {
        serviceEpisodeRuns.delete(mediaId);
      }
      reservation.resolve();
    });
    if (previous) {
      yield* Effect.promise(() => previous);
    }
    return yield* run();
  }, Effect.scoped);

  // biome-ignore-start lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceUpdateEpisode = Effect.fn("AniList.updateEpisode")(function* (
    mediaId: number,
    episode: number,
    completed: boolean,
    expectedAccountId?: number
  ) {
    if (expectedAccountId !== undefined && serviceAccount?.id !== expectedAccountId) {
      return problem(409, { detail: "AniList account changed; reopen the player from your list" });
    }
    if (!serviceOptions.plugins.plugin("anilist").enabled || serviceLifecycle.closed) {
      return problem(409, { detail: "AniList plugin disabled" });
    }
    const entry = serviceEntries.find((item) => item.mediaId === mediaId);
    if (!(entry && serviceAccount)) {
      return problem(404, { detail: "Load this anime from your AniList list first" });
    }
    const accessToken = serviceOptions.plugins.plugin("anilist").apiKey;
    if (!accessToken) {
      return problem(409, { detail: "Connect your AniList account to sync episode progress" });
    }
    if (entry.episodes !== null && episode > entry.episodes) {
      return problem(400, { detail: "Episode exceeds the anime episode count" });
    }
    const accountId = serviceAccount?.id;
    const watched = new Set(serviceCompletedEpisodes(entry));
    if (completed) {
      watched.add(episode);
    } else {
      watched.delete(episode);
    }
    let progress = 0;
    while (watched.has(progress + 1)) {
      progress += 1;
    }
    return yield* serviceProvider((signal) =>
      Effect.gen(function* () {
        const { Viewer } = yield* Effect.tryPromise({
          catch: (cause) => anilistRequestError(cause, signal),
          try: (requestSignal) =>
            serviceSdk.Viewer(
              {},
              { accessToken, signal: AbortSignal.any([signal, requestSignal]) }
            ),
        });
        if (
          Viewer?.id !== accountId ||
          serviceOptions.plugins.plugin("anilist").apiKey !== accessToken
        ) {
          return problem(409, { detail: "Reload your AniList list after changing accounts" });
        }
        if (progress !== entry.progress) {
          const { SaveMediaListEntry } = yield* Effect.tryPromise({
            catch: (cause) => anilistRequestError(cause, signal),
            try: (requestSignal) =>
              serviceSdk.SaveProgress(
                { mediaId, progress },
                { accessToken, signal: AbortSignal.any([signal, requestSignal]) }
              ),
          });
          if (SaveMediaListEntry?.progress !== progress) {
            return problem(502, { detail: "AniList did not save the episode progress" });
          }
        }
        // Shutdown can change the lifecycle while provider effects are suspended.
        if (
          serviceLifecycle.closed ||
          !serviceOptions.plugins.plugin("anilist").enabled ||
          serviceAccount?.id !== accountId
        ) {
          return problem(409, {
            detail: "AniList account changed during episode sync; reload the list",
          });
        }
        const key = `watched:${accountId}:${mediaId}`;
        const episodes = [...watched].sort((a, b) => a - b);
        serviceWatched.set(key, episodes);
        serviceWriteState(key, JSON.stringify(episodes));
        serviceEntries = serviceEntries.map((item) =>
          item.mediaId === mediaId ? { ...item, progress } : item
        );
        serviceListRevision += 1;
        if (serviceCache) {
          serviceCache = { ...serviceCache, entries: serviceEntries };
          serviceWriteState("list-cache", JSON.stringify(serviceCache));
        }
        const rule = serviceAnimeRule(mediaId);
        if (rule) {
          const saved = yield* serviceOptions.releaseAutomation.save(rule.id, {
            ...rule,
            afterEpisode: progress,
          });
          if (saved instanceof ElysiaStatus) {
            return saved;
          }
        }
        for (const subscription of serviceSubscriptions.values()) {
          subscription.nextSyncAt = serviceOptions.now();
          servicePersist(subscription);
        }
        return serviceSnapshot();
      }).pipe(Effect.scoped)
    );
  });
  // biome-ignore-end lint/complexity/noExcessiveCognitiveComplexity: End of the existing operation.
  function servicePreviewThreads(basePath: string, statuses: AniListStatus[]) {
    if (!isAbsolute(basePath)) {
      return problem(400, { detail: "Enter an absolute root folder path" });
    }
    const { destinations } = serviceOptions.engine.snapshot(null, false);
    const trackedStatuses = new Set(statuses);
    return serviceEntries
      .filter((entry) => trackedStatuses.has(entry.status) && serviceAccepted(entry.mediaId))
      .map((entry): AniListThreadProposal => {
        const folder = animeFolder(entry);
        const collision = serviceEntries.some(
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
  function serviceWriteSelection(tx: DatabaseConnection, mediaIds: number[], enabled: boolean) {
    const selectedIds = new Set(mediaIds);
    if (
      !serviceAccount ||
      mediaIds.some((id) => !serviceEntries.some((entry) => entry.mediaId === id))
    ) {
      return problem(400, { detail: "Load the AniList list before choosing its titles" });
    }
    for (const mediaId of mediaIds) {
      serviceWriteState(`selection:${serviceAccount.id}:${mediaId}`, JSON.stringify(enabled), tx);
    }
    for (const current of serviceSubscriptions.values()) {
      const subscription = structuredClone(current);
      for (const binding of subscription.bindings) {
        if (!enabled && selectedIds.has(binding.mediaId)) {
          serviceOptions.automation.enableRule(binding.ruleId, false, tx);
          binding.active = false;
        }
      }
      subscription.nextSyncAt = serviceOptions.now();
      serviceWriteState(subscription.id, JSON.stringify(subscription), tx);
    }
    return { enabled, mediaIds };
  }
  function servicePersist(subscription: AniListSubscription, connection?: DatabaseConnection) {
    serviceSubscriptions.set(subscription.id, subscription);
    serviceWriteState(subscription.id, JSON.stringify(subscription), connection);
  }
  function serviceReassignDestination(id: string, connection?: DatabaseConnection) {
    for (const subscription of serviceSubscriptions.values()) {
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
      servicePersist(subscription, connection);
    }
  }
  function serviceWriteSubscription(
    tx: DatabaseConnection,
    input: Pick<
      AniListSubscription,
      "template" | "statuses" | "enabled" | "intervalMinutes" | "organization"
    >
  ) {
    const { destinations } = serviceOptions.engine.snapshot(null, false);
    if (!destinations.some((destination) => destination.id === input.template.destinationId)) {
      return problem(400, { detail: "Unknown destination" });
    }
    if (input.organization?.mode === "per-anime") {
      const preview = servicePreviewThreads(input.organization.basePath, input.statuses);
      if (preview instanceof ElysiaStatus) {
        return preview;
      }
      const ids = new Set<number>();
      for (const override of input.organization.overrides) {
        if (
          ids.has(override.mediaId) ||
          !override.name.trim() ||
          !isAbsolute(override.downloadPath) ||
          (override.destinationId !== null &&
            !destinations.some((destination) => destination.id === override.destinationId))
        ) {
          return problem(400, { detail: "Check the proposed names, folders, and threads" });
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
      nextSyncAt: serviceOptions.now(),
      userId: serviceAccount?.id,
    };
    serviceWriteState(subscription.id, JSON.stringify(subscription), tx);
    return subscription;
  }
  const serviceSync = Effect.fn("AniList.sync")(function* (id: string) {
    const pending = serviceRuns.get(id);
    if (pending) {
      return yield* pending;
    }
    const subscription = serviceSubscriptions.get(id);
    if (!subscription) {
      return problem(404, { detail: "Unknown AniList tracking" });
    }
    const task = yield* Effect.cached(
      serviceReconcile(subscription).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (
              result instanceof ElysiaStatus &&
              !serviceLifecycle.closed &&
              serviceSubscriptions.get(id) === subscription
            ) {
              subscription.error = "AniList sync interrupted; retry or check the connection";
              subscription.nextSyncAt = serviceOptions.now() + 60_000;
              servicePersist(subscription);
            }
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (serviceRuns.get(id) === task) {
              serviceRuns.delete(id);
            }
          })
        )
      )
    );
    serviceRuns.set(id, task);
    return yield* task;
  });
  function serviceCurrent(subscription: AniListSubscription) {
    return (
      !serviceLifecycle.closed &&
      serviceOptions.plugins.plugin("anilist").enabled &&
      subscription.enabled &&
      serviceSubscriptions.get(subscription.id) === subscription
    );
  }
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceDestinationId = Effect.fn("AniList.destinationId")(function* (
    subscription: AniListSubscription,
    entry: AniListEntry
  ) {
    const { organization } = subscription;
    if (organization?.mode !== "per-anime") {
      return subscription.template.destinationId;
    }
    const preview = servicePreviewThreads(organization.basePath, subscription.statuses);
    const proposal =
      organization.overrides.find((item) => item.mediaId === entry.mediaId) ??
      (preview instanceof ElysiaStatus
        ? undefined
        : preview.find((item) => item.mediaId === entry.mediaId));
    if (!proposal) {
      return problem(400, { detail: "Thread proposal not found" });
    }
    if (proposal.destinationId !== null) {
      if (
        !serviceOptions.engine
          .snapshot(null, false)
          .destinations.some((destination) => destination.id === proposal.destinationId)
      ) {
        return problem(400, { detail: "The selected thread no longer exists" });
      }
      return proposal.destinationId;
    }
    const downloadPath = resolve(proposal.downloadPath);
    const existing = serviceOptions.engine
      .snapshot(null, false)
      .destinations.find((destination) => destination.downloadPath === downloadPath);
    if (existing) {
      return existing.id;
    }
    const pending = serviceDestinationRuns.get(downloadPath);
    if (pending) {
      const destination = yield* Effect.promise(() => pending);
      if (destination instanceof ElysiaStatus) {
        return destination;
      }
      return destination.id;
    }
    const task = serviceOptions.engine.call("saveDestination", [
      null,
      { downloadPath, name: proposal.name },
    ]);
    serviceDestinationRuns.set(downloadPath, task);
    const cleanup = yield* Effect.acquireRelease(
      Effect.sync(() => new DisposableStack()),
      (resource) => Effect.sync(() => resource.dispose())
    );
    cleanup.defer(() => {
      serviceDestinationRuns.delete(downloadPath);
    });
    const created = yield* Effect.promise(() => task);
    if (created instanceof ElysiaStatus) {
      return created;
    }
    return created.id;
  }, Effect.scoped);
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceFollow = Effect.fn("AniList.follow")(function* (
    subscription: AniListSubscription,
    entry: AniListEntry
  ) {
    const binding = subscription.bindings.find((item) => item.mediaId === entry.mediaId);
    const previous =
      serviceAnimeRule(entry.mediaId) ??
      (binding ? serviceOptions.automation.ruleSnapshot(binding.ruleId) : undefined);
    const template = previous ?? subscription.template;
    const overridden = serviceAnimeRules.has(`anime-rule:${serviceAccount?.id}:${entry.mediaId}`);
    const destinationId =
      previous?.destinationId ?? (yield* serviceDestinationId(subscription, entry));
    if (destinationId instanceof ElysiaStatus) {
      return destinationId;
    }
    if (!(serviceCurrent(subscription) && serviceAccepted(entry.mediaId))) {
      return;
    }
    const rule = yield* serviceOptions.releaseAutomation.save(
      previous?.id ?? null,
      {
        ...template,
        afterEpisode: entry.progress,
        aliases: entry.aliases,
        anilistId: entry.mediaId,
        destinationId,
        enabled:
          previous && (overridden || binding?.active)
            ? previous.enabled
            : subscription.template.enabled,
        episodeCount: entry.episodes ?? undefined,
        query: previous?.query ?? `Download "${entry.title}". ${subscription.template.query}`,
        title: entry.title,
      },
      { key: `anime-rule:${serviceAccount?.id}:${entry.mediaId}`, ownerId: "tofu.anilist" }
    );
    if (rule instanceof ElysiaStatus) {
      return rule;
    }
    if (binding) {
      binding.ruleId = rule.id;
      binding.active = true;
    } else {
      subscription.bindings.push({ active: true, mediaId: entry.mediaId, ruleId: rule.id });
    }
    if (!(serviceCurrent(subscription) && serviceAccepted(entry.mediaId))) {
      serviceOptions.automation.enableRule(rule.id, false);
      return;
    }
    servicePersist(subscription);
    const ran = yield* serviceOptions.releaseAutomation.run(rule.id);
    return ran instanceof ElysiaStatus ? ran : undefined;
  });
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceReconcile = Effect.fn("AniList.reconcile")(function* (
    subscription: AniListSubscription
  ) {
    if (
      !(subscription.enabled && serviceOptions.plugins.plugin("anilist").enabled) ||
      serviceLifecycle.closed
    ) {
      return serviceSnapshot();
    }
    const listed = yield* serviceList();
    if (listed instanceof ElysiaStatus) {
      return listed;
    }
    const { entries } = listed;
    if (!serviceCurrent(subscription)) {
      return serviceSnapshot();
    }
    if (subscription.userId !== undefined && subscription.userId !== serviceAccount?.id) {
      servicePause(subscription);
      return problem(409, { detail: "This tracking belongs to another AniList account" });
    }
    subscription.userId = serviceAccount?.id;
    const trackedStatuses = new Set(subscription.statuses);
    const selected = entries.filter(
      (entry) => trackedStatuses.has(entry.status) && serviceAccepted(entry.mediaId)
    );
    for (const entry of selected) {
      if (
        !serviceOptions.plugins.plugin("anilist").enabled ||
        serviceLifecycle.closed ||
        serviceSubscriptions.get(subscription.id) !== subscription
      ) {
        break;
      }
      // preserve each title binding before running the next rule.
      const followed = yield* serviceFollow(subscription, entry);
      if (followed instanceof ElysiaStatus) {
        return followed;
      }
    }
    if (serviceLifecycle.closed || serviceSubscriptions.get(subscription.id) !== subscription) {
      return serviceSnapshot();
    }
    for (const binding of subscription.bindings) {
      if (!selected.some((entry) => entry.mediaId === binding.mediaId)) {
        serviceOptions.automation.enableRule(binding.ruleId, false);
        binding.active = false;
      }
    }
    subscription.lastSyncAt = serviceOptions.now();
    subscription.nextSyncAt = subscription.lastSyncAt + subscription.intervalMinutes * 60_000;
    subscription.error = null;
    servicePersist(subscription);
    return serviceSnapshot();
  });
  function serviceWriteToggle(tx: DatabaseConnection, id: string, enabled: boolean) {
    const current = serviceSubscriptions.get(id);
    if (!current) {
      return problem(404, { detail: "Unknown AniList tracking" });
    }
    const subscription = {
      ...structuredClone(current),
      enabled,
      nextSyncAt: serviceOptions.now(),
    };
    if (!enabled) {
      for (const binding of subscription.bindings) {
        serviceOptions.automation.enableRule(binding.ruleId, false, tx);
        binding.active = false;
      }
    }
    serviceWriteState(id, JSON.stringify(subscription), tx);
    return { enabled, id };
  }
  function serviceDeleteSubscription(tx: DatabaseConnection, id: string) {
    const subscription = serviceSubscriptions.get(id);
    if (!subscription) {
      return problem(404, { detail: "Unknown AniList tracking" });
    }
    for (const binding of subscription.bindings) {
      serviceOptions.automation.enableRule(binding.ruleId, false, tx);
    }
    tx.delete(anilistState).where(eq(anilistState.id, id)).run();
    return { id, ok: true };
  }
  function servicePause(subscription: AniListSubscription) {
    for (const binding of subscription.bindings) {
      serviceOptions.automation.enableRule(binding.ruleId, false);
      binding.active = false;
    }
    servicePersist(subscription);
  }
  function serviceSuspend() {
    serviceStopCallback();
    for (const controller of serviceRequests) {
      controller.abort();
    }
    for (const subscription of serviceSubscriptions.values()) {
      servicePause(subscription);
    }
  }
  const serviceStart = Effect.fn("AniList.start")(function* () {
    if (serviceLifecycle.started || serviceLifecycle.closed) {
      return;
    }
    serviceLifecycle.started = true;
    yield* serviceTick(true);
    if (serviceLifecycle.closed) {
      return;
    }
    const poll = serviceTick(false).pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (Cause.hasInterruptsOnly(cause)) {
            return;
          }
          const log = createLogger({
            component: "anilist",
            error: Cause.squash(cause),
            operation: "poll",
          });
          log.setLevel("error");
          log.emit();
        })
      )
    );
    serviceTimer = yield* Effect.forkIn(
      poll.pipe(
        Effect.repeat(Schedule.spaced("15 seconds")),
        Effect.delay("15 seconds"),
        Effect.asVoid
      ),
      scope
    );
  });
  const serviceTick = Effect.fn("AniList.tick")(function* (force: boolean) {
    if (serviceLifecycle.closed) {
      return;
    }
    yield* Effect.all(
      [...serviceSubscriptions.values()]
        .filter(
          (subscription) =>
            subscription.enabled &&
            (force ||
              subscription.nextSyncAt === null ||
              subscription.nextSyncAt <= serviceOptions.now())
        )
        .map((subscription) => serviceSync(subscription.id)),
      { concurrency: "unbounded" }
    );
  });
  const serviceClose = Effect.fn("AniList.close")(function* () {
    serviceLifecycle.closed = true;
    if (notificationTimer) {
      yield* Fiber.interrupt(notificationTimer);
      notificationTimer = null;
    }
    if (serviceTimer) {
      yield* Fiber.interrupt(serviceTimer);
      serviceTimer = null;
    }
    serviceStopCallback();
    for (const controller of serviceRequests) {
      controller.abort();
    }
    yield* Effect.all(
      [
        ...serviceRuns.values(),
        ...Array.from(serviceEpisodeRuns.values(), (promise) => Effect.promise(() => promise)),
        ...(serviceListFlight ? [serviceListFlight.operation] : []),
        ...(notificationFlight ? [notificationFlight.operation] : []),
      ].map(Effect.exit),
      { concurrency: "unbounded" }
    );
  });

  serviceAuthorization = new AniListAuthorization((token, current) =>
    Effect.runPromise(serviceAuthorize(token, current))
  );
  serviceRestore();
  if (
    options.client &&
    (serviceConfig.clientId === "9037" || serviceConfig.redirectUri.startsWith("tofu"))
  ) {
    serviceConfig = { ...serviceConfig, ...options.client, clientSecret: "" };
  } else if (
    serviceConfig.clientId === "9037" &&
    serviceConfig.redirectUri === "http://localhost:3000/"
  ) {
    serviceConfig.redirectUri = "tofu://oauth/anilist";
    serviceConfig.clientSecret = "";
  }
  serviceCheckCacheIdentity();
  const restoredCache = serviceCache as AniListCache | null;
  if (restoredCache) {
    serviceEntries = restoredCache.entries;
    serviceAccount = restoredCache.account;
    serviceConnectedUser = restoredCache.account.name;
  }
  yield* Effect.addFinalizer(() => serviceClose());
  return {
    cancelAuthorization: serviceCancelAuthorization,
    catalog: serviceCatalog,
    catalogOptions: serviceCatalogOptions,
    checkNotifications: serviceCheckNotifications,
    close: serviceClose,
    completeEpisode: serviceCompleteEpisode,
    configure: serviceConfigure,
    connect: serviceConnect,
    deleteEntry: serviceDeleteEntry,
    deleteSubscription: serviceDeleteSubscription,
    editor: serviceEditor,
    entry: serviceEntry,
    favourite: serviceFavourite,
    list: serviceList,
    media: serviceMedia,
    needsRefresh: serviceNeedsRefresh,
    notificationStatus: serviceNotificationStatus,
    notifications: serviceNotifications,
    prepareAutomation: servicePrepareAutomation,
    previewThreads: servicePreviewThreads,
    reassignDestination: serviceReassignDestination,
    receiveAuthorizationUrl: serviceReceiveAuthorizationUrl,
    refresh: serviceRefresh,
    refreshState: serviceRefreshState,
    releases: serviceReleases,
    saveEntry: serviceSaveEntry,
    snapshot: serviceSnapshot,
    start: serviceStart,
    startNotifications: serviceStartNotifications,
    suspend: serviceSuspend,
    sync: serviceSync,
    tick: serviceTick,
    writeAutomationLink: serviceWriteAutomationLink,
    writePreferences: serviceWritePreferences,
    writeSelection: serviceWriteSelection,
    writeSubscription: serviceWriteSubscription,
    writeToggle: serviceWriteToggle,
  };
});

export type AniListService = AniList["Service"];
export class AniList extends Context.Service<
  AniList,
  {
    readonly releases: (
      mediaId: number,
      onProgress?: (releases: FeedRelease[]) => void
    ) => Effect.Effect<
      | ReturnType<typeof problem<409, { readonly detail: "AniList service closed" }>>
      | ReturnType<typeof problem<404, { readonly detail: "Anime not found on AniList" }>>
      | ReturnType<typeof problem<502, { readonly detail: string }>>
      | {
          errors: { sourceId: SourcePluginId; message: string }[];
          releases: FeedRelease[];
          search: {
            aliases: string[];
            resolved: boolean;
            season: number | null;
            warning: string | null;
            episode: number | null;
            queries: string[];
            title: string;
          };
          torrents: TorrentSummary[];
        }
    >;
    readonly notifications: (
      filters: NotificationFilters,
      reset?: boolean
    ) => Effect.Effect<
      | {
          hasNextPage: boolean;
          notifications: ReturnType<typeof notificationView>[];
          page: number;
          unreadCount: number;
        }
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<404, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly notificationStatus: () => { hasUpdates: boolean; revision: number };
    readonly checkNotifications: (
      force?: boolean
    ) => Effect.Effect<
      | { hasUpdates: boolean; revision: number }
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly startNotifications: (sync: SyncRuntimeOptions) => Effect.Effect<void>;
    readonly snapshot: () => AniListState;
    readonly writePreferences: (
      tx: DatabaseConnection,
      visibleStatuses: AniListStatus[]
    ) => { visibleStatuses: MediaListStatus[] };
    readonly refreshState: () => void;
    readonly configure: (input: {
      clientId?: string;
      clientSecret?: string;
      redirectUri?: string;
      userName: string;
    }) =>
      | AniListState
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "The OAuth callback must be a local HTTP URL with an explicit port" }
          >
        >;
    readonly connect: (deviceId?: string) => Effect.Effect<
      | ReturnType<typeof problem<409, { readonly detail: "AniList unavailable" }>>
      | ReturnType<
          typeof problem<
            409,
            {
              readonly detail: "This development build needs its own AniList client. Set TOFU_ANILIST_CLIENT_ID and rebuild Tofu Dev.";
            }
          >
        >
      | ReturnType<
          typeof problem<
            409,
            {
              readonly detail: `AniList connection needs local port ${string}. Close the app using that port and try again.`;
            }
          >
        >
      | { url: string }
      | ReturnType<
          typeof problem<400, { readonly detail: "Add your AniList OAuth client ID and secret" }>
        >
      | ReturnType<
          typeof problem<
            409,
            {
              readonly detail: "The OAuth callback port is busy. Choose the same available port in Tofu and your AniList client.";
            }
          >
        >
    >;
    readonly media: (
      mediaId: number
    ) => Effect.Effect<
      | AniListMedia
      | ReturnType<typeof problem<409, { readonly detail: "AniList service closed" }>>
      | ReturnType<typeof problem<404, { readonly detail: "Anime not found on AniList" }>>
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly catalog: (
      filters: AniListCatalogFilters
    ) => Effect.Effect<
      | ReturnType<
          typeof problem<400, { readonly detail: "The minimum must not exceed the maximum" }>
        >
      | { hasNextPage: boolean; media: AniListMedia[]; page: number }
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly editor: (mediaId: number) => Effect.Effect<
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "AniList account changed; reopen the anime editor" }
          >
        >
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "Reload your AniList list after changing accounts" }
          >
        >
      | ReturnType<typeof problem<404, { readonly detail: "Anime not found on AniList" }>>
      | ReturnType<typeof problem<502, { readonly detail: "Invalid AniList list entry" }>>
      | {
          entry: {
            advancedScores: { name: string; score: number }[];
            customLists: string[];
            progress: number;
            status: MediaListStatus;
            id: number;
            mediaId: number;
            score: number | null;
            repeat: number | null;
            priority: number | null;
            private: boolean | null;
            notes: string | null;
            hiddenFromStatusLists: boolean | null;
            startedAt: { year: number | null; month: number | null; day: number | null } | null;
            completedAt: { year: number | null; month: number | null; day: number | null } | null;
          } | null;
          isFavourite: boolean | null;
          isFavouriteBlocked: boolean | null;
          options: {
            advancedScoring: string[];
            advancedScoringEnabled: boolean;
            customLists: string[];
            scoreFormat: ScoreFormat | null;
          };
        }
      | ReturnType<typeof problem<409, { readonly detail: "AniList plugin disabled" }>>
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "Connect your AniList account to edit your list or favourites" }
          >
        >
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly saveEntry: (
      mediaId: number,
      body: AniListListUpdate
    ) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | ReturnType<typeof problem<400, { readonly detail: "Pattern too long" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Invalid pattern" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "Enter a title and at least one source" }>
        >
      | ReturnType<typeof problem<404, { readonly detail: "Unknown automation" }>>
      | AniListState
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "AniList account changed; reopen the anime editor" }
          >
        >
      | ReturnType<typeof problem<404, { readonly detail: "Anime not found on AniList" }>>
      | ReturnType<typeof problem<502, { readonly detail: "Invalid AniList list entry" }>>
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Score does not match your AniList scoring format" }
          >
        >
      | ReturnType<
          typeof problem<400, { readonly detail: "Progress exceeds the anime episode count" }>
        >
      | ReturnType<
          typeof problem<400, { readonly detail: "Choose an existing AniList custom list" }>
        >
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Advanced scores do not match your AniList settings" }
          >
        >
      | ReturnType<typeof problem<502, { readonly detail: "AniList did not save the list entry" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Unknown release source" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Unknown destination" }>>
      | ReturnType<typeof problem<409, { readonly detail: "AniList plugin disabled" }>>
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "Connect your AniList account to edit your list or favourites" }
          >
        >
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly favourite: (
      mediaId: number,
      enabled: boolean
    ) => Effect.Effect<
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "AniList account changed; reopen the anime editor" }
          >
        >
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "Reload your AniList list after changing accounts" }
          >
        >
      | ReturnType<typeof problem<404, { readonly detail: "Anime not found on AniList" }>>
      | ReturnType<typeof problem<502, { readonly detail: "Invalid AniList list entry" }>>
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "AniList account changed; reopen the anime editor" }
          >
        >
      | ReturnType<typeof problem<502, { readonly detail: "AniList favourite state unavailable" }>>
      | ReturnType<
          typeof problem<409, { readonly detail: "AniList does not allow favouriting this anime" }>
        >
      | ReturnType<typeof problem<502, { readonly detail: "AniList did not update the favourite" }>>
      | { isFavourite: boolean }
      | ReturnType<typeof problem<409, { readonly detail: "AniList plugin disabled" }>>
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "Connect your AniList account to edit your list or favourites" }
          >
        >
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly deleteEntry: (
      mediaId: number
    ) => Effect.Effect<
      | AniListState
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "AniList account changed; reopen the anime editor" }
          >
        >
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "Reload your AniList list after changing accounts" }
          >
        >
      | ReturnType<typeof problem<404, { readonly detail: "Anime not found on AniList" }>>
      | ReturnType<typeof problem<502, { readonly detail: "Invalid AniList list entry" }>>
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "AniList account changed; reopen the anime editor" }
          >
        >
      | ReturnType<
          typeof problem<502, { readonly detail: "AniList did not delete the list entry" }>
        >
      | ReturnType<typeof problem<409, { readonly detail: "AniList plugin disabled" }>>
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "Connect your AniList account to edit your list or favourites" }
          >
        >
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly catalogOptions: () => Effect.Effect<
      AniListCatalogOptions | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly receiveAuthorizationUrl: (
      input: string,
      deviceId?: string
    ) => Effect.Effect<
      | AniListState
      | ReturnType<typeof problem<400, { readonly detail: string }>>
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly cancelAuthorization: () => AniListState;
    readonly needsRefresh: () => boolean;
    readonly refresh: () => Effect.Effect<AniListState | ListFailure>;
    readonly list: () => Effect.Effect<AniListState | ListFailure>;
    readonly entry: (
      mediaId: number
    ) =>
      | AniListEntry
      | ReturnType<typeof problem<409, { readonly detail: "AniList plugin disabled" }>>
      | ReturnType<
          typeof problem<404, { readonly detail: "Load this anime from your AniList list first" }>
        >;
    readonly prepareAutomation: (
      mediaId: number,
      draft: AutomationDraft
    ) =>
      | ReturnType<typeof problem<409, { readonly detail: "AniList plugin disabled" }>>
      | ReturnType<
          typeof problem<404, { readonly detail: "Load this anime from your AniList list first" }>
        >
      | {
          accountId: number;
          draft: {
            afterEpisode: number;
            aliases: string[];
            anilistId: number;
            episodeCount?: number;
            title: string;
            automatic: boolean;
            codecs: string[];
            deleteReplacedFiles?: boolean | undefined;
            destinationId: string;
            enabled: boolean;
            excludePacks: boolean;
            includeExisting: boolean;
            intervalMinutes: number;
            languages: ("VF" | "VOSTFR" | "MULTI")[];
            matchMode: "exact" | "pattern";
            paused: boolean;
            priority: ("source" | "language" | "resolution" | "codec")[];
            query: string;
            resolutions: string[];
            season: number | null;
            sources: string[];
            waitMinutes: number;
          };
          id: string | null;
          key: string;
        };
    readonly writeAutomationLink: (
      tx: DatabaseConnection,
      input: { accountId: number; key: string },
      ruleId: string
    ) => ReturnType<
      typeof problem<409, { readonly detail: "AniList account changed; reload your list" }>
    > | null;
    readonly completeEpisode: (
      mediaId: number,
      episode: number,
      completed: boolean,
      expectedAccountId?: number
    ) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | ReturnType<typeof problem<400, { readonly detail: "Pattern too long" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Invalid pattern" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "Enter a title and at least one source" }>
        >
      | ReturnType<typeof problem<404, { readonly detail: "Unknown automation" }>>
      | AniListState
      | ReturnType<typeof problem<400, { readonly detail: "Unknown release source" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Unknown destination" }>>
      | ReturnType<
          typeof problem<404, { readonly detail: "Load this anime from your AniList list first" }>
        >
      | ReturnType<
          typeof problem<400, { readonly detail: "Episode exceeds the anime episode count" }>
        >
      | ReturnType<typeof problem<502, { readonly detail: string }>>
    >;
    readonly previewThreads: (
      basePath: string,
      statuses: AniListStatus[]
    ) =>
      | ReturnType<typeof problem<400, { readonly detail: "Enter an absolute root folder path" }>>
      | { destinationId: string | null; downloadPath: string; mediaId: number; name: string }[];
    readonly writeSelection: (
      tx: DatabaseConnection,
      mediaIds: number[],
      enabled: boolean
    ) =>
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Load the AniList list before choosing its titles" }
          >
        >
      | { enabled: boolean; mediaIds: number[] };
    readonly reassignDestination: (id: string, connection?: DatabaseConnection) => void;
    readonly writeSubscription: (
      tx: DatabaseConnection,
      input: Pick<
        AniListSubscription,
        "template" | "statuses" | "enabled" | "intervalMinutes" | "organization"
      >
    ) =>
      | AniListSubscription
      | ReturnType<typeof problem<400, { readonly detail: "Enter an absolute root folder path" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Unknown destination" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "Check the proposed names, folders, and threads" }>
        >;
    readonly sync: (id: string) => Effect.Effect<
      | ReturnType<typeof problem<429, { readonly detail: string }>>
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<typeof problem<503, { readonly detail: string }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "File path outside the download folder" }>
        >
      | ReturnType<
          typeof problem<400, { readonly detail: "Enter a name and an absolute folder path" }>
        >
      | ReturnType<typeof problem<404, { readonly detail: "Tab not found" }>>
      | ReturnType<typeof problem<404, { readonly detail: "Torrent not found" }>>
      | ReturnType<
          typeof problem<
            404,
            {
              readonly detail: `The downloaded file is no longer present : ${string}. Restore it or verify the torrent before retrying.`;
            }
          >
        >
      | ReturnType<typeof problem<400, { readonly detail: "Pattern too long" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Invalid pattern" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "Enter a title and at least one source" }>
        >
      | ReturnType<typeof problem<404, { readonly detail: "Unknown automation" }>>
      | AniListState
      | ReturnType<typeof problem<400, { readonly detail: "Unknown release source" }>>
      | ReturnType<typeof problem<400, { readonly detail: "Unknown destination" }>>
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Connect AniList or enter your public account name" }
          >
        >
      | ReturnType<typeof problem<404, { readonly detail: "AniList account not found" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "AniList list too large for a full sync" }>
        >
      | ReturnType<typeof problem<502, { readonly detail: string }>>
      | ReturnType<typeof problem<400, { readonly detail: "Thread proposal not found" }>>
      | ReturnType<typeof problem<400, { readonly detail: "The selected thread no longer exists" }>>
      | ReturnType<typeof problem<404, { readonly detail: "Unknown AniList tracking" }>>
    >;
    readonly writeToggle: (
      tx: DatabaseConnection,
      id: string,
      enabled: boolean
    ) =>
      | ReturnType<typeof problem<404, { readonly detail: "Unknown AniList tracking" }>>
      | { enabled: boolean; id: string };
    readonly deleteSubscription: (
      tx: DatabaseConnection,
      id: string
    ) =>
      | ReturnType<typeof problem<404, { readonly detail: "Unknown AniList tracking" }>>
      | { id: string; ok: boolean };
    readonly suspend: () => void;
    readonly start: () => Effect.Effect<void>;
    readonly tick: (force: boolean) => Effect.Effect<void>;
    readonly close: () => Effect.Effect<void>;
  }
>()("tofu/anilist") {}
export const aniListLayer = Layer.effect(AniList, make);

export type AniListCatalog = Extract<
  Effect.Success<ReturnType<AniListService["catalog"]>>,
  { media: AniListMedia[] }
>;

export type AniListNotifications = Extract<
  Effect.Success<ReturnType<AniListService["notifications"]>>,
  { notifications: unknown[] }
>;
