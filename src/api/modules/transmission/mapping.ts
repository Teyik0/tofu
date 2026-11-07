import type {
  TransmissionFile,
  TransmissionPeer,
  TransmissionSession,
  TransmissionTorrent,
  TransmissionTorrentDetail,
  TransmissionTorrentState,
  TransmissionTracker,
} from "./model";

/** Fields requested for every list read; every one is supported by Transmission 2.83 (RPC 15). */
export const TORRENT_FIELDS = [
  "id",
  "hashString",
  "name",
  "status",
  "percentDone",
  "rateDownload",
  "rateUpload",
  "totalSize",
  "sizeWhenDone",
  "leftUntilDone",
  "eta",
  "peersConnected",
  "peersSendingToUs",
  "peersGettingFromUs",
  "uploadedEver",
  "downloadedEver",
  "uploadRatio",
  "downloadDir",
  "addedDate",
  "doneDate",
  "activityDate",
  "error",
  "errorString",
  "queuePosition",
  "isFinished",
  "bandwidthPriority",
] as const;

/** List fields plus the metadata only the detail panel needs. */
export const TORRENT_DETAIL_FIELDS = [
  ...TORRENT_FIELDS,
  "comment",
  "creator",
  "dateCreated",
  "isPrivate",
  "magnetLink",
  "pieceCount",
  "pieceSize",
  "files",
  "fileStats",
  "trackers",
  "trackerStats",
  "peers",
  "wanted",
  "priorities",
  "secondsDownloading",
  "secondsSeeding",
  "seedRatioMode",
  "seedRatioLimit",
  "seedIdleMode",
  "seedIdleLimit",
  "honorsSessionLimits",
  "downloadLimited",
  "downloadLimit",
  "uploadLimited",
  "uploadLimit",
] as const;

const states: { [Status in TransmissionTorrent["status"]]?: TransmissionTorrentState } = {
  0: "stopped",
  1: "check-wait",
  2: "checking",
  3: "download-wait",
  4: "downloading",
  5: "seed-wait",
  6: "seeding",
  7: "isolated",
};

interface RawFile {
  bytesCompleted?: number;
  length?: number;
  name?: string;
}

interface RawFileStats {
  priority?: number;
  wanted?: boolean;
}

interface RawPeer {
  address?: string;
  clientName?: string;
  isDownloadingFrom?: boolean;
  isEncrypted?: boolean;
  isIncoming?: boolean;
  isUploadingTo?: boolean;
  peerIsChoked?: boolean;
  peerIsInterested?: boolean;
  progress?: number;
  rateToClient?: number;
  rateToPeer?: number;
}

interface RawTrackerStat {
  announce?: string;
  id?: number;
  lastAnnounceResult?: string;
  lastAnnounceSucceeded?: boolean;
  leecherCount?: number;
  seederCount?: number;
  tier?: number;
}

export interface RawTorrent {
  activityDate?: number;
  addedDate?: number;
  bandwidthPriority?: number;
  comment?: string;
  creator?: string;
  dateCreated?: number;
  doneDate?: number;
  downloadDir?: string;
  downloadedEver?: number;
  downloadLimit?: number;
  downloadLimited?: boolean;
  error?: number;
  errorString?: string;
  eta?: number;
  fileStats?: RawFileStats[];
  files?: RawFile[];
  hashString?: string;
  honorsSessionLimits?: boolean;
  id?: number;
  isFinished?: boolean;
  isPrivate?: boolean;
  leftUntilDone?: number;
  magnetLink?: string;
  name?: string;
  peers?: RawPeer[];
  peersConnected?: number;
  peersGettingFromUs?: number;
  peersSendingToUs?: number;
  percentDone?: number;
  pieceCount?: number;
  pieceSize?: number;
  priorities?: number[];
  queuePosition?: number;
  rateDownload?: number;
  rateUpload?: number;
  secondsDownloading?: number;
  secondsSeeding?: number;
  seedIdleLimit?: number;
  seedIdleMode?: number;
  seedRatioLimit?: number;
  seedRatioMode?: number;
  sizeWhenDone?: number;
  status?: number;
  totalSize?: number;
  trackerStats?: RawTrackerStat[];
  trackers?: RawTrackerStat[];
  uploadedEver?: number;
  uploadLimit?: number;
  uploadLimited?: boolean;
  uploadRatio?: number;
  wanted?: number[];
}

