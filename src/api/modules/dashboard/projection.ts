import type { DashboardState, TorrentDetail, TorrentSummary } from "../torrents/types";

// Absolute POSIX or Windows paths embedded in engine messages.
const HOST_PATH = /(?:[A-Za-z]:\\|\\\\|\/)(?:[^\s'"`:]+[\\/])*[^\s'"`:]*/g;

/** Removes host paths from free-form engine messages shown to every viewer. */
export function redactPaths(message: string | null) {
  return message === null ? null : message.replaceAll(HOST_PATH, "…");
}

/** Explicit allowlist projection of a torrent summary; new engine fields stay private. */
export function libraryTorrent(torrent: TorrentSummary) {
  return {
    addedAt: torrent.addedAt,
    completedAt: torrent.completedAt,
    destinationId: torrent.destinationId,
    downloaded: torrent.downloaded,
    downloadSpeed: torrent.downloadSpeed,
    error: redactPaths(torrent.error),
    eta: torrent.eta,
    id: torrent.id,
    length: torrent.length,
    name: torrent.name,
    peers: torrent.peers,
    progress: torrent.progress,
    ratio: torrent.ratio,
    received: torrent.received,
    seeds: torrent.seeds,
    status: torrent.status,
    storageIssue: torrent.storageIssue
      ? { detectedAt: torrent.storageIssue.detectedAt, kind: torrent.storageIssue.kind }
      : null,
    swarmPeers: torrent.swarmPeers,
    swarmSeeds: torrent.swarmSeeds,
    uploaded: torrent.uploaded,
    uploadSpeed: torrent.uploadSpeed,
  };
}

export function libraryDetail(detail: TorrentDetail) {
  return {
    ...libraryTorrent(detail),
    activeSeconds: detail.activeSeconds,
    comment: detail.comment,
    createdBy: detail.createdBy,
    files: detail.files.map((file) => ({
      downloaded: file.downloaded,
      index: file.index,
      length: file.length,
      name: file.name,
      priority: file.priority,
      progress: file.progress,
    })),
    lastTransferAt: detail.lastTransferAt,
    pieceLength: detail.pieceLength,
    pieceMap: detail.pieceMap,
    pieces: detail.pieces,
    private: detail.private,
    seedSeconds: detail.seedSeconds,
    verifiedPieces: detail.verifiedPieces,
  };
}

export function hostDetail(detail: TorrentDetail) {
  return {
    files: detail.files.map((file) => ({ index: file.index, path: file.path })),
    id: detail.id,
    magnet: detail.magnet,
    peerList: detail.peerList,
    savePath: detail.savePath,
    storageIssue: detail.storageIssue,
    trackers: detail.trackers,
  };
}

export function libraryState(
  state: DashboardState,
  detail: TorrentDetail | null,
  server: { id: string; name: string }
) {
  return {
    appearance: { theme: state.settings.theme },
    destinations: state.destinations.map((destination) => ({
      icon: destination.icon,
      id: destination.id,
      name: destination.name,
      pinned: destination.pinned,
    })),
    detail: detail ? libraryDetail(detail) : null,
    history: state.history,
    server,
    session: {
      active: state.session.active,
      downloadSpeed: state.session.downloadSpeed,
      freeSpace: state.session.freeSpace,
      peers: state.session.peers,
      received: state.session.received,
      startedAt: state.session.startedAt,
      uploaded: state.session.uploaded,
      uploadSpeed: state.session.uploadSpeed,
    },
    torrents: state.torrents.map(libraryTorrent),
  };
}

export function hostState(state: DashboardState) {
  return { destinations: state.destinations, session: state.session, settings: state.settings };
}

export type LibraryTorrent = ReturnType<typeof libraryTorrent>;

export type LibraryTorrentDetail = ReturnType<typeof libraryDetail>;

export type LibraryState = ReturnType<typeof libraryState>;

export type HostState = ReturnType<typeof hostState>;

export type TorrentHostDetail = ReturnType<typeof hostDetail>;

/** Live workspace state: the shared library plus host details the caller may see. */
export interface LiveState extends LibraryState {
  detailHost: TorrentHostDetail | null;
  host: HostState | null;
}
