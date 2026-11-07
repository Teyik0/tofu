import { eq, sql } from "drizzle-orm";
import { Context, Effect, Layer, Result } from "effect";
import { ElysiaStatus, problem } from "elysia";
import { transmissionServers } from "../../../db/schema";
import { Database } from "../../lib/db";
import {
  mapSession,
  mapTorrent,
  mapTorrentDetail,
  type RawSession,
  type RawStats,
  type RawTorrent,
  TORRENT_DETAIL_FIELDS,
  TORRENT_FIELDS,
} from "./mapping";
import type {
  TransmissionActionInput,
  TransmissionAddInput,
  TransmissionFilesInput,
  TransmissionLimitsInput,
  TransmissionRemoveInput,
  TransmissionServer,
  TransmissionServerInput,
  TransmissionSession,
  TransmissionState,
  TransmissionTorrentDetail,
} from "./model";
import {
  forgetTransmissionSession,
  type TransmissionEndpoint,
  TransmissionRpcError,
  transmissionRpc,
} from "./rpc";

const REQUEST_TIMEOUT = 10_000;
const TRAILING_SLASHES = /\/+$/;

type Row = typeof transmissionServers.$inferSelect;

type TransmissionFailure =
  | ReturnType<typeof problem<401, { readonly detail: string }>>
  | ReturnType<typeof problem<404, { readonly detail: string }>>
  | ReturnType<typeof problem<409, { readonly detail: string }>>
  | ReturnType<typeof problem<502, { readonly detail: string }>>
  | ReturnType<typeof problem<504, { readonly detail: string }>>;

export interface TransmissionAdded {
  id: number | null;
  infoHash: string;
  name: string;
}

interface RpcAddedTorrent {
  hashString?: string;
  id?: number;
  name?: string;
}

function view(row: Row): TransmissionServer {
  return {
    enabled: row.enabled,
    hasPassword: row.password !== null,
    id: row.id,
    name: row.name,
    origin: row.origin,
    rpcPath: row.rpcPath,
    username: row.username,
  };
}

function endpoint(row: Row): TransmissionEndpoint {
  return {
    origin: row.origin,
    password: row.password,
    rpcPath: row.rpcPath,
    username: row.username,
  };
}

/** Every RPC exchange is bounded so a sleeping daemon cannot hold an API request open. */
function deadline(signal: AbortSignal) {
  return AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)]);
}

function failure(cause: unknown): TransmissionFailure {
  if (cause instanceof TransmissionRpcError) {
    return cause.status === 401
      ? problem(401, { detail: cause.message })
      : problem(502, { detail: cause.message });
  }
  if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
    return problem(504, { detail: "Transmission did not answer in time" });
  }
  return problem(502, { detail: "Transmission could not be reached" });
}

async function readSession(server: Row, signal: AbortSignal) {
  const scoped = deadline(signal);
  const [session, stats] = await Promise.all([
    transmissionRpc<RawSession>(endpoint(server), "session-get", undefined, scoped),
    transmissionRpc<RawStats>(endpoint(server), "session-stats", undefined, scoped),
  ]);
  return mapSession(session, stats);
}

function limitParameters(input: TransmissionLimitsInput) {
  const parameters: Record<string, unknown> = {};
  if (input.altSpeedEnabled !== undefined) {
    parameters["alt-speed-enabled"] = input.altSpeedEnabled;
  }
  if (input.downloadLimit !== undefined) {
    parameters["speed-limit-down"] = input.downloadLimit;
  }
  if (input.downloadLimited !== undefined) {
    parameters["speed-limit-down-enabled"] = input.downloadLimited;
  }
  if (input.idleSeedingLimit !== undefined) {
    parameters["idle-seeding-limit"] = input.idleSeedingLimit;
  }
  if (input.idleSeedingLimitEnabled !== undefined) {
    parameters["idle-seeding-limit-enabled"] = input.idleSeedingLimitEnabled;
  }
  if (input.peerLimitGlobal !== undefined) {
    parameters["peer-limit-global"] = input.peerLimitGlobal;
  }
  if (input.peerLimitPerTorrent !== undefined) {
    parameters["peer-limit-per-torrent"] = input.peerLimitPerTorrent;
  }
  if (input.seedRatioLimit !== undefined) {
    parameters.seedRatioLimit = input.seedRatioLimit;
  }
  if (input.seedRatioLimited !== undefined) {
    parameters.seedRatioLimited = input.seedRatioLimited;
  }
  if (input.uploadLimit !== undefined) {
    parameters["speed-limit-up"] = input.uploadLimit;
  }
  if (input.uploadLimited !== undefined) {
    parameters["speed-limit-up-enabled"] = input.uploadLimited;
  }
  return parameters;
}

/** Torrent-add arguments for magnets, URLs and base64 metainfo alike. */
function addParameters(input: TransmissionAddInput) {
  const parameters: Record<string, unknown> = { filename: input.source };
  if (input.paused === true) {
    parameters.paused = true;
  }
  if (input.downloadDir) {
    parameters["download-dir"] = input.downloadDir;
  }
  return parameters;
}

