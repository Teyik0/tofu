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
let publishing: Promise<void> | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let requested = false;
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

async function publishChanges() {
  if (!engine || closing) {
    return;
  }
  const adapter = engine.syncAdapter;
  const reservation = await adapter.beginMutation({
    fingerprint: "live",
    key: crypto.randomUUID(),
    principal: "local",
  });
  if (reservation.kind !== "execute") {
    throw new Error("The worker could not reserve its sync publication");
  }
  try {
    const completion = await adapter.executeMutation(reservation.lease, () => ({
      invalidations: [{ kind: "path", path: "/", type: "layout" }],
      response: { body: new Uint8Array(), headers: [], status: 204 },
      value: undefined,
    }));
    const current = snapshot();
    if (current && completion.cursor !== undefined) {
      // Cache this committed snapshot before the server wakes Furin subscribers.
      postMessage({
        cursor: completion.cursor,
        snapshot: current,
        type: "snapshot",
      } satisfies EngineMessage);
    }
  } catch (error) {
    await adapter.abortMutation(reservation.lease);
    throw error;
  }
}

function requestPublish() {
  if (closing) {
    return;
  }
  requested = true;
  if (publishing || retry) {
    return;
  }
  requested = false;
  publishing = publishChanges()
    .catch((error: unknown) => {
      recordLog({
        component: "torrent-worker",
        dataDir,
        error,
        level: "error",
        operation: "publish",
      });
      if (!closing) {
        requested = true;
        retry = setTimeout(() => {
          retry = null;
          requestPublish();
        }, 1000);
        retry.unref();
      }
    })
    .finally(() => {
      publishing = null;
      if (requested && !retry) {
        requestPublish();
      }
    });
}

async function execute(request: EngineRequest) {
  if (request.method === "open") {
    ({ dataDir } = request.args[0]);
    engine = await TorrentEngine.open(request.args[0]);
    unsubscribe = engine.subscribeChanges(requestPublish);
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
      if (retry) {
        clearTimeout(retry);
      }
      unsubscribe?.();
      await Promise.allSettled([...operations]);
      await publishing;
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
