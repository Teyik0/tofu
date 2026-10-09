import type { EventEmitter } from "node:events";
import type { Torrent } from "webtorrent";
import type { PeerStats, TrackerStats } from "../types";

// WebTorrent 3.0.21 exposes its tracker client on discovery; keep this bridge in one file.
interface TrackerClient extends EventEmitter {
  update: () => void;
}
export interface RuntimeTorrent extends Torrent {
  destroyed?: boolean;
  discovery?: { tracker: TrackerClient | null };
  private?: boolean;
}
interface TrackerResponse {
  announce: string;
  complete?: number;
  incomplete?: number;
  interval?: number;
}
interface RuntimeWire {
  amChoking: boolean;
  amInterested: boolean;
  downloaded: number;
  downloadSpeed: () => number;
  isSeeder?: boolean;
  peerChoking: boolean;
  peerExtendedHandshake?: { v?: string | Uint8Array };
  peerId: string;
  peerIdBuffer?: Uint8Array;
  peerInterested: boolean;
  peerPieces?: { buffer: Uint8Array };
  remoteAddress?: string;
  remotePort?: string | number;
  type: string;
  uploaded: number;
  uploadSpeed: () => number;
}

export function watchTrackers(torrent: Torrent, rows: TrackerStats[]) {
  if (rows.length === 0) {
    return () => undefined;
  }
  let client: TrackerClient | null = null;
  const update = (response: TrackerResponse) => {
    const row = rows.find((item) => item.url === response.announce);
    if (!row) {
      return;
    }
    row.status = "working";
    row.seeds = response.complete ?? null;
    row.leeches = response.incomplete ?? null;
    row.lastAnnounce = Date.now();
    row.interval = response.interval ?? null;
    row.message = null;
  };
  const warning = (error: Error) => {
    const row =
      rows.find((item) => error.message.includes(item.url)) ??
      (rows.length === 1 ? rows[0] : undefined);
    if (row) {
      row.status = "error";
      row.message = error.message;
    }
  };
  const attach = () => {
    const found = (torrent as RuntimeTorrent).discovery?.tracker;
    if (!found || client) {
      return;
    }
    client = found;
    clearInterval(timer);
    found.on("update", update);
    found.on("warning", warning);
    found.on("error", warning);
    found.update();
  };
  for (const row of rows) {
    row.status = "announcing";
  }
  const timer = setInterval(attach, 20);
  timer.unref();
  torrent.once("ready", attach);
  return () => {
    clearInterval(timer);
    torrent.removeListener("ready", attach);
    client?.removeListener("update", update);
    client?.removeListener("warning", warning);
    client?.removeListener("error", warning);
  };
}

export function announce(torrent: Torrent) {
  const client = (torrent as RuntimeTorrent).discovery?.tracker;
  if (!client) {
    return false;
  }
  client.update();
  return true;
}

function bits(value: number) {
  // biome-ignore lint/suspicious/noBitwiseOperators: BitTorrent uses packed bitfields.
  let count = value - ((value >>> 1) & 0x55);
  // biome-ignore lint/suspicious/noBitwiseOperators: Count bits in each byte.
  count = (count & 0x33) + ((count >>> 2) & 0x33);
  // biome-ignore lint/suspicious/noBitwiseOperators: Combine the two nibbles.
  return (count + (count >>> 4)) & 0x0f;
}

function peerClient(wire: RuntimeWire) {
  const version = wire.peerExtendedHandshake?.v;
  if (typeof version === "string") {
    return version;
  }
  if (version) {
    return new TextDecoder().decode(version);
  }
  if (wire.peerIdBuffer) {
    return new TextDecoder().decode(wire.peerIdBuffer.slice(0, 8));
  }
  return "Unknown";
}
function peerProgress(wire: RuntimeWire, pieces: number) {
  if (wire.isSeeder) {
    return 1;
  }
  const available = wire.peerPieces?.buffer.reduce((sum, byte) => sum + bits(byte), 0);
  if (available === undefined || pieces === 0) {
    return null;
  }
  return Math.min(1, available / pieces);
}

export function peers(torrent: Torrent): PeerStats[] {
  return (torrent.wires as unknown as RuntimeWire[]).map((wire, index) => ({
    address: wire.remoteAddress ? `${wire.remoteAddress}:${wire.remotePort ?? ""}` : "WebRTC",
    client: peerClient(wire),
    downloaded: wire.downloaded,
    downloadSpeed: wire.downloadSpeed(),
    flags: `${wire.amInterested ? "I" : ""}${wire.peerInterested ? "i" : ""}${wire.amChoking ? "C" : ""}${wire.peerChoking ? "c" : ""}`,
    id: `${wire.peerId || "peer"}-${index}`,
    progress: peerProgress(wire, torrent.pieces.length),
    transport: wire.type,
    uploaded: wire.uploaded,
    uploadSpeed: wire.uploadSpeed(),
  }));
}