const make = Effect.gen(function* () {
  const db = yield* Database;

  const listed = () => db.select().from(transmissionServers).orderBy(sql`rowid`).all();
  const stored = (serverId: string) =>
    db.select().from(transmissionServers).where(eq(transmissionServers.id, serverId)).get();

  function requireServer(serverId: string): Row | TransmissionFailure {
    const row = stored(serverId);
    if (!row) {
      return problem(404, { detail: "This Transmission server is not configured" });
    }
    if (!row.enabled) {
      return problem(409, { detail: "This Transmission server is disabled" });
    }
    return row;
  }

  const servers = Effect.fn("Transmission.servers")(function* () {
    return yield* Effect.sync(() => listed().map(view));
  });

  const saveServer = Effect.fn("Transmission.saveServer")(function* (
    serverId: string | null,
    input: TransmissionServerInput
  ) {
    const existing = serverId === null ? undefined : stored(serverId);
    if (serverId !== null && !existing) {
      return problem(404, { detail: "This Transmission server is not configured" });
    }
    const now = Date.now();
    const row: Row = {
      createdAt: existing?.createdAt ?? now,
      enabled: input.enabled ?? existing?.enabled ?? true,
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name,
      origin: input.origin.replace(TRAILING_SLASHES, ""),
      // An omitted password keeps the stored credential; an empty one clears it.
      password:
        input.password === undefined ? (existing?.password ?? null) : input.password || null,
      rpcPath: input.rpcPath,
      updatedAt: now,
      username:
        input.username === undefined ? (existing?.username ?? null) : input.username || null,
    };
    yield* Effect.sync(() => {
      if (existing) {
        db.update(transmissionServers).set(row).where(eq(transmissionServers.id, row.id)).run();
      } else {
        db.insert(transmissionServers).values(row).run();
      }
    });
    return view(row);
  });

  const removeServer = Effect.fn("Transmission.removeServer")(function* (serverId: string) {
    const existing = yield* Effect.sync(() => stored(serverId));
    if (!existing) {
      return problem(404, { detail: "This Transmission server is not configured" });
    }
    yield* Effect.sync(() => {
      db.delete(transmissionServers).where(eq(transmissionServers.id, serverId)).run();
      forgetTransmissionSession(endpoint(existing));
    });
    return { ok: true } as const;
  });

  const state = Effect.fn("Transmission.state")(function* (serverId: string) {
    const server = requireServer(serverId);
    if (server instanceof ElysiaStatus) {
      return server;
    }
    const result = yield* Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: async (signal) => {
          const scoped = deadline(signal);
          const [session, stats, torrents] = await Promise.all([
            transmissionRpc<RawSession>(endpoint(server), "session-get", undefined, scoped),
            transmissionRpc<RawStats>(endpoint(server), "session-stats", undefined, scoped),
            transmissionRpc<{ torrents?: RawTorrent[] }>(
              endpoint(server),
              "torrent-get",
              { fields: TORRENT_FIELDS },
              scoped
            ),
          ]);
          return {
            fetchedAt: Date.now(),
            server: view(server),
            session: mapSession(session, stats),
            torrents: (torrents.torrents ?? []).map(mapTorrent),
          } satisfies TransmissionState;
        },
      })
    );
    if (Result.isFailure(result)) {
      return failure(result.failure);
    }
    return result.success;
  });

  const detail = Effect.fn("Transmission.detail")(function* (serverId: string, torrentId: number) {
    const server = requireServer(serverId);
    if (server instanceof ElysiaStatus) {
      return server;
    }
    const result = yield* Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: async (signal) => {
          const payload = await transmissionRpc<{ torrents?: RawTorrent[] }>(
            endpoint(server),
            "torrent-get",
            { fields: TORRENT_DETAIL_FIELDS, ids: [torrentId] },
            deadline(signal)
          );
          const [torrent] = payload.torrents ?? [];
          return torrent ? mapTorrentDetail(torrent) : null;
        },
      })
    );
    if (Result.isFailure(result)) {
      return failure(result.failure);
    }
    if (result.success === null) {
      return problem(404, { detail: "This torrent does not exist in Transmission" });
    }
    return result.success;
  });

  const methods = {
    reannounce: "torrent-reannounce",
    start: "torrent-start",
    "start-now": "torrent-start-now",
    stop: "torrent-stop",
    verify: "torrent-verify",
  } as const;

  const control = Effect.fn("Transmission.control")(function* (
    serverId: string,
    input: TransmissionActionInput
  ) {
    const server = requireServer(serverId);
    if (server instanceof ElysiaStatus) {
      return server;
    }
    const result = yield* Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: (signal) =>
          transmissionRpc(
            endpoint(server),
            methods[input.action],
            { ids: input.ids },
            deadline(signal)
          ),
      })
    );
    if (Result.isFailure(result)) {
      return failure(result.failure);
    }
    return { ok: true } as const;
  });

  const add = Effect.fn("Transmission.add")(function* (
    serverId: string,
    input: TransmissionAddInput
  ) {
    const server = requireServer(serverId);
    if (server instanceof ElysiaStatus) {
      return server;
    }
    const result = yield* Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: (signal) =>
          transmissionRpc<{
            "torrent-added"?: RpcAddedTorrent;
            "torrent-duplicate"?: RpcAddedTorrent;
          }>(endpoint(server), "torrent-add", addParameters(input), deadline(signal)),
      })
    );
    if (Result.isFailure(result)) {
      return failure(result.failure);
    }
    const added = result.success["torrent-added"] ?? result.success["torrent-duplicate"];
    return {
      id: added?.id ?? null,
      infoHash: added?.hashString ?? "",
      name: added?.name ?? input.source,
    } satisfies TransmissionAdded;
  });

  const remove = Effect.fn("Transmission.remove")(function* (
    serverId: string,
    input: TransmissionRemoveInput
  ) {
    const server = requireServer(serverId);
    if (server instanceof ElysiaStatus) {
      return server;
    }
    const result = yield* Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: (signal) =>
          transmissionRpc(
            endpoint(server),
            "torrent-remove",
            { "delete-local-data": input.deleteLocalData === true, ids: input.ids },
            deadline(signal)
          ),
      })
    );
    if (Result.isFailure(result)) {
      return failure(result.failure);
    }
    return { ok: true } as const;
  });

  const setLimits = Effect.fn("Transmission.setLimits")(function* (
    serverId: string,
    input: TransmissionLimitsInput
  ) {
    const server = requireServer(serverId);
    if (server instanceof ElysiaStatus) {
      return server;
    }
    const parameters = limitParameters(input);
    const result = yield* Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: async (signal) => {
          const scoped = deadline(signal);
          await transmissionRpc(endpoint(server), "session-set", parameters, scoped);
          return readSession(server, scoped);
        },
      })
    );
    if (Result.isFailure(result)) {
      return failure(result.failure);
    }
    return result.success satisfies TransmissionSession;
  });

  const setFiles = Effect.fn("Transmission.setFiles")(function* (
    serverId: string,
    torrentId: number,
    input: TransmissionFilesInput
  ) {
    const server = requireServer(serverId);
    if (server instanceof ElysiaStatus) {
      return server;
    }
    const result = yield* Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: async (signal) => {
          const scoped = deadline(signal);
          const payload = await transmissionRpc<{ torrents?: RawTorrent[] }>(
            endpoint(server),
            "torrent-get",
            { fields: ["files"], ids: [torrentId] },
            scoped
          );
          const [torrent] = payload.torrents ?? [];
          const indexes = (torrent?.files ?? []).map((_, index) => index);
          const wanted = new Set(input.wanted);
          const wantedIndices = indexes.filter((index) => wanted.has(index));
          const unwantedIndices = indexes.filter((index) => !wanted.has(index));
          await transmissionRpc(
            endpoint(server),
            "torrent-set",
            {
              "files-unwanted": unwantedIndices,
              "files-wanted": wantedIndices,
              ids: [torrentId],
            },
            scoped
          );
        },
      })
    );
    if (Result.isFailure(result)) {
      return failure(result.failure);
    }
    return { ok: true } as const;
  });

  return {
    add,
    control,
    detail,
    remove,
    removeServer,
    saveServer,
    servers,
    setFiles,
    setLimits,
    state,
  };
});

