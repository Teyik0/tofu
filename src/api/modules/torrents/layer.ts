import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { Context, Effect, Layer } from "effect";
import { ElysiaStatus } from "elysia";
import { createLogger } from "evlog";
import { version } from "../../../../package.json";
import workerBundle from "../../../../runtime/engine-worker.worker" with { type: "file" };
import { Database } from "../../lib/database-layer";
import { instance } from "../../lib/instance";
import { createWorkerClient } from "../../lib/worker-rpc";
import type { DashboardState, EngineChange } from "./types";
import type { EngineEvents, EngineOperations } from "./worker-protocol";

const make = Effect.gen(function* () {
  // Main-process migrations must finish before the worker opens the same file.
  yield* Database;
  const source = new URL("./worker.ts", import.meta.url);
  const compiled = new URL(workerBundle, import.meta.url);
  const artifact = new URL(`../furin/${workerBundle}`, import.meta.url);
  const entry = [source, artifact, compiled].find((candidate) => existsSync(candidate));
  if (!entry) {
    return yield* Effect.fail(new Error("The torrent worker entrypoint is missing"));
  }

  const worker = yield* Effect.acquireRelease(
    Effect.try(() => new Worker(entry)),
    (resource) => Effect.sync(() => resource.terminate())
  );
  const client = yield* Effect.acquireRelease(
    Effect.sync(() =>
      createWorkerClient<EngineOperations, EngineEvents>(worker, {
        onFailure(error, methods, exitCode) {
          const log = createLogger({
            component: "torrent-worker",
            context: { exitCode, pendingOperations: methods },
            dataDir: instance.dataDir,
            error,
            operation: "stopped",
          });
          log.setLevel("error");
          log.emit();
        },
      })
    ),
    (resource) => Effect.sync(resource.close)
  );

  let state: DashboardState;
  let stateRevision = 0;
  let telemetryRevision = 0;
  let sampledAt = 0;
  let refresh: Effect.Effect<
    Awaited<ReturnType<typeof client.call<"refreshSnapshot">>>,
    unknown
  > | null = null;
  let shutdown: Effect.Effect<void, unknown> | null = null;
  const changes = new EventEmitter<{ change: [EngineChange] }>();
  changes.setMaxListeners(0);
  client.on("snapshot", (currentSnapshot) => {
    const structural = currentSnapshot.stateRevision !== stateRevision;
    const telemetry = currentSnapshot.telemetryRevision !== telemetryRevision;
    ({ state, stateRevision, telemetryRevision, sampledAt } = currentSnapshot);
    if (structural || telemetry) {
      changes.emit("change", {
        kind: structural ? "state" : "telemetry",
        stateRevision,
        telemetryRevision,
      });
    }
  });

  function snapshot(_selected: string | null, _includeDetail?: boolean): DashboardState {
    if (client.failure) {
      throw client.failure;
    }
    return {
      ...state,
      session: { ...state.session, mode: instance.desktop ? "desktop" : "server" },
    };
  }

  const close = Effect.fn("TorrentClient.close")(function* () {
    if (shutdown) {
      return yield* shutdown;
    }
    const operation = yield* Effect.cached(
      Effect.gen(function* () {
        if (client.failure) {
          return;
        }
        const result = yield* Effect.tryPromise(() => client.call("close", []));
        if (result instanceof ElysiaStatus && !client.failure) {
          return yield* Effect.die(new Error(result.response.detail));
        }
      }).pipe(Effect.ensuring(Effect.sync(client.close)))
    );
    shutdown = operation;
    yield* operation;
  });

  const refreshSnapshot = Effect.fn("TorrentClient.refreshSnapshot")(function* (maxAgeMs: number) {
    if (maxAgeMs > 0 && Date.now() - sampledAt <= maxAgeMs && !client.failure) {
      return snapshot(null, false);
    }
    if (refresh) {
      return yield* refresh;
    }
    const operation = yield* Effect.cached(
      Effect.gen(function* () {
        const result = yield* Effect.tryPromise(() => client.call("refreshSnapshot", [0]));
        return result instanceof ElysiaStatus ? result : snapshot(null, false);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (refresh === operation) {
              refresh = null;
            }
          })
        )
      )
    );
    refresh = operation;
    return yield* operation;
  });

  const torrents = {
    // RPC is the native Promise boundary; callers preserve its typed returned statuses.
    call: client.call,
    close,
    off: changes.off.bind(changes),
    on: changes.on.bind(changes),
    refreshSnapshot,
    settings: () => state.settings,
    snapshot,
    stateRevision: () => stateRevision,
    telemetryRevision: () => telemetryRevision,
  };

  yield* Effect.tryPromise({ catch: (error) => error, try: () => client.ready });
  const opened = yield* Effect.tryPromise({
    catch: (error) => error,
    try: () =>
      client.call("open", [
        {
          cryptoDiagnostics: process.env.TOFU_CRYPTO_DIAGNOSTICS === "1",
          dataDir: instance.dataDir,
          downloadPath: instance.defaultDownloadPath,
          network: { maxConns: 40, userAgent: `Tofu/${version}`, utp: false },
        },
      ]),
  });
  if (opened instanceof ElysiaStatus) {
    return yield* Effect.fail(new Error(opened.response.detail));
  }
  yield* Effect.addFinalizer(() => close().pipe(Effect.orDie));
  const ready = yield* Effect.tryPromise({
    catch: (error) => error,
    try: () => client.call("assertReady", []),
  });
  if (ready instanceof ElysiaStatus) {
    return yield* Effect.fail(new Error(ready.response.detail));
  }

  return torrents;
});

export class TorrentClient extends Context.Service<TorrentClient, Effect.Success<typeof make>>()(
  "tofu/torrent-client"
) {}

export const torrentClientLayer = Layer.effect(TorrentClient, make);
