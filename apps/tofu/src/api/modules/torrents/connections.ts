import type { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import type WebTorrent from "webtorrent";
import type { Torrent } from "webtorrent";
import type { SeedingConnectionMode } from "../../../../../../package/plugins/src/settings-model";
import type { CryptoDiagnostics } from "./crypto-diagnostics";

export const defaultConnectionPolicy: ConnectionPolicy = {
  attemptsPerSecond: 3,
  burst: 2,
  cooldownTtlMs: 30 * 60_000,
  maxConnections: 80,
  maxConnectionsPerTorrent: 40,
  maxCooldownEntries: 10_000,
  maxPending: 8,
  retryDelaysMs: [5000, 15_000, 45_000, 120_000, 300_000],
  seedAttemptsPerSecond: 0.5,
  seedBurst: 1,
  seedIntervalMs: 10_000,
  stableConnectionMs: 30_000,
};

interface RuntimePeer extends EventEmitter {
  _handshakeDone?: boolean;
  addr: string;
  conn: Socket | null;
  connected: boolean;
  destroyed: boolean;
  source: string | null;
  type: string;
  wire: Torrent["wires"][number] | null;
}

// WebTorrent 3.0.21 has no public hook before outgoing transport creation.
interface RuntimeTorrent extends Torrent {
  _drain: () => void;
  _numConns: number;
  _numPending: number;
  _peers: Map<string, RuntimePeer>;
  _queue: RuntimePeer[];
  destroyed: boolean;
}

interface RuntimeWire extends EventEmitter {
  type: string;
}

interface Endpoint {
  eligibleAt: number;
  failures: number;
  touchedAt: number;
}

interface TorrentState {
  cleanups: Set<() => void>;
  drain: () => void;
  handshakes: Map<RuntimePeer, number>;
  lastSeedAttempt: number;
  onClose: () => void;
  onWire: (wire: Torrent["wires"][number]) => void;
  torrent: RuntimeTorrent;
}

export class ConnectionScheduler {
  private readonly policy: ConnectionPolicy;
  private seedingMode: SeedingConnectionMode;
  private readonly states = new Map<Torrent, TorrentState>();
  private readonly endpoints = new Map<string, Endpoint>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private tokens: number;
  private seedTokens: number;
  private refreshedAt = performance.now();
  private cursor = 0;
  private closed = false;
  private outgoingAttempts = 0;
  private outgoingRetries = 0;
  private outgoingHandshakes = 0;
  private incomingHandshakes = 0;
  private deferredByRate = 0;
  private deferredByCooldown = 0;
  private deferredByCapacity = 0;

  constructor(client: WebTorrent, policy: ConnectionPolicy, seedingMode: SeedingConnectionMode) {
    if (webTorrentVersion(client) !== "3.0.21") {
      throw new Error("The connection scheduler requires WebTorrent 3.0.21");
    }
    const positive = [
      policy.attemptsPerSecond,
      policy.seedAttemptsPerSecond,
      policy.burst,
      policy.seedBurst,
      policy.maxPending,
      policy.maxConnections,
      policy.maxConnectionsPerTorrent,
      policy.cooldownTtlMs,
      policy.maxCooldownEntries,
    ];
    if (
      !(
        positive.every((value) => Number.isFinite(value) && value > 0) &&
        policy.burst >= 1 &&
        policy.seedBurst >= 1 &&
        policy.maxPending >= 1 &&
        policy.maxConnections >= 1 &&
        policy.maxConnectionsPerTorrent >= 1 &&
        policy.maxCooldownEntries >= 1 &&
        Number.isFinite(policy.seedIntervalMs) &&
        policy.seedIntervalMs >= 0 &&
        Number.isFinite(policy.stableConnectionMs) &&
        policy.stableConnectionMs >= 0 &&
        policy.retryDelaysMs.length > 0 &&
        policy.retryDelaysMs.every((value) => Number.isFinite(value) && value >= 0)
      )
    ) {
      throw new Error("Invalid torrent connection policy");
    }
    this.tokens = policy.burst;
    this.seedTokens = policy.seedBurst;
    this.policy = policy;
    this.seedingMode = seedingMode;
    client.maxConns = policy.maxConnectionsPerTorrent;
  }

  attach(torrent: Torrent) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Public close calls change the lifecycle state.
    if (this.closed || this.states.has(torrent)) {
      return;
    }
    const runtime = torrent as RuntimeTorrent;
    if (
      !(
        typeof runtime._drain === "function" &&
        Array.isArray(runtime._queue) &&
        runtime._peers instanceof Map
      )
    ) {
      throw new Error("Unsupported WebTorrent connection scheduler integration");
    }
    const state: TorrentState = {
      cleanups: new Set(),
      drain: runtime._drain.bind(runtime),
      handshakes: new Map(),
      lastSeedAttempt: Number.NEGATIVE_INFINITY,
      onClose: () => this.detach(torrent),
      onWire: (wire) => {
        const { type } = wire as RuntimeWire;
        if (type.includes("Incoming")) {
          this.incomingHandshakes += 1;
        } else if (type.includes("Outgoing")) {
          this.outgoingHandshakes += 1;
          for (const peer of runtime._peers.values()) {
            if (peer.wire === wire) {
              state.handshakes.set(peer, performance.now());
              break;
            }
          }
        }
        const cleanup = () => wire.removeListener("close", wake);
        const wake = () => {
          state.cleanups.delete(cleanup);
          this.wake();
        };
        wire.once("close", wake);
        state.cleanups.add(cleanup);
        this.wake();
      },
      torrent: runtime,
    };
    this.states.set(torrent, state);
    runtime._drain = () => this.wake();
    runtime.on("wire", state.onWire);
    runtime.once("close", state.onClose);
    this.wake();
  }

  detach(torrent: Torrent) {
    const state = this.states.get(torrent);
    if (!state) {
      return;
    }
    // Restoring native drain would allow its pending reconnect timers to dial again.
    state.torrent._drain = () => undefined;
    state.torrent.removeListener("wire", state.onWire);
    state.torrent.removeListener("close", state.onClose);
    for (const cleanup of state.cleanups) {
      cleanup();
    }
    state.cleanups.clear();
    state.handshakes.clear();
    this.states.delete(torrent);
    this.wake();
  }

  setSeedingMode(mode: SeedingConnectionMode) {
    this.seedingMode = mode;
    this.wake();
  }

  close() {
    this.closed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    for (const torrent of this.states.keys()) {
      this.detach(torrent);
    }
    this.endpoints.clear();
  }

  get diagnostics(): ConnectionDiagnostics {
    let pendingOutgoing = 0;
    let connectedOutgoing = 0;
    let connectedIncoming = 0;
    let queuedOutgoing = 0;
    for (const { torrent } of this.states.values()) {
      queuedOutgoing += torrent._queue.length;
      for (const peer of torrent._peers.values()) {
        if (isPendingHandshake(peer)) {
          pendingOutgoing += 1;
        }
        if (!peer.connected) {
          continue;
        }
        if (peer.type.includes("Outgoing")) {
          connectedOutgoing += 1;
        } else if (peer.type.includes("Incoming")) {
          connectedIncoming += 1;
        }
      }
    }
    return {
      connectedIncoming,
      connectedOutgoing,
      crypto: null,
      deferredByCapacity: this.deferredByCapacity,
      deferredByCooldown: this.deferredByCooldown,
      deferredByRate: this.deferredByRate,
      incomingHandshakes: this.incomingHandshakes,
      outgoingAttempts: this.outgoingAttempts,
      outgoingHandshakes: this.outgoingHandshakes,
      outgoingRetries: this.outgoingRetries,
      pendingOutgoing,
      queuedOutgoing,
    };
  }

  private wake() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Socket callbacks may arrive after close.
    if (this.closed) {
      return;
    }
    this.schedule(0);
  }

  private schedule(delay: number) {
    if (this.timer) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        this.dispatch();
      },
      Math.max(0, Math.ceil(delay))
    );
    this.timer.unref();
  }

  private dispatch() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Public close calls change the lifecycle state.
    if (this.closed) {
      return;
    }
    const now = performance.now();
    const elapsed = Math.max(0, now - this.refreshedAt) / 1000;
    this.tokens = Math.min(
      this.policy.burst,
      this.tokens + elapsed * this.policy.attemptsPerSecond
    );
    this.seedTokens = Math.min(
      this.policy.seedBurst,
      this.seedTokens + elapsed * this.policy.seedAttemptsPerSecond
    );
    this.refreshedAt = now;
    const states = [...this.states.values()];
    let nextDelay = Number.POSITIVE_INFINITY;
    let totalConnections = 0;
    let totalPending = 0;
    for (const { torrent } of states) {
      totalConnections += torrent._numConns + torrent._numPending;
      totalPending += pendingHandshakes(torrent);
    }
    for (let offset = 0; offset < states.length; offset += 1) {
      const index = (this.cursor + offset) % states.length;
      const state = states[index];
      if (!state) {
        continue;
      }
      const { torrent } = state;
      if (torrent.destroyed || torrent.paused || torrent._queue.length === 0) {
        continue;
      }
      if (
        totalConnections >= this.policy.maxConnections ||
        totalPending >= this.policy.maxPending ||
        torrent._numConns + torrent._numPending >= this.policy.maxConnectionsPerTorrent
      ) {
        this.deferredByCapacity += 1;
        continue;
      }
      const candidate = this.candidate(state, now);
      nextDelay = Math.min(nextDelay, candidate.nextDelay);
      const peer = torrent._queue[candidate.index];
      if (!peer) {
        continue;
      }
      const wait = this.rateWait(state, now);
      if (wait > 0) {
        this.deferredByRate += 1;
        nextDelay = Math.min(nextDelay, wait);
        continue;
      }
      torrent._queue.splice(candidate.index, 1);
      torrent._queue.unshift(peer);
      state.drain();
      if (!peer.conn) {
        continue;
      }
      this.tokens -= 1;
      if (torrent.done) {
        this.seedTokens -= 1;
        state.lastSeedAttempt = now;
      }
      this.observe(state, peer, peer.conn, now);
      this.cursor = (index + 1) % states.length;
      this.schedule(0);
      return;
    }
    if (Number.isFinite(nextDelay)) {
      this.schedule(nextDelay);
    }
  }

  private candidate(state: TorrentState, now: number) {
    const { torrent } = state;
    let nextDelay = Number.POSITIVE_INFINITY;
    if (torrent.done && this.seedingMode === "incoming-only") {
      return { index: -1, nextDelay };
    }
    for (const [index, peer] of torrent._queue.entries()) {
      if (peer.destroyed) {
        continue;
      }
      const endpoint = this.endpoints.get(this.key(torrent, peer));
      if (
        endpoint &&
        now - endpoint.touchedAt < this.policy.cooldownTtlMs &&
        endpoint.eligibleAt > now
      ) {
        this.deferredByCooldown += 1;
        nextDelay = Math.min(nextDelay, endpoint.eligibleAt - now);
        continue;
      }
      return { index, nextDelay };
    }
    return { index: -1, nextDelay };
  }

  private rateWait(state: TorrentState, now: number) {
    const wait = Math.max(0, ((1 - this.tokens) * 1000) / this.policy.attemptsPerSecond);
    if (!state.torrent.done) {
      return wait;
    }
    return Math.max(
      wait,
      ((1 - this.seedTokens) * 1000) / this.policy.seedAttemptsPerSecond,
      state.lastSeedAttempt + this.policy.seedIntervalMs - now
    );
  }

  private key(torrent: Torrent, peer: RuntimePeer) {
    return `${torrent.infoHash}|${peer.addr.toLowerCase()}`;
  }

  private observe(state: TorrentState, peer: RuntimePeer, conn: Socket, now: number) {
    const key = this.key(state.torrent, peer);
    let endpoint = this.endpoints.get(key);
    if (!endpoint || now - endpoint.touchedAt >= this.policy.cooldownTtlMs) {
      endpoint = { eligibleAt: now, failures: 0, touchedAt: now };
    }
    this.endpoints.delete(key);
    this.endpoints.set(key, endpoint);
    while (this.endpoints.size > this.policy.maxCooldownEntries) {
      const oldest = this.endpoints.keys().next().value;
      if (oldest !== undefined) {
        this.endpoints.delete(oldest);
      }
    }
    this.outgoingAttempts += 1;
    if (endpoint.failures > 0) {
      this.outgoingRetries += 1;
    }
    const record = endpoint;
    const onConnect = () => this.wake();
    const cleanup = () => {
      conn.removeListener("close", onClose);
      conn.removeListener("connect", onConnect);
    };
    const onClose = () => {
      state.cleanups.delete(cleanup);
      const handshakeAt = state.handshakes.get(peer);
      state.handshakes.delete(peer);
      const closedAt = performance.now();
      record.failures =
        handshakeAt !== undefined && closedAt - handshakeAt >= this.policy.stableConnectionMs
          ? 0
          : record.failures + 1;
      const delay =
        record.failures === 0
          ? 0
          : (this.policy.retryDelaysMs[
              Math.min(record.failures - 1, this.policy.retryDelaysMs.length - 1)
            ] ?? 0);
      record.eligibleAt = closedAt + delay * (1 + Math.random() * 0.2);
      record.touchedAt = closedAt;
      this.wake();
    };
    state.cleanups.add(cleanup);
    conn.once("connect", onConnect);
    conn.once("close", onClose);
  }
}