export interface RawSession {
  "alt-speed-enabled"?: boolean;
  "download-dir"?: string;
  "idle-seeding-limit"?: number;
  "idle-seeding-limit-enabled"?: boolean;
  "peer-limit-global"?: number;
  "peer-limit-per-torrent"?: number;
  "rpc-version"?: number;
  seedRatioLimit?: number;
  seedRatioLimited?: boolean;
  "speed-limit-down"?: number;
  "speed-limit-down-enabled"?: boolean;
  "speed-limit-up"?: number;
  "speed-limit-up-enabled"?: boolean;
  version?: string;
}

export interface RawStats {
  activeTorrentCount?: number;
  downloadSpeed?: number;
  pausedTorrentCount?: number;
  torrentCount?: number;
  uploadSpeed?: number;
}

export function mapSession(raw: RawSession, stats: RawStats): TransmissionSession {
  return {
    activeTorrentCount: stats.activeTorrentCount ?? 0,
    altSpeedEnabled: raw["alt-speed-enabled"] ?? false,
    downloadDir: raw["download-dir"] ?? "",
    downloadLimit: raw["speed-limit-down"] ?? 0,
    downloadLimited: raw["speed-limit-down-enabled"] ?? false,
    downloadSpeed: stats.downloadSpeed ?? 0,
    idleSeedingLimit: raw["idle-seeding-limit"] ?? 0,
    idleSeedingLimitEnabled: raw["idle-seeding-limit-enabled"] ?? false,
    pausedTorrentCount: stats.pausedTorrentCount ?? 0,
    peerLimitGlobal: raw["peer-limit-global"] ?? 0,
    peerLimitPerTorrent: raw["peer-limit-per-torrent"] ?? 0,
    rpcVersion: raw["rpc-version"] ?? 0,
    seedRatioLimit: raw.seedRatioLimit ?? 0,
    seedRatioLimited: raw.seedRatioLimited ?? false,
    torrentCount: stats.torrentCount ?? 0,
    uploadLimit: raw["speed-limit-up"] ?? 0,
    uploadLimited: raw["speed-limit-up-enabled"] ?? false,
    uploadSpeed: stats.uploadSpeed ?? 0,
    version: raw.version ?? "Transmission",
  };
}

export function mapTorrent(raw: RawTorrent): TransmissionTorrent {
  const status = zero(raw.status);
  return {
    addedDate: zero(raw.addedDate),
    bandwidthPriority: zero(raw.bandwidthPriority),
    doneDate: raw.doneDate || null,
    downloadDir: blank(raw.downloadDir),
    downloadedEver: zero(raw.downloadedEver),
    error: zero(raw.error),
    errorString: blank(raw.errorString),
    eta: positive(raw.eta),
    id: zero(raw.id),
    infoHash: blank(raw.hashString),
    isFinished: raw.isFinished === true,
    leftUntilDone: zero(raw.leftUntilDone),
    name: blank(raw.name),
    peersConnected: zero(raw.peersConnected),
    peersGettingFromUs: zero(raw.peersGettingFromUs),
    peersSendingToUs: zero(raw.peersSendingToUs),
    progress: zero(raw.percentDone),
    queuePosition: zero(raw.queuePosition),
    rateDownload: zero(raw.rateDownload),
    rateUpload: zero(raw.rateUpload),
    ratio: positive(raw.uploadRatio),
    sizeWhenDone: zero(raw.sizeWhenDone),
    state: states[status] ?? "isolated",
    status,
    totalSize: zero(raw.totalSize),
    uploadedEver: zero(raw.uploadedEver),
  };
}

