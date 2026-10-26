import { Access } from "../access/layer";
import "@teyik0/furin/server-only";
import { eq } from "drizzle-orm";
import { Context, Effect, Layer, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { problem } from "elysia";
import { linkedServers } from "../../../db/schema";
import { PROTOCOL_MAJOR } from "../../../lib/protocol";
import { Database } from "../../lib/db";
import { animeEpisodeOffset, localAnimeSearch } from "../anilist/releases";
import type { AniListEntry } from "../anilist/types";
import type { AvailabilityQuery, EpisodeSource } from "./availability";

const DEADLINE = 4000;
const CACHE_TTL = 60_000;
const STALE_TTL = 10 * 60_000;
const MAX_LINKS = 8;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
const decodeDescriptor = HttpClientResponse.schemaBodyJson(
  Schema.Struct({
    name: Schema.String,
    product: Schema.Literal("tofu"),
    protocol: Schema.optional(Schema.Struct({ major: Schema.optional(Schema.Number) })),
    serverId: Schema.String,
  })
);
const decodePair = HttpClientResponse.schemaBodyJson(
  Schema.Struct({
    detail: Schema.optional(Schema.String),
    device: Schema.optional(Schema.Struct({ id: Schema.String })),
    server: Schema.optional(Schema.Struct({ id: Schema.String })),
    token: Schema.optional(Schema.String),
  })
);
const decodeAvailability = HttpClientResponse.schemaBodyJson(
  Schema.Struct({
    results: Schema.Array(
      Schema.Struct({
        sources: Schema.Array(
          Schema.Struct({
            episode: Schema.NullOr(Schema.Number),
            fileIndex: Schema.Number,
            fileName: Schema.String,
            language: Schema.NullOr(Schema.String),
            length: Schema.Number,
            match: Schema.Literals(["infohash", "title"]),
            progress: Schema.NullOr(Schema.Number),
            resolution: Schema.NullOr(Schema.String),
            status: Schema.Literals(["playable", "downloading", "paused", "unavailable"]),
            torrentId: Schema.String,
          })
        ).pipe(Schema.mutable),
      })
    ),
  })
);
const decodePlayback = HttpClientResponse.schemaBodyJson(
  Schema.Struct({
    expiresAt: Schema.Number,
    file: Schema.Struct({
      complete: Schema.Boolean,
      index: Schema.Number,
      length: Schema.Number,
      name: Schema.String,
    }),
    id: Schema.String,
    url: Schema.String,
  })
);

type LinkedServer = typeof linkedServers.$inferSelect;

export type LinkAvailability =
  | { state: "available" | "none"; checkedAt: number; sources: EpisodeSource[] }
  | { state: "offline"; checkedAt: number | null; sources: EpisodeSource[] }
  | { state: "revoked" | "identity-changed" | "incompatible"; checkedAt: number; sources: [] };

interface LinkedLibrariesOptions {
  db: Database["Service"];
  now: () => number;
  /** This server's own identity, which it must never link to. */
  serverId: () => string;
}

/**
 * HTTPS origin of another server. Plain HTTP is accepted only on this computer (an SSH tunnel or a
 * second local instance), where no network can observe the credential.
 */
function serverOrigin(address: string) {
  const url = URL.parse(address.includes("://") ? address : `https://${address}`);
  if (!url || url.username || url.password) {
    return null;
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
    return url.origin;
  }
  return null;
}

/**
 * Servers this server uses as playback sources. It holds a link credential issued by each of
 * them (a Playback device by default) and never shares its own AniList account with them.
 */
const make = Effect.gen(function* () {
  const http = HttpClient.withScope(yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" })
    )
  );
  const db = yield* Database;
  const { access } = yield* Access;
  const options: LinkedLibrariesOptions = {
    db,
    now: Date.now,
    serverId: () => access.identity().serverId,
  };

  const serviceOptions = options;

  const serviceCache = new Map<string, { at: number; sources: EpisodeSource[] }>();
  function serviceList() {
    return serviceOptions.db
      .select()
      .from(linkedServers)
      .all()
      .map((link) => ({
        createdAt: link.createdAt,
        id: link.id,
        lastCheckedAt: link.lastCheckedAt,
        name: link.name,
        origin: link.origin,
        serverId: link.serverId,
        state: link.state,
      }));
  }
  const serviceDescriptor = Effect.fn("Libraries.descriptor")(function* (origin: string) {
    const response = yield* http.get(`${origin}/.well-known/tofu`).pipe(Effect.timeout(DEADLINE));
    if (response.status < 200 || response.status >= 300) {
      return null;
    }
    const decoded = yield* Effect.result(decodeDescriptor(response).pipe(Effect.timeout(DEADLINE)));
    if (Result.isFailure(decoded)) {
      return null;
    }
    const body = decoded.success;
    return {
      compatible: body.protocol?.major === PROTOCOL_MAJOR,
      name: body.name,
      serverId: body.serverId,
    };
  }, Effect.scoped);
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceLink = Effect.fn("Libraries.link")(function* (input: {
    address: string;
    code?: string;
    label: string;
    secret?: string;
  }) {
    if (serviceList().length >= MAX_LINKS) {
      return problem(409, { detail: "Remove a linked library before adding another" });
    }
    const origin = serverOrigin(input.address);
    if (!origin) {
      return problem(400, { detail: "Enter the server's HTTPS address" });
    }
    const described = yield* Effect.result(serviceDescriptor(origin));
    if (Result.isFailure(described)) {
      return problem(502, {
        detail: "This server could not be reached securely. Check its address and certificate",
      });
    }
    const descriptor = described.success;
    if (!descriptor) {
      return problem(502, { detail: "This address is not a Tofu server" });
    }
    if (!descriptor.compatible) {
      return problem(409, { detail: "This server runs an incompatible Tofu version" });
    }
    if (descriptor.serverId === serviceOptions.serverId()) {
      return problem(400, { detail: "This is the current server" });
    }
    if (serviceList().some((existing) => existing.serverId === descriptor.serverId)) {
      return problem(409, { detail: `${descriptor.name} is already linked` });
    }
    const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
    const paired = yield* Effect.result(
      http
        .execute(
          HttpClientRequest.post(`${origin}/api/auth/pair`).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              code: input.code,
              kind: "server",
              label: input.label,
              nonce,
              secret: input.secret,
            })
          )
        )
        .pipe(Effect.timeout(DEADLINE * 2))
    );
    if (Result.isFailure(paired)) {
      return problem(502, { detail: `${descriptor.name} did not answer. Try again` });
    }
    const response = paired.success;
    const decoded = yield* Effect.result(decodePair(response).pipe(Effect.timeout(DEADLINE)));
    if (Result.isFailure(decoded)) {
      return problem(502, { detail: "The server returned an unreadable invitation response" });
    }
    const body = decoded.success;
    if (response.status < 200 || response.status >= 300) {
      return problem(response.status === 410 ? 410 : 403, {
        detail: body.detail ?? "The invitation was refused",
      });
    }
    if (!(body.token && body.device && body.server?.id === descriptor.serverId)) {
      return problem(502, { detail: "The server answered with an unexpected identity" });
    }
    const link = {
      createdAt: serviceOptions.now(),
      credential: body.token,
      deviceId: body.device.id,
      id: crypto.randomUUID(),
      lastCheckedAt: serviceOptions.now(),
      name: descriptor.name,
      origin,
      serverId: descriptor.serverId,
      state: "active" as const,
    };
    serviceOptions.db.insert(linkedServers).values(link).run();
    return {
      createdAt: link.createdAt,
      id: link.id,
      lastCheckedAt: link.lastCheckedAt,
      name: link.name,
      origin: link.origin,
      serverId: link.serverId,
      state: link.state,
    };
  }, Effect.scoped);
  const serviceUnlink = Effect.fn("Libraries.unlink")(function* (id: string) {
    const link = serviceFind(id);
    if (!link) {
      return problem(404, { detail: "Linked server not found" });
    }
    const revoked = yield* Effect.result(
      http
        .post(`${link.origin}/api/auth/logout`, {
          headers: { authorization: `Bearer ${link.credential}` },
        })
        .pipe(Effect.timeout(DEADLINE))
    );
    const revokedRemotely =
      Result.isSuccess(revoked) &&
      ((revoked.success.status >= 200 && revoked.success.status < 300) ||
        revoked.success.status === 401);
    serviceOptions.db.delete(linkedServers).where(eq(linkedServers.id, id)).run();
    return { removed: true as const, revokedRemotely };
  }, Effect.scoped);
  function serviceFind(id: string) {
    return serviceOptions.db.select().from(linkedServers).where(eq(linkedServers.id, id)).get();
  }
  function serviceMark(link: LinkedServer, state: LinkedServer["state"]) {
    serviceOptions.db
      .update(linkedServers)
      .set({ lastCheckedAt: serviceOptions.now(), state })
      .where(eq(linkedServers.id, link.id))
      .run();
  }
  const serviceVerify = Effect.fn("Libraries.verify")(function* (link: LinkedServer) {
    const described = yield* Effect.result(serviceDescriptor(link.origin));
    const descriptor = Result.isSuccess(described) ? described.success : null;
    if (!descriptor) {
      return "offline" as const;
    }
    if (descriptor.serverId !== link.serverId) {
      serviceMark(link, "identity-changed");
      return "identity-changed" as const;
    }
    if (!descriptor.compatible) {
      return "incompatible" as const;
    }
    return "ok" as const;
  });
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing ordered validation and lifecycle decisions in this operation.
  const serviceQuery = Effect.fn("Libraries.query")(function* (
    link: LinkedServer,
    query: AvailabilityQuery
  ) {
    const now = serviceOptions.now();
    const key = `${link.id}:${JSON.stringify(query)}`;
    const cached = serviceCache.get(key);
    if (cached && now - cached.at < CACHE_TTL) {
      return {
        checkedAt: cached.at,
        sources: cached.sources,
        state: cached.sources.length ? "available" : "none",
      };
    }
    const offline = (): LinkAvailability =>
      cached && now - cached.at < STALE_TTL
        ? { checkedAt: cached.at, sources: cached.sources, state: "offline" }
        : { checkedAt: null, sources: [], state: "offline" };
    if (link.state !== "active") {
      return { checkedAt: link.lastCheckedAt ?? now, sources: [], state: link.state };
    }
    const verified = yield* serviceVerify(link);
    if (verified !== "ok") {
      return verified === "offline" ? offline() : { checkedAt: now, sources: [], state: verified };
    }
    const queried = yield* Effect.result(
      http
        .execute(
          HttpClientRequest.post(`${link.origin}/api/library/availability`, {
            headers: {
              authorization: `Bearer ${link.credential}`,
              "content-type": "application/json",
            },
          }).pipe(HttpClientRequest.bodyJsonUnsafe({ queries: [query] }))
        )
        .pipe(Effect.timeout(DEADLINE))
    );
    if (Result.isFailure(queried)) {
      return offline();
    }
    const response = queried.success;
    if ([401, 403].includes(response.status)) {
      serviceMark(link, "revoked");
      return { checkedAt: now, sources: [], state: "revoked" };
    }
    if (response.status < 200 || response.status >= 300) {
      return offline();
    }
    const decoded = yield* Effect.result(
      decodeAvailability(response).pipe(Effect.timeout(DEADLINE))
    );
    if (Result.isFailure(decoded)) {
      return offline();
    }
    const body = decoded.success;
    const sources = body.results[0]?.sources ?? [];
    if (serviceCache.size >= 1024) {
      const first = serviceCache.keys().next().value;
      if (first) {
        serviceCache.delete(first);
      }
    }
    serviceCache.set(key, { at: now, sources });
    serviceMark(link, "active");
    return { checkedAt: now, sources, state: sources.length ? "available" : "none" };
  }, Effect.scoped);
  const serviceAvailability = Effect.fn("Libraries.availability")(function* (
    query: AvailabilityQuery
  ) {
    const links = serviceOptions.db.select().from(linkedServers).all().slice(0, MAX_LINKS);
    const results = yield* Effect.all(
      links.map((link) => serviceQuery(link, query)),
      { concurrency: "unbounded" }
    );
    return links.map((link, index) => ({
      link: { id: link.id, name: link.name, origin: link.origin },
      ...(results[index] as LinkAvailability),
    }));
  });
  const serviceAvailabilityForAnime = Effect.fn("Libraries.availabilityForAnime")(function* (
    query: AvailabilityQuery,
    mediaId: number,
    entries: AniListEntry[]
  ) {
    const entry = entries.find((item) => item.mediaId === mediaId);
    if (!entry) {
      return problem(409, {
        detail: "Reload this anime from your AniList list before checking remote sources",
      });
    }
    const plan = localAnimeSearch(entry);
    return yield* serviceAvailability({
      ...query,
      episodeOffset: animeEpisodeOffset(entry, entries),
      part: plan.part ?? query.part ?? 1,
      season: plan.season ?? query.season ?? 1,
      titles: [...new Set([...entry.aliases, entry.title, ...plan.seriesTitles])].slice(0, 12),
    });
  });
  const serviceRevokePlayback = Effect.fn("Libraries.revokePlayback")(function* (
    id: string,
    playbackId: string
  ) {
    const link = serviceFind(id);
    if (link?.state !== "active") {
      return problem(404, { detail: "Linked server not found" });
    }
    if ((yield* serviceVerify(link)) !== "ok") {
      return problem(503, { detail: "The linked server is unavailable" });
    }
    const revoked = yield* Effect.result(
      http
        .execute(
          HttpClientRequest.post(`${link.origin}/api/media-links/revoke`, {
            headers: {
              authorization: `Bearer ${link.credential}`,
              "content-type": "application/json",
            },
          }).pipe(HttpClientRequest.bodyJsonUnsafe({ id: playbackId }))
        )
        .pipe(Effect.timeout(DEADLINE))
    );
    if (Result.isFailure(revoked)) {
      return problem(503, {
        detail: "The linked server is unreachable. The playback link will expire automatically",
      });
    }
    const response = revoked.success;
    if (response.status < 200 || response.status >= 300) {
      return problem(409, { detail: "The linked server could not revoke this playback link" });
    }
    return { revoked: true as const };
  }, Effect.scoped);
  const servicePlay = Effect.fn("Libraries.play")(function* (
    id: string,
    torrentId: string,
    fileIndex: number
  ) {
    const link = serviceFind(id);
    if (link?.state !== "active") {
      return problem(404, { detail: "Linked server not found" });
    }
    if ((yield* serviceVerify(link)) !== "ok") {
      return problem(503, { detail: `${link.name} is not available` });
    }
    const played = yield* Effect.result(
      http
        .execute(
          HttpClientRequest.post(`${link.origin}/api/media-links`, {
            headers: {
              authorization: `Bearer ${link.credential}`,
              "content-type": "application/json",
            },
          }).pipe(HttpClientRequest.bodyJsonUnsafe({ fileIndex, torrentId }))
        )
        .pipe(Effect.timeout(DEADLINE))
    );
    if (Result.isFailure(played)) {
      return problem(503, { detail: `${link.name} is not reachable` });
    }
    const response = played.success;
    if (response.status === 401 || response.status === 403) {
      serviceMark(link, "revoked");
      return problem(403, { detail: `${link.name} removed access for this server` });
    }
    if (response.status < 200 || response.status >= 300) {
      return problem(404, { detail: "This file is no longer available" });
    }
    const decoded = yield* Effect.result(decodePlayback(response).pipe(Effect.timeout(DEADLINE)));
    if (Result.isFailure(decoded)) {
      return problem(502, { detail: "The linked server returned an unreadable playback response" });
    }
    const body = decoded.success;
    // The linked server builds the URL from its own address; it must stay on that origin.
    if (URL.parse(body.url)?.origin !== link.origin) {
      return problem(502, { detail: "The linked server answered with another address" });
    }
    return {
      expiresAt: body.expiresAt,
      file: body.file,
      id: body.id,
      server: { id: link.serverId, name: link.name },
      url: body.url,
    };
  }, Effect.scoped);

  return {
    availability: serviceAvailability,
    availabilityForAnime: serviceAvailabilityForAnime,
    link: serviceLink,
    list: serviceList,
    play: servicePlay,
    revokePlayback: serviceRevokePlayback,
    unlink: serviceUnlink,
  };
});

