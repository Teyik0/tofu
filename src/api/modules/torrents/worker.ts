import { Effect, ManagedRuntime, Result } from "effect";
import { createLogger, initLogger, toLoggerConfig } from "evlog";
import { config } from "../../../../evlog.config";
import { Database, databaseLayer } from "../../lib/db";
import { serveWorker } from "../../lib/worker-rpc";
import { openTorrentEngine, type TorrentEngine } from "./service";
import type { EngineSnapshot } from "./types";
import type { EngineEvents, EngineOperations } from "./worker-protocol";

declare let self: Worker;

initLogger({
  ...toLoggerConfig(config),
  drain(context) {
    postMessage({ context, type: "log" });
  },
});

let engine: TorrentEngine | null = null;
const databaseRuntime = ManagedRuntime.make(databaseLayer);
const torrentIdPattern = /^[a-f0-9]{40}$/;
let dataDir = "";
let unsubscribe: (() => void) | undefined;
let posting = false;
let closing = false;

function snapshot(): EngineSnapshot | null {
  if (!engine || closing) {
    return null;
  }
  return {
    sampledAt: Date.now(),
    state: engine.snapshot(null, false),
    stateRevision: engine.stateRevision,
    telemetryRevision: engine.telemetryRevision,
  };
}

const methods: Partial<EngineOperations> = {
  async close() {
    await using lifetime = new AsyncDisposableStack();
    lifetime.use(databaseRuntime);
    closing = true;
    unsubscribe?.();
    engine?.cancelRanges();
    await rpc.drain();
    await engine?.close();
  },
  async open(options) {
    await using startup = new AsyncDisposableStack();
    startup.use(databaseRuntime);
    ({ dataDir } = options);
    const db = await databaseRuntime.runPromise(Database);
    const opened = await openTorrentEngine(options, db);
    engine = opened;
    startup.defer(opened.close);
    Object.assign(methods, {
      add: engine.add,
      addPeer: engine.addPeer,
      assertReady: engine.assertReady,
      cancelRange: engine.cancelRange,
      cancelRanges: engine.cancelRanges,
      connectionDiagnostics: engine.connectionDiagnostics,
      detail: engine.detail,
      file: engine.file,
      locate: engine.locate,
      pause: engine.pause,
      priority: engine.priority,
      reannounce: engine.reannounce,
      refreshSnapshot: engine.refreshSnapshot,
      remove: engine.remove,
      removeDestination: engine.removeDestination,
      repair: engine.repair,
      replaceTrackers: engine.replaceTrackers,
      resume: engine.resume,
      saveDestination: engine.saveDestination,
      updateDestinationPresentation: engine.updateDestinationPresentation,
      updateSettings: engine.updateSettings,
      verify: engine.verify,
      waitForRange: engine.waitForRange,
    } satisfies Omit<EngineOperations, "open" | "close">);
    unsubscribe = engine.subscribeChanges(() => {
      // Coalesce synchronous bursts of engine changes into one snapshot message.
      if (posting) {
        return;
      }
      posting = true;
      queueMicrotask(() => {
        posting = false;
        const published = Effect.runSync(
          Effect.result(
            Effect.try({
              catch: (error) => error,
              // Structured cloning and publishing cross the worker transport boundary.
              try: () => {
                const current = snapshot();
                if (current) {
                  rpc.emit("snapshot", current);
                }
              },
            })
          )
        );
        if (Result.isFailure(published)) {
          const log = createLogger({
            component: "torrent-worker",
            dataDir,
            error: published.failure,
            operation: "publish",
          });
          log.setLevel("error");
          log.emit();
        }
      });
    });
    startup.move();
  },
};

const rpc = serveWorker<EngineOperations, EngineEvents>(self, methods, {
  after(method) {
    const readOnly = [
      "assertReady",
      "connectionDiagnostics",
      "detail",
      "file",
      "waitForRange",
      "cancelRange",
      "cancelRanges",
      "close",
    ].includes(method);
    const current = readOnly ? null : snapshot();
    if (current) {
      rpc.emit("snapshot", current);
    }
  },
  onError(error, method, args) {
    const argument = method === "waitForRange" ? args[1] : args[0];
    const torrentId =
      typeof argument === "string" && torrentIdPattern.test(argument) ? argument : undefined;
    const log = createLogger({
      component: "torrent-worker",
      context: { torrentId },
      dataDir,
      error,
      operation: method,
    });
    log.setLevel("error");
    log.emit();
  },
  shutdownMethod: "close",
});