export class Transmission extends Context.Service<
  Transmission,
  {
    readonly add: (
      serverId: string,
      input: TransmissionAddInput
    ) => Effect.Effect<TransmissionAdded | TransmissionFailure>;
    readonly control: (
      serverId: string,
      input: TransmissionActionInput
    ) => Effect.Effect<{ readonly ok: true } | TransmissionFailure>;
    readonly detail: (
      serverId: string,
      torrentId: number
    ) => Effect.Effect<TransmissionTorrentDetail | TransmissionFailure>;
    readonly remove: (
      serverId: string,
      input: TransmissionRemoveInput
    ) => Effect.Effect<{ readonly ok: true } | TransmissionFailure>;
    readonly removeServer: (
      serverId: string
    ) => Effect.Effect<{ readonly ok: true } | TransmissionFailure>;
    readonly saveServer: (
      serverId: string | null,
      input: TransmissionServerInput
    ) => Effect.Effect<TransmissionServer | TransmissionFailure>;
    readonly servers: () => Effect.Effect<TransmissionServer[]>;
    readonly setFiles: (
      serverId: string,
      torrentId: number,
      input: TransmissionFilesInput
    ) => Effect.Effect<{ readonly ok: true } | TransmissionFailure>;
    readonly setLimits: (
      serverId: string,
      input: TransmissionLimitsInput
    ) => Effect.Effect<TransmissionSession | TransmissionFailure>;
    readonly state: (serverId: string) => Effect.Effect<TransmissionState | TransmissionFailure>;
  }
>()("tofu/transmission") {}

export const transmissionLayer = Layer.effect(Transmission, make);
