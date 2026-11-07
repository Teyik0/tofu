import type { InferOutput } from "valibot";
import {
  array,
  boolean,
  check,
  integer,
  maxLength,
  minLength,
  minValue,
  nullable,
  number,
  object,
  optional,
  picklist,
  pipe,
  string,
} from "valibot";

const httpOrigin = /^https?:\/\/[^\s/]+(?:\/[^\s]*)?$/;
const absolutePath = /^\//;

export const transmissionServerSchema = object({
  enabled: optional(boolean()),
  name: pipe(string(), minLength(1), maxLength(80)),
  origin: pipe(
    string(),
    minLength(1),
    maxLength(2048),
    check((value) => httpOrigin.test(value), "Use an http or https origin")
  ),
  password: optional(nullable(pipe(string(), maxLength(512)))),
  rpcPath: pipe(
    string(),
    minLength(1),
    maxLength(1024),
    check((value) => absolutePath.test(value), "The RPC path must start with /")
  ),
  username: optional(nullable(pipe(string(), maxLength(512)))),
});

export const transmissionTorrentIdsSchema = object({
  ids: pipe(array(pipe(number(), integer(), minValue(0))), minLength(1), maxLength(500)),
});

export const transmissionActionSchema = object({
  action: picklist(["start", "stop", "start-now", "verify", "reannounce"]),
  ids: pipe(array(pipe(number(), integer(), minValue(0))), minLength(1), maxLength(500)),
});

export const transmissionRemoveSchema = object({
  deleteLocalData: optional(boolean()),
  ids: pipe(array(pipe(number(), integer(), minValue(0))), minLength(1), maxLength(500)),
});

export const transmissionAddSchema = object({
  downloadDir: optional(pipe(string(), maxLength(4096))),
  paused: optional(boolean()),
  source: pipe(string(), minLength(1), maxLength(16_384)),
});

export const transmissionLimitsSchema = object({
  altSpeedEnabled: optional(boolean()),
  downloadLimit: optional(pipe(number(), integer(), minValue(0))),
  downloadLimited: optional(boolean()),
  idleSeedingLimit: optional(pipe(number(), integer(), minValue(0))),
  idleSeedingLimitEnabled: optional(boolean()),
  peerLimitGlobal: optional(pipe(number(), integer(), minValue(1))),
  peerLimitPerTorrent: optional(pipe(number(), integer(), minValue(1))),
  seedRatioLimit: optional(pipe(number(), minValue(0))),
  seedRatioLimited: optional(boolean()),
  uploadLimit: optional(pipe(number(), integer(), minValue(0))),
  uploadLimited: optional(boolean()),
});

/** Indices that must be downloaded; every other file of the torrent becomes unwanted. */
export const transmissionFilesSchema = object({
  wanted: pipe(array(pipe(number(), integer(), minValue(0))), maxLength(100_000)),
});

export type TransmissionServerInput = InferOutput<typeof transmissionServerSchema>;
export type TransmissionLimitsInput = InferOutput<typeof transmissionLimitsSchema>;
export type TransmissionFilesInput = InferOutput<typeof transmissionFilesSchema>;
export type TransmissionActionInput = InferOutput<typeof transmissionActionSchema>;
export type TransmissionAddInput = InferOutput<typeof transmissionAddSchema>;
export type TransmissionRemoveInput = InferOutput<typeof transmissionRemoveSchema>;

export type TransmissionTorrentState =
  | "stopped"
  | "check-wait"
  | "checking"
  | "download-wait"
  | "downloading"
  | "seed-wait"
  | "seeding"
  | "isolated";

export interface TransmissionServer {
  enabled: boolean;
  hasPassword: boolean;
  id: string;
  name: string;
  origin: string;
  rpcPath: string;
  username: string | null;
}

export interface TransmissionTorrent {
  addedDate: number;
  bandwidthPriority: number;
  doneDate: number | null;
  downloadDir: string;
  downloadedEver: number;
  error: number;
  errorString: string;
  eta: number | null;
  id: number;
  infoHash: string;
  isFinished: boolean;
  leftUntilDone: number;
  name: string;
  peersConnected: number;
  peersGettingFromUs: number;
  peersSendingToUs: number;
  progress: number;
  queuePosition: number;
  rateDownload: number;
  rateUpload: number;
  ratio: number | null;
  sizeWhenDone: number;
  state: TransmissionTorrentState;
  status: number;
  totalSize: number;
  uploadedEver: number;
}

export interface TransmissionSession {
  activeTorrentCount: number;
  altSpeedEnabled: boolean;
  downloadDir: string;
  downloadLimit: number;
  downloadLimited: boolean;
  downloadSpeed: number;
  idleSeedingLimit: number;
  idleSeedingLimitEnabled: boolean;
  pausedTorrentCount: number;
  peerLimitGlobal: number;
  peerLimitPerTorrent: number;
  rpcVersion: number;
  seedRatioLimit: number;
  seedRatioLimited: boolean;
  torrentCount: number;
  uploadLimit: number;
  uploadLimited: boolean;
  uploadSpeed: number;
  version: string;
}

export interface TransmissionState {
  fetchedAt: number;
  server: TransmissionServer;
  session: TransmissionSession;
  torrents: TransmissionTorrent[];
}

export interface TransmissionFile {
  downloaded: number;
  index: number;
  length: number;
  name: string;
  priority: number;
  wanted: boolean;
}

export interface TransmissionTracker {
  announce: string;
  id: number;
  lastAnnounceResult: string | null;
  lastAnnounceSucceeded: boolean | null;
  leecherCount: number | null;
  seederCount: number | null;
  tier: number;
}

export interface TransmissionPeer {
  address: string;
  clientName: string;
  isDownloadingFrom: boolean;
  isEncrypted: boolean;
  isIncoming: boolean;
  isUploadingTo: boolean;
  peerIsChoked: boolean;
  peerIsInterested: boolean;
  progress: number;
  rateToClient: number;
  rateToPeer: number;
}

export interface TransmissionTorrentDetail extends TransmissionTorrent {
  comment: string;
  creator: string;
  dateCreated: number;
  downloadLimit: number;
  downloadLimited: boolean;
  files: TransmissionFile[];
  honorsSessionLimits: boolean;
  isPrivate: boolean;
  magnetLink: string;
  peers: TransmissionPeer[];
  pieceCount: number;
  pieceSize: number;
  secondsDownloading: number;
  secondsSeeding: number;
  seedIdleLimit: number;
  seedIdleMode: number;
  seedRatioLimit: number;
  seedRatioMode: number;
  trackers: TransmissionTracker[];
  uploadLimit: number;
  uploadLimited: boolean;
}
