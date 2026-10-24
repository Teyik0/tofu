import { ElysiaStatus, HTTPError, problem } from "elysia";
import { createLogger, initLogger, toLoggerConfig } from "evlog";
import { config } from "../../../../evlog.config";
import { sanitizeLog } from "../../lib/diagnostics";
import { openTorrentEngine, type TorrentEngine } from "./service";
import type { EngineSnapshot } from "./types";
import type { EngineFailure, EngineMessage, EngineRequest } from "./worker-protocol";

declare let self: Worker;

initLogger({
  ...toLoggerConfig(config),
  drain(context) {
    postMessage({ context, type: "log" } satisfies EngineMessage);
  },
});
let dataDir = "";
const torrentIdPattern = /^[a-f0-9]{40}$/;

let engine: TorrentEngine | null = null;
let unsubscribe: (() => void) | undefined;
let posting = false;
let closing = false;
const operations = new Set<Promise<void>>();

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

async function execute(request: EngineRequest) {
  if (request.method === "open") {
    ({ dataDir } = request.args[0]);
    engine = await openTorrentEngine(request.args[0]);
    unsubscribe = engine.subscribeChanges(() => {
      // Coalesce synchronous bursts of engine changes into one snapshot message.
      if (posting) {
        return;
      }
      posting = true;
      queueMicrotask(() => {
        posting = false;
        try {
          const current = snapshot();
          if (current) {
            postMessage({ snapshot: current, type: "snapshot" } satisfies EngineMessage);
          }
        } catch (error) {
          const log = createLogger({
            component: "torrent-worker",
            dataDir,
            error: sanitizeLog(error),
            operation: "publish",
          });
          log.setLevel("error");
          log.emit();
        }
      });
    });
    return;
  }
  if (!engine || closing) {
    return problem(503, { detail: "The torrent engine has stopped" });
  }
  // biome-ignore-start lint/suspicious/noUnnecessaryConditions: Biome cannot narrow this mapped request union after the open branch.
  switch (request.method) {
    case "refreshSnapshot":
      await engine.refreshSnapshot(...request.args);
      return;
    case "setObserved":
      return engine.setObserved(request.args[0]);
    case "assertReady":
      return engine.assertReady();
    case "connectionDiagnostics":
      return engine.connectionDiagnostics();
    case "add":
      return engine.add(...request.args);
    case "addPeer":
      return engine.addPeer(...request.args);
    case "detail":
      return engine.detail(...request.args);
    case "file":
      return engine.file(...request.args);
    case "waitForRange":
      return engine.waitForRange(...request.args);
    case "cancelRange":
      return engine.cancelRange(...request.args);
    case "cancelRanges":
      return engine.cancelRanges(...request.args);
    case "locate":
      return engine.locate(...request.args);
    case "pause":
      return engine.pause(...request.args);
    case "priority":
      return engine.priority(...request.args);
    case "reannounce":
      return engine.reannounce(...request.args);
    case "repair":
      return engine.repair(...request.args);
    case "remove":
      return engine.remove(...request.args);
    case "removeDestination":
      return engine.removeDestination(...request.args);
    case "replaceTrackers":
      return engine.replaceTrackers(...request.args);
    case "resume":
      return engine.resume(...request.args);
    case "saveDestination":
      return engine.saveDestination(...request.args);
    case "updateDestinationPresentation":
      return engine.updateDestinationPresentation(...request.args);
    case "updateSettings":
      return engine.updateSettings(...request.args);
    case "verify":
      return engine.verify(...request.args);
    case "close": {
      closing = true;
      unsubscribe?.();
      engine.cancelRanges();
      await Promise.allSettled([...operations]);
      return engine.close();
    }
    default:
      throw new Error("Unsupported torrent command", { cause: request satisfies never });
  }
  // biome-ignore-end lint/suspicious/noUnnecessaryConditions: Mapped request union ends here.
}

// Commands must wait until imports have loaded and the listener is installed.
self.onmessage = ({ data }: MessageEvent<EngineRequest>) => {
  // Reserve the operation before executing it, including commands that finish synchronously.
  const pending = Promise.withResolvers<void>();
  const operation = pending.promise;
  if (data.method !== "close") {
    operations.add(operation);
  }
  const argument = data.method === "waitForRange" ? data.args[1] : data.args[0];
  const torrentId =
    typeof argument === "string" && torrentIdPattern.test(argument) ? argument : undefined;
  const run = async () => {
    try {
      const value = await execute(data);
      if (value instanceof ElysiaStatus) {
        postMessage({
          body: value.response,
          headers: value.headers,
          id: data.id,
          status: value.status,
          type: "failure",
        } satisfies EngineMessage);
        return;
      }
      if (engine) {
        const readOnly = [
          "assertReady",
          "connectionDiagnostics",
          "detail",
          "file",
          "waitForRange",
          "cancelRange",
          "cancelRanges",
          "close",
        ].includes(data.method);
        const current = readOnly ? null : snapshot();
        postMessage({
          id: data.id,
          snapshot: current,
          type: "result",
          value,
        } satisfies EngineMessage);
      }
    } catch (error) {
      const log = createLogger({
        component: "torrent-worker",
        context: { torrentId },
        dataDir,
        error: sanitizeLog(error),
        operation: data.method,
      });
      log.setLevel("error");
      log.emit();
      const failure: EngineFailure =
        error instanceof HTTPError && typeof error.status === "number"
          ? {
              code: error.code ?? error.type,
              kind: "http",
              message: error.message,
              status: error.status,
            }
          : {
              kind: "internal",
              message: error instanceof Error ? error.message : "Torrent engine failure",
            };
      postMessage({
        failure,
        id: data.id,
        type: "error",
      } satisfies EngineMessage);
    } finally {
      operations.delete(operation);
      pending.resolve();
    }
  };
  void run();
};
postMessage({ type: "ready" } satisfies EngineMessage);