function mapFiles(raw: RawTorrent): TransmissionFile[] {
  const stats = raw.fileStats ?? [];
  return (raw.files ?? []).map((file, index) => {
    const stat = stats[index];
    return {
      downloaded: file.bytesCompleted ?? 0,
      index,
      length: file.length ?? 0,
      name: file.name ?? "",
      priority: stat?.priority ?? 0,
      wanted: stat?.wanted ?? true,
    };
  });
}

function mapTrackers(raw: RawTorrent): TransmissionTracker[] {
  const stats = raw.trackerStats ?? [];
  const source = stats.length > 0 ? stats : (raw.trackers ?? []);
  return source.map((tracker, index) => ({
    announce: tracker.announce ?? "",
    id: tracker.id ?? index,
    lastAnnounceResult: tracker.lastAnnounceResult ?? null,
    lastAnnounceSucceeded: tracker.lastAnnounceSucceeded ?? null,
    leecherCount: positive(tracker.leecherCount),
    seederCount: positive(tracker.seederCount),
    tier: tracker.tier ?? 0,
  }));
}

function zero(value: number | undefined) {
  return value ?? 0;
}

function blank(value: string | undefined) {
  return value ?? "";
}

/** Transmission uses negative sentinels for "not available"; the API reports null instead. */
function positive(value: number | undefined) {
  return value === undefined || value < 0 ? null : value;
}

function mapPeers(raw: RawTorrent): TransmissionPeer[] {
  return (raw.peers ?? []).map((peer) => ({
    address: peer.address ?? "",
    clientName: peer.clientName ?? "",
    isDownloadingFrom: peer.isDownloadingFrom ?? false,
    isEncrypted: peer.isEncrypted ?? false,
    isIncoming: peer.isIncoming ?? false,
    isUploadingTo: peer.isUploadingTo ?? false,
    peerIsChoked: peer.peerIsChoked ?? false,
    peerIsInterested: peer.peerIsInterested ?? false,
    progress: peer.progress ?? 0,
    rateToClient: peer.rateToClient ?? 0,
    rateToPeer: peer.rateToPeer ?? 0,
  }));
}

export function mapTorrentDetail(raw: RawTorrent): TransmissionTorrentDetail {
  return {
    ...mapTorrent(raw),
    comment: blank(raw.comment),
    creator: blank(raw.creator),
    dateCreated: zero(raw.dateCreated),
    downloadLimit: zero(raw.downloadLimit),
    downloadLimited: raw.downloadLimited === true,
    files: mapFiles(raw),
    honorsSessionLimits: raw.honorsSessionLimits !== false,
    isPrivate: raw.isPrivate === true,
    magnetLink: blank(raw.magnetLink),
    peers: mapPeers(raw),
    pieceCount: zero(raw.pieceCount),
    pieceSize: zero(raw.pieceSize),
    secondsDownloading: zero(raw.secondsDownloading),
    secondsSeeding: zero(raw.secondsSeeding),
    seedIdleLimit: zero(raw.seedIdleLimit),
    seedIdleMode: zero(raw.seedIdleMode),
    seedRatioLimit: zero(raw.seedRatioLimit),
    seedRatioMode: zero(raw.seedRatioMode),
    trackers: mapTrackers(raw),
    uploadLimit: zero(raw.uploadLimit),
    uploadLimited: raw.uploadLimited === true,
  };
}

export const stateLabels: { [State in TransmissionTorrentState]: string } = {
  "check-wait": "Waiting to verify",
  checking: "Verifying",
  "download-wait": "Queued",
  downloading: "Downloading",
  isolated: "Isolated",
  "seed-wait": "Queued to seed",
  seeding: "Seeding",
  stopped: "Paused",
};
