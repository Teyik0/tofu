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
  | "updateDestinationPresentation"
  | "updateSettings"
  | "verify"
> & {
  open: (options: EngineOpenOptions) => Promise<void>;
  close: () => Promise<void>;
};

export interface EngineEvents {
  snapshot: EngineSnapshot;
}