export type LinkedLibraries = Libraries["Service"];
export class Libraries extends Context.Service<
  Libraries,
  {
    readonly list: () => {
      createdAt: number;
      id: string;
      lastCheckedAt: number | null;
      name: string;
      origin: string;
      serverId: string;
      state: "active" | "revoked" | "identity-changed";
    }[];
    readonly link: (input: {
      address: string;
      code?: string;
      label: string;
      secret?: string;
    }) => Effect.Effect<
      | ReturnType<
          typeof problem<409, { readonly detail: "Remove a linked library before adding another" }>
        >
      | ReturnType<typeof problem<400, { readonly detail: "Enter the server's HTTPS address" }>>
      | ReturnType<
          typeof problem<
            502,
            {
              readonly detail: "This server could not be reached securely. Check its address and certificate";
            }
          >
        >
      | ReturnType<typeof problem<502, { readonly detail: "This address is not a Tofu server" }>>
      | ReturnType<
          typeof problem<409, { readonly detail: "This server runs an incompatible Tofu version" }>
        >
      | ReturnType<typeof problem<400, { readonly detail: "This is the current server" }>>
      | ReturnType<typeof problem<409, { readonly detail: `${string} is already linked` }>>
      | ReturnType<typeof problem<502, { readonly detail: `${string} did not answer. Try again` }>>
      | ReturnType<
          typeof problem<
            502,
            { readonly detail: "The server returned an unreadable invitation response" }
          >
        >
      | ReturnType<typeof problem<403 | 410, { readonly detail: string }>>
      | ReturnType<
          typeof problem<
            502,
            { readonly detail: "The server answered with an unexpected identity" }
          >
        >
      | {
          createdAt: number;
          id: `${string}-${string}-${string}-${string}-${string}`;
          lastCheckedAt: number;
          name: string;
          origin: string;
          serverId: string;
          state: "active";
        }
    >;
    readonly unlink: (
      id: string
    ) => Effect.Effect<
      | ReturnType<typeof problem<404, { readonly detail: "Linked server not found" }>>
      | { removed: true; revokedRemotely: boolean }
    >;
    readonly availability: (query: AvailabilityQuery) => Effect.Effect<
      (
        | {
            state: "available" | "none";
            checkedAt: number;
            sources: EpisodeSource[];
            link: { id: string; name: string; origin: string };
          }
        | {
            state: "offline";
            checkedAt: number | null;
            sources: EpisodeSource[];
            link: { id: string; name: string; origin: string };
          }
        | {
            state: "revoked" | "identity-changed" | "incompatible";
            checkedAt: number;
            sources: [];
            link: { id: string; name: string; origin: string };
          }
      )[]
    >;
    readonly availabilityForAnime: (
      query: AvailabilityQuery,
      mediaId: number,
      entries: AniListEntry[]
    ) => Effect.Effect<
      | (
          | {
              state: "available" | "none";
              checkedAt: number;
              sources: EpisodeSource[];
              link: { id: string; name: string; origin: string };
            }
          | {
              state: "offline";
              checkedAt: number | null;
              sources: EpisodeSource[];
              link: { id: string; name: string; origin: string };
            }
          | {
              state: "revoked" | "identity-changed" | "incompatible";
              checkedAt: number;
              sources: [];
              link: { id: string; name: string; origin: string };
            }
        )[]
      | ReturnType<
          typeof problem<
            409,
            {
              readonly detail: "Reload this anime from your AniList list before checking remote sources";
            }
          >
        >
    >;
    readonly revokePlayback: (
      id: string,
      playbackId: string
    ) => Effect.Effect<
      | ReturnType<typeof problem<404, { readonly detail: "Linked server not found" }>>
      | ReturnType<typeof problem<503, { readonly detail: "The linked server is unavailable" }>>
      | ReturnType<
          typeof problem<
            503,
            {
              readonly detail: "The linked server is unreachable. The playback link will expire automatically";
            }
          >
        >
      | ReturnType<
          typeof problem<
            409,
            { readonly detail: "The linked server could not revoke this playback link" }
          >
        >
      | { revoked: true }
    >;
    readonly play: (
      id: string,
      torrentId: string,
      fileIndex: number
    ) => Effect.Effect<
      | ReturnType<typeof problem<404, { readonly detail: "Linked server not found" }>>
      | ReturnType<typeof problem<503, { readonly detail: `${string} is not available` }>>
      | ReturnType<typeof problem<503, { readonly detail: `${string} is not reachable` }>>
      | ReturnType<
          typeof problem<403, { readonly detail: `${string} removed access for this server` }>
        >
      | ReturnType<typeof problem<404, { readonly detail: "This file is no longer available" }>>
      | ReturnType<
          typeof problem<
            502,
            { readonly detail: "The linked server returned an unreadable playback response" }
          >
        >
      | ReturnType<
          typeof problem<
            502,
            { readonly detail: "The linked server answered with another address" }
          >
        >
      | {
          expiresAt: number;
          file: { index: number; length: number; name: string; complete: boolean };
          id: string;
          server: { id: string; name: string };
          url: string;
        }
    >;
  }
>()("tofu/linked-libraries") {}
export const librariesLayer = Layer.effect(Libraries, make);
