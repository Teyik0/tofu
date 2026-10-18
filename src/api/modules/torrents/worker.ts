import { HTTPError } from "elysia";
import type { EngineFailure, EngineMessage, EngineRequest, EngineSnapshot } from "../../../types";
import { logEvents, recordLog } from "../../lib/diagnostics";
import { TorrentEngine } from "./service";

declare let self: Worker;

logEvents.addEventListener("log", (event) => {
  const { line } = (event as CustomEvent<{ line: string }>).detail;
  postMessage({ line, type: "log" } satisfies EngineMessage);
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
    engine = await TorrentEngine.open(request.args[0]);
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
          recordLog({
            component: "torrent-worker",
            dataDir,
            error,
            level: "error",
            operation: "publish",
          });
        }
      });
    });
    return;
  }
  if (!engine || closing) {
    throw new (HTTPError.id("SERVICE_UNAVAILABLE", 503))("The torrent engine is unavailable");
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
  const operation = execute(data).then(
    (value) => {
      if (engine) {
        const readOnly = [
          "assertReady",
          "connectionDiagnostics",
          "detail",
          "file",
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
    },
    (error: unknown) => {
      recordLog({
        component: "torrent-worker",
        context: {
          torrentId:
            typeof data.args[0] === "string" && torrentIdPattern.test(data.args[0])
              ? data.args[0]
              : undefined,
        },
        dataDir,
        error,
        level: "error",
        operation: data.method,
      });
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
    }
  );
  operations.add(operation);
  void operation.finally(() => operations.delete(operation));
};
postMessage({ type: "ready" } satisfies EngineMessage);
