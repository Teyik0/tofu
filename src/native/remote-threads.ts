import { EventEmitter } from "node:events";
import { treaty } from "@elysia/eden";
import { ElysiaStatus, problem } from "elysia";
import type { accessRoutesPlugin } from "../api/modules/access";
import type { publicDocumentsPlugin } from "../api/modules/access/documents";
import type { dashboardPlugin } from "../api/modules/dashboard";
import type { torrentPlugin } from "../api/modules/torrents";
import type { ServerCatalog } from "./catalog";

interface RemoteThreadsOptions {
  catalog: ServerCatalog;
  memory: Map<string, string>;
  service: string;
}

type RemoteRead = Awaited<ReturnType<RemoteThreads["read"]>>;
type RemoteFailure = Extract<
  RemoteRead | Awaited<ReturnType<RemoteThreads["follow"]>>,
  { status: number }
>;
type RemoteLibrary = Exclude<RemoteRead, RemoteFailure>;

type RemoteConnectionState = {
  server: RemoteLibrary["server"];
} & (
  | {
      connection: "connecting";
      snapshot: null;
      failure: null;
    }
  | {
      connection: "ready";
      snapshot: RemoteLibrary;
      failure: null;
    }
  | {
      connection: "offline" | "unauthorized";
      snapshot: null;
      failure: {
        status: RemoteFailure["status"];
        body: RemoteFailure["response"];
      };
    }
);

export class RemoteThreads extends EventEmitter {
  readonly #options: RemoteThreadsOptions;
  readonly #states = new Map<string, RemoteConnectionState>();
  readonly #generations = new Map<string, symbol>();
  readonly #subscriptions = new Map<
    string,
    {
      controller: AbortController;
      task: Promise<void>;
      failures: number;
    }
  >();

  constructor(options: RemoteThreadsOptions) {
    super();
    this.#options = options;
  }

