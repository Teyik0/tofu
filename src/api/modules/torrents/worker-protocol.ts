import type { DrainContext } from "evlog";
import type { EngineOpenOptions, TorrentEngine } from "./service";
import type { EngineSnapshot } from "./types";

export type EngineOperations = Pick<
  TorrentEngine,
  | "add"
  | "addPeer"
  | "assertReady"
  | "waitForRange"
  | "cancelRange"
  | "cancelRanges"
  | "close"
  | "connectionDiagnostics"
  | "detail"
  | "file"
  | "locate"
  | "pause"
  | "priority"
  | "reannounce"
  | "refreshSnapshot"
  | "remove"
  | "removeDestination"
  | "repair"
  | "replaceTrackers"
  | "resume"
  | "saveDestination"
  | "setObserved"
  | "updateDestinationPresentation"
  | "updateSettings"
  | "verify"
>;

export type EngineRequest =
  | {
      [Method in keyof EngineOperations]: {
        id: number;
        method: Method;
        args: Parameters<EngineOperations[Method]>;
      };
    }[keyof EngineOperations]
  | { id: number; method: "open"; args: [EngineOpenOptions] };

export type EngineFailure =
  | { kind: "http"; code: string; message: string; status: number }
  | { kind: "internal"; message: string };

type EngineReturnedStatus = Extract<
  Awaited<ReturnType<EngineOperations[keyof EngineOperations]>>,
  { status: number; response: unknown }
>;

export type EngineMessage =
  | { type: "log"; context: DrainContext }
  | { type: "ready" }
  | { type: "snapshot"; snapshot: EngineSnapshot }
  | { type: "result"; id: number; value: unknown; snapshot: EngineSnapshot | null }
  | { type: "error"; id: number; failure: EngineFailure }
  | {
      type: "failure";
      id: number;
      status: EngineReturnedStatus["status"];
      body: EngineReturnedStatus["response"];
      headers: EngineReturnedStatus["headers"];
    };
