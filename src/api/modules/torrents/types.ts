import type { Destination } from "../destinations/model";
import type { Settings } from "../settings/model";

export type TorrentStatus =
  | "metadata"
  | "checking"
  | "moving"
  | "downloading"
  | "seeding"
  | "paused"
  | "idle"
  | "error";

export type FilePriority = "skip" | "normal" | "high";

export interface TrackerStats {
  interval: number | null;
  lastAnnounce: number | null;
  leeches: number | null;
  message: string | null;
  seeds: number | null;
  status: "waiting" | "announcing" | "working" | "error" | "paused";
  url: string;
}

export interface FileStats {
  downloaded: number | null;
  index: number;
  length: number;
  name: string;
  path: string;
  priority: FilePriority;
  progress: number | null;
}

export interface TorrentStorageIssue {
  detectedAt: number;
  kind:
    | "missing-files"
    | "modified-files"
    | "storage-unavailable"
    | "permission-denied"
    | "no-space"
    | "invalid-path"
    | "io-error";
  message: string;
  paths: string[];
}

export interface PeerStats {
  address: string;
  client: string;
  downloaded: number;
  downloadSpeed: number;
  flags: string;
  id: string;
  progress: number | null;
  transport: string;
  uploaded: number;
  uploadSpeed: number;
}

export interface TorrentSummary {
  addedAt: number;
  completedAt: number | null;
  destinationId: string;
  downloaded: number | null;
  downloadSpeed: number;
  error: string | null;
  eta: number | null;
  id: string;
  length: number;
  name: string;
  peers: number;
  progress: number | null;
  ratio: number | null;
  received: number;
  seeds: number;
  status: TorrentStatus;
  storageIssue: TorrentStorageIssue | null;
  swarmPeers: number | null;
  swarmSeeds: number | null;
  uploaded: number;
  uploadSpeed: number;
}

export interface TorrentDetail extends TorrentSummary {
  activeSeconds: number;
  comment: string;
  createdBy: string;
  files: FileStats[];
  lastTransferAt: number | null;
  magnet: string;
  peerList: PeerStats[];
  pieceLength: number;
  pieceMap: number[];
  pieces: number;
  private: boolean;
  savePath: string;
  seedSeconds: number;
  trackers: TrackerStats[];
  verifiedPieces: number | null;
}

export interface SpeedSample {
  download: number;
  time: number;
  upload: number;
}

export interface SessionStats {
  active: number;
  dhtNodes: number;
  downloadSpeed: number;
  engine: string;
  freeSpace: number | null;
  mode: "desktop" | "server";
  peers: number;
  port: number;
  received: number;
  startedAt: number;
  uploaded: number;
  uploadSpeed: number;
}

export interface DashboardState {
  destinations: Destination[];
  detail: TorrentDetail | null;
  history: SpeedSample[];
  session: SessionStats;
  settings: Settings;
  torrents: TorrentSummary[];
}

export interface EngineSnapshot {
  sampledAt: number;
  state: DashboardState;
  stateRevision: number;
  telemetryRevision: number;
}

export interface EngineChange {
  kind: "state" | "telemetry";
  stateRevision: number;
  telemetryRevision: number;
}