function webTorrentVersion(client: WebTorrent) {
  return (client.constructor as typeof WebTorrent).VERSION;
}

function isPendingHandshake(peer: RuntimePeer) {
  return (
    peer.type.includes("Outgoing") && peer.conn !== null && !peer.destroyed && !peer._handshakeDone
  );
}

function pendingHandshakes(torrent: RuntimeTorrent) {
  let pending = 0;
  for (const peer of torrent._peers.values()) {
    if (isPendingHandshake(peer)) {
      pending += 1;
    }
  }
  return pending;
}

export interface ConnectionPolicy {
  attemptsPerSecond: number;
  burst: number;
  cooldownTtlMs: number;
  maxConnections: number;
  maxConnectionsPerTorrent: number;
  maxCooldownEntries: number;
  maxPending: number;
  retryDelaysMs: readonly number[];
  seedAttemptsPerSecond: number;
  seedBurst: number;
  seedIntervalMs: number;
  stableConnectionMs: number;
}

export interface ConnectionDiagnostics {
  connectedIncoming: number;
  connectedOutgoing: number;
  crypto: CryptoDiagnostics | null;
  deferredByCapacity: number;
  deferredByCooldown: number;
  deferredByRate: number;
  incomingHandshakes: number;
  outgoingAttempts: number;
  outgoingHandshakes: number;
  outgoingRetries: number;
  pendingOutgoing: number;
  queuedOutgoing: number;
}