  start(serverId?: string) {
    for (const server of this.#options.catalog.value.servers) {
      if ((serverId && server.serverId !== serverId) || this.#subscriptions.has(server.serverId)) {
        continue;
      }
      const subscription = {
        controller: new AbortController(),
        failures: 0,
        task: Promise.resolve(),
      };
      this.#subscriptions.set(server.serverId, subscription);
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep one server's retry, cancellation and state publication in the same lifecycle.
      subscription.task = (async () => {
        const { signal } = subscription.controller;
        while (!signal.aborted) {
          this.#generations.delete(server.serverId);
          this.#states.set(server.serverId, {
            connection: "connecting",
            failure: null,
            server: { id: server.serverId, name: server.name },
            snapshot: null,
          });
          this.emit("change", server.serverId);
          let failure: Awaited<ReturnType<RemoteThreads["follow"]>>;
          try {
            // biome-ignore lint/performance/noAwaitInLoops: A server must close its current stream before reconnecting.
            failure = await this.follow(server.serverId, signal);
          } catch (cause) {
            if (signal.aborted) {
              return;
            }
            console.error("Remote thread subscription interrupted", {
              error: cause instanceof Error ? cause.name : "UnknownError",
              serverId: server.serverId,
            });
            failure = problem(503, { detail: "The server or its saved credential is unavailable" });
          }
          if (signal.aborted) {
            return;
          }
          this.#states.set(server.serverId, {
            connection:
              failure.status === 401 || failure.status === 403 ? "unauthorized" : "offline",
            failure: { body: failure.response, status: failure.status },
            server: { id: server.serverId, name: server.name },
            snapshot: null,
          });
          this.emit("change", server.serverId);
          if (
            failure.status === 401 ||
            failure.status === 403 ||
            failure.status === 409 ||
            failure.status === 404
          ) {
            return;
          }
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(subscription.failures, 5));
          subscription.failures += 1;
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, delay);
            signal.addEventListener("abort", finish, { once: true });
            if (signal.aborted) {
              finish();
            }
          });
        }
      })();
    }
  }

  async stop(serverId: string) {
    const subscription = this.#subscriptions.get(serverId);
    this.#subscriptions.delete(serverId);
    this.#generations.delete(serverId);
    subscription?.controller.abort();
    await subscription?.task;
    const state = this.#states.get(serverId);
    if (state) {
      const failure = problem(502, { detail: "The remote stream ended" });
      this.#states.set(serverId, {
        connection: "offline",
        failure: { body: failure.response, status: failure.status },
        server: state.server,
        snapshot: null,
      });
      this.emit("change", serverId);
    }
  }

  async close() {
    const subscriptions = [...this.#subscriptions.values()];
    this.#subscriptions.clear();
    this.#generations.clear();
    for (const subscription of subscriptions) {
      subscription.controller.abort();
    }
    await Promise.all(subscriptions.map((subscription) => subscription.task));
    this.#states.clear();
  }

  snapshot(serverId: string) {
    const server = this.#options.catalog.value.servers.find(
      (candidate) => candidate.serverId === serverId
    );

    if (!server) {
      this.#states.delete(serverId);
      this.#generations.delete(serverId);

      return problem(404, {
        detail: "This server is not saved on this computer",
      });
    }

    return (
      this.#states.get(serverId) ?? {
        connection: "connecting" as const,
        failure: null,
        server: { id: server.serverId, name: server.name },
        snapshot: null,
      }
    );
  }

  async refresh(serverId: string) {
    if (this.#subscriptions.has(serverId)) {
      return await this.read(serverId);
    }
    const server = this.#options.catalog.value.servers.find(
      (candidate) => candidate.serverId === serverId
    );

    if (!server) {
      return problem(404, {
        detail: "This server is not saved on this computer",
      });
    }

    const identity = { id: server.serverId, name: server.name };
    const configuration = JSON.stringify([server.deviceId, server.origins]);
    const generation = Symbol(serverId);

    // Reserve this refresh before starting asynchronous work.
    this.#generations.set(serverId, generation);
    this.#states.set(serverId, {
      connection: "connecting",
      failure: null,
      server: identity,
      snapshot: null,
    });
    this.emit("change", serverId);

    const result = await this.read(serverId);

    const current = this.#options.catalog.value.servers.find(
      (candidate) => candidate.serverId === serverId
    );

    if (!current || JSON.stringify([current.deviceId, current.origins]) !== configuration) {
      return problem(409, { detail: "The saved connection changed during this read" });
    }

    if (this.#generations.get(serverId) !== generation) {
      return result;
    }

    this.#generations.delete(serverId);

    if (result instanceof ElysiaStatus) {
      this.#states.set(serverId, {
        connection: result.status === 401 || result.status === 403 ? "unauthorized" : "offline",
        failure: {
          body: result.response,
          status: result.status,
        },
        server: identity,
        snapshot: null,
      });
    } else {
      this.#states.set(serverId, {
        connection: "ready",
        failure: null,
        server: result.server,
        snapshot: result,
      });
    }

    // Publish the new state before notifying its consumers.
    this.emit("change", serverId);

    return result;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep ordered address fallback and credential admission in one boundary.
  async #open(serverId: string, signal: AbortSignal) {
    const { catalog, memory, service } = this.#options;
    const server = catalog.value.servers.find((candidate) => candidate.serverId === serverId);

    if (!server) {
      return problem(404, { detail: "This server is not saved on this computer" });
    }

    const saved = { ...server, origins: [...server.origins] };
    if (saved.origins.length === 0) {
      return problem(409, { detail: "This server has no saved address" });
    }

    const deadline = performance.now() + 8000;
    for (const [index, origin] of saved.origins.entries()) {
      if (signal.aborted) {
        break;
      }
      try {
        const token = server.temporary
          ? memory.get(server.serverId)
          : // biome-ignore lint/performance/noAwaitInLoops: Each saved address is tried only after the previous attempt failed.
            await Bun.secrets.get({
              name: `${server.serverId}/${server.deviceId}`,
              service,
            });

        if (!token) {
          return problem(401, {
            detail: "This connection has no credential. Pair it again",
          });
        }

        const remaining = Math.floor(deadline - performance.now());
        if (remaining <= 0) {
          break;
        }
        const timeout = Math.max(1, Math.floor(remaining / (saved.origins.length - index)));
        const request = {
          redirect: "error" as const,
          signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
        };
        const publicClient = treaty<typeof publicDocumentsPlugin>(origin, {
          fetch: request,
        });
        const { data: descriptor, error } = await publicClient[".well-known"].tofu.get();

        if (error) {
          continue;
        }

        if (descriptor?.product !== "tofu" || descriptor.serverId !== server.serverId) {
          return problem(409, {
            detail: "Server identity changed. No credential was sent",
          });
        }

        if (
          descriptor.protocol?.major !== 1 ||
          descriptor.protocol.minClient > 1 ||
          descriptor.protocol.maxClient < 1
        ) {
          return problem(409, { detail: "This server uses an incompatible Tofu version" });
        }

        const native = treaty<typeof accessRoutesPlugin>(`${origin}/api`, {
          fetch: request,
          headers: { authorization: `Bearer ${token}` },
        });

        const windowSession = await native.auth["window-sessions"].post();

        if (windowSession.error) {
          if (windowSession.status === 401) {
            return problem(401, { detail: "This connection expired or was revoked" });
          }
          if (windowSession.error.status === 403) {
            return problem(403, { detail: "This connection cannot open a desktop session" });
          }
          continue;
        }

        const headers = {
          cookie: `${windowSession.data.cookie}=${windowSession.data.value}`,
          origin,
        };
        const access = treaty<typeof accessRoutesPlugin>(`${origin}/api`, {
          fetch: { redirect: "error" },
          headers,
        });
        const library = treaty<typeof dashboardPlugin>(`${origin}/api`, {
          fetch: { redirect: "error" },
          headers,
        });

        const stream = treaty<typeof torrentPlugin>(`${origin}/api`, {
          fetch: { redirect: "error" },
          headers,
        });
        return { access, library, server: saved, stream };
      } catch (cause) {
        if (signal.aborted) {
          break;
        }
        console.error("Unable to open remote threads", {
          error: cause instanceof Error ? cause.name : "UnknownError",
          serverId,
        });
      }
    }
    return problem(503, {
      detail: "The server or its saved credential is unavailable",
    });
  }

  async readTorrent(
    serverId: string,
    threadId: string,
    torrentId: string,
    requestSignal: AbortSignal
  ) {
    const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(10_000)]);
    const opened = await this.#open(serverId, signal);
    if (opened instanceof ElysiaStatus) {
      return opened;
    }

    const { access, stream, server } = opened;
    let reads: [
      Awaited<ReturnType<typeof access.session.get>>,
      Awaited<ReturnType<ReturnType<typeof stream.torrents>["get"]>>,
    ];
    let signedOut: Awaited<ReturnType<typeof access.auth.logout.post>> | undefined;
    {
      await using resources = new AsyncDisposableStack();
      resources.defer(async () => {
        signedOut = await access.auth.logout.post(undefined, {
          fetch: { signal: AbortSignal.timeout(2000) },
        });
      });
      reads = await Promise.all([
        access.session.get({ fetch: { signal } }),
        stream.torrents({ id: torrentId }).get({ fetch: { signal } }),
      ]);
    }

    const current = this.#options.catalog.value.servers.find(
      (candidate) => candidate.serverId === serverId
    );
    if (
      !current ||
      current.deviceId !== server.deviceId ||
      JSON.stringify(current.origins) !== JSON.stringify(server.origins)
    ) {
      return problem(409, { detail: "The saved connection changed during this read" });
    }

    const [session, torrent] = reads;
    const failure = session.error ?? torrent.error ?? signedOut?.error;
    if (failure?.status === 401) {
      return problem(401, { detail: "This connection expired or was revoked" });
    }
    if (failure?.status === 403) {
      return problem(403, { detail: "This connection cannot read this torrent" });
    }
    if (torrent.error?.status === 404) {
      return problem(404, { detail: "This torrent does not exist on this server" });
    }
    if (failure || !session.data || !torrent.data) {
      return problem(502, { detail: "The server could not complete the torrent read" });
    }
    if (session.data.server.id !== serverId) {
      return problem(409, { detail: "The response belongs to another server" });
    }
    if (torrent.data.destinationId !== threadId) {
      return problem(404, { detail: "This torrent does not belong to this thread" });
    }
    return {
      capabilities: session.data.capabilities,
      server: session.data.server,
      torrent: torrent.data,
    };
  }

  async read(serverId: string) {
    const signal = AbortSignal.timeout(10_000);
    const opened = await this.#open(serverId, signal);
    if (opened instanceof ElysiaStatus) {
      return opened;
    }
    const { access, library, server } = opened;
    let reads: [
      Awaited<ReturnType<typeof access.session.get>>,
      Awaited<ReturnType<typeof library.state.get>>,
    ];
    let signedOut: Awaited<ReturnType<typeof access.auth.logout.post>>;

    try {
      reads = await Promise.all([
        access.session.get({ fetch: { signal } }),
        library.state.get({ fetch: { signal }, query: { detail: "false" } }),
      ]);
    } finally {
      signedOut = await access.auth.logout.post(undefined, {
        fetch: { signal: AbortSignal.timeout(2000) },
      });
    }

    const current = this.#options.catalog.value.servers.find(
      (candidate) => candidate.serverId === serverId
    );
    if (
      !current ||
      current.deviceId !== server.deviceId ||
      JSON.stringify(current.origins) !== JSON.stringify(server.origins)
    ) {
      return problem(409, { detail: "The saved connection changed during this read" });
    }

    const [session, state] = reads;
    const failure = session.error ?? state.error ?? signedOut.error;

    if (failure?.status === 401) {
      return problem(401, { detail: "This connection expired or was revoked" });
    }
    if (failure?.status === 403) {
      return problem(403, { detail: "This connection cannot read this server" });
    }
    if (failure || !session.data || !state.data) {
      return problem(502, { detail: "The server could not complete the thread read" });
    }

    if (session.data.server.id !== server.serverId || state.data.server.id !== server.serverId) {
      return problem(409, { detail: "The response belongs to another server" });
    }

    return {
      capabilities: session.data.capabilities,
      server: state.data.server,
      threads: state.data.destinations,
      torrents: state.data.torrents.map((torrent) => ({
        destinationId: torrent.destinationId,
        id: torrent.id,
        length: torrent.length,
        name: torrent.name,
        progress: torrent.progress,
        status: torrent.status,
        storageIssue: torrent.storageIssue,
      })),
    };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Session validation, stream acceptance and logout share one resource lifecycle.
  async follow(serverId: string, signal: AbortSignal) {
    const opened = await this.#open(serverId, signal);
    if (opened instanceof ElysiaStatus) {
      return opened;
    }
    const { access, stream, server } = opened;
    const ended = problem(502, { detail: "The remote stream ended" });
    const changed = problem(409, { detail: "The saved connection changed" });
    let outcome: Extract<RemoteRead, { status: number }> | typeof ended | typeof changed;
    let signedOut: Awaited<ReturnType<typeof access.auth.logout.post>>;
    try {
      const session = await access.session.get({
        fetch: { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) },
      });
      if (session.error) {
        if (session.status === 401) {
          outcome = problem(401, { detail: "This connection expired or was revoked" });
        } else if (session.status === 403) {
          outcome = problem(403, { detail: "This connection cannot read this server" });
        } else {
          outcome = problem(502, { detail: "The server could not complete the thread read" });
        }
      } else if (session.data.server.id === serverId) {
        const response = await stream.live.get({ fetch: { signal }, query: {} });
        if (response.error) {
          if (response.status === 401) {
            outcome = problem(401, { detail: "This connection expired or was revoked" });
          } else if (response.status === 403) {
            outcome = problem(403, { detail: "This connection cannot read this server" });
          } else {
            outcome = problem(502, { detail: "The server could not complete the thread read" });
          }
        } else {
          let previous = "";
          outcome = ended;
          for await (const event of response.data) {
            if (signal.aborted) {
              break;
            }
            const current = this.#options.catalog.value.servers.find(
              (candidate) => candidate.serverId === serverId
            );
            if (
              !current ||
              JSON.stringify([current.deviceId, current.origins]) !==
                JSON.stringify([server.deviceId, server.origins])
            ) {
              outcome = changed;
              break;
            }
            const state = event.data;
            if (state.server.id !== serverId) {
              outcome = problem(409, { detail: "The response belongs to another server" });
              break;
            }
            const snapshot = {
              capabilities: session.data.capabilities,
              server: state.server,
              threads: state.destinations,
              torrents: state.torrents.map((torrent) => ({
                destinationId: torrent.destinationId,
                id: torrent.id,
                length: torrent.length,
                name: torrent.name,
                progress: torrent.progress,
                status: torrent.status,
                storageIssue: torrent.storageIssue,
              })),
            };
            const projection = JSON.stringify(snapshot);
            if (projection === previous) {
              continue;
            }
            previous = projection;
            this.#generations.delete(serverId);
            this.#states.set(serverId, {
              connection: "ready",
              failure: null,
              server: snapshot.server,
              snapshot,
            });
            const subscription = this.#subscriptions.get(serverId);
            if (subscription?.controller.signal === signal) {
              subscription.failures = 0;
            }
            this.emit("change", serverId);
          }
        }
      } else {
        outcome = problem(409, { detail: "The response belongs to another server" });
      }
    } finally {
      signedOut = await access.auth.logout.post(undefined, {
        fetch: { signal: AbortSignal.timeout(2000) },
      });
    }
    if (
      signedOut.error &&
      signedOut.status !== 401 &&
      !signal.aborted &&
      outcome.status !== 401 &&
      outcome.status !== 403 &&
      outcome.status !== 409
    ) {
      return problem(502, { detail: "The server could not close the desktop session" });
    }
    return outcome;
  }
}
