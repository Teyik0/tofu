// biome-ignore-all lint/suspicious/noUnnecessaryConditions: Biome does not resolve the mapped command union; TypeScript checks each argument tuple.
import type { EngineMessage, EngineRequest } from "../../../types";
import { UserError } from "../../lib/errors";
import { TorrentEngine } from "./service";

const worker = globalThis as unknown as {
  postMessage: (message: EngineMessage) => void;
  onmessage: ((event: MessageEvent<EngineRequest>) => void) | null;
};
let engine: TorrentEngine | null = null;
let timer: ReturnType<typeof setInterval> | undefined;
let closing = false;
const operations = new Set<Promise<void>>();

async function execute(request: EngineRequest) {
  if (request.method === "open") {
    engine = await TorrentEngine.open(request.args[0]);
    timer = setInterval(() => {
      if (engine && !closing) {
        worker.postMessage({ state: engine.snapshot(null, false), type: "snapshot" });
      }
    }, 1000);
    return;
  }
  if (!engine || closing) {
    throw new UserError("The torrent engine is unavailable", { status: 503 });
  }
  switch (request.method) {
    case "assertReady":
      return engine.assertReady();
    case "add":
      return engine.add(...request.args);
    case "addPeer":
      return engine.addPeer(...request.args);
    case "detail":
      return engine.detail(...request.args);
    case "file":
      return engine.file(...request.args);
    case "pause":
      return engine.pause(...request.args);
    case "priority":
      return engine.priority(...request.args);
    case "reannounce":
      return engine.reannounce(...request.args);
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
      clearInterval(timer);
      await Promise.allSettled([...operations]);
      return engine.close();
    }
    default:
      throw new Error("Unsupported torrent command", { cause: request satisfies never });
  }
}

// Commands must wait until imports have loaded and the listener is installed.
worker.onmessage = ({ data }) => {
  const operation = execute(data).then(
    (value) => {
      if (engine) {
        worker.postMessage({
          id: data.id,
          state: engine.snapshot(null, false),
          type: "result",
          value,
        });
      }
    },
    (error: unknown) =>
      worker.postMessage({
        id: data.id,
        message: error instanceof Error ? error.message : "Torrent engine failure",
        status: error instanceof UserError ? error.status : 500,
        type: "error",
      })
  );
  operations.add(operation);
  void operation.finally(() => operations.delete(operation));
};
worker.postMessage({ type: "ready" });
