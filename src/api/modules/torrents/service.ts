import { constants, lstatSync, realpathSync, statSync } from "node:fs";
import { access, copyFile, link, lstat, mkdir, mkdtemp, rm, statfs } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import { type DrizzleSqliteSyncAdapter, drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { eq, sql } from "drizzle-orm";
import { HTTPError } from "elysia";
import parseTorrent, { toMagnetURI } from "parse-torrent";
import WebTorrent, { type Options, type Torrent } from "webtorrent";
import { torrentConfig, torrentDestinations, torrentRecords } from "../../../db/schema";
import type {
  ConnectionPolicy,
  DashboardState,
  Destination,
  DestinationInput,
  DestinationPresentation,
  EngineChange,
  EngineOpenOptions,
  FilePriority,
  Settings,
  SettingsInput,
  SpeedSample,
  TorrentDetail,
  TorrentStorageIssue,
  TrackerStats,
} from "../../../types";
import { type DatabaseConnection, openDatabase, type TofuDatabase } from "../../lib/db";
import { ConnectionScheduler, defaultConnectionPolicy } from "./connections";
import { installCryptoDiagnostics } from "./crypto-diagnostics";
import { announce, peers, watchTrackers } from "./stats";
import {
  type StorageIdentity,
  type StoredFileIdentity,
  storageFailure,
  storageFileChanged,
  storageRoot,
  verifiedFileBytes,
} from "./storage";

interface RelocatedFile {
  source: string;
  staged: string;
  target: string;
}

function canonicalPath(filePath: string) {
  return filePath.replaceAll("\\", "/");
}

async function storedFile(path: string) {
  const stored = await lstat(path).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  });
  if (stored?.isFile()) {
    await access(path, constants.R_OK);
  }
  return stored;
}

function moveError(cause: unknown) {
  if (cause instanceof HTTPError) {
    return cause;
  }
  const code = cause instanceof Error && "code" in cause ? cause.code : null;
  let message = "Unable to move files";
  if (code === "ENOSPC") {
    message = "Not enough space in the destination folder";
  }
  if (code === "EACCES" || code === "EPERM") {
    message = "Permission denied while moving files";
  }
  if (code === "EEXIST") {
    message = "A file already exists in the destination folder";
  }
  return new (HTTPError.id("CONFLICT", 409))(`${message}. The original files are preserved.`, {
    cause,
  });
}

interface Entry {
  detail: TorrentDetail;
  metadata: string | null;
  moving?: boolean;
  operation: Promise<void>;
  paused: boolean;
  source: string;
  storageClaimed: boolean;
  storageFiles: StoredFileIdentity[];
  storageRoot: StorageIdentity | null;
  torrent: Torrent | null;
  unwatch?: () => void;
  verifying?: boolean;
}
function entryStatus(entry: Entry): TorrentDetail["status"] {
  if (entry.moving) {
    return "moving";
  }
  if (entry.verifying) {
    return "checking";
  }
  if (entry.paused) {
    return "paused";
  }
  if (entry.detail.error) {
    return "error";
  }
  if (!entry.torrent?.ready) {
    return entry.torrent?.metadata ? "checking" : "metadata";
  }
  if (entry.torrent.done) {
    return "seeding";
  }
  return entry.torrent.downloadSpeed > 0 ? "downloading" : "idle";
}

type StoredEntry = Pick<Entry, "source" | "metadata" | "paused" | "detail"> & {
  storageClaimed?: boolean;
  storageRoot?: StorageIdentity | null;
  storageFiles?: StoredFileIdentity[];
};

const torrentUrl = /^https?:\/\//;
const trackerProtocols = new Set(["http:", "https:", "udp:", "ws:", "wss:"]);
export function trackerUrls(urls: string[]) {
  return [...new Set(urls.map((value) => value.trim()).filter(Boolean))].map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch (cause) {
      throw new (HTTPError.id("BAD_REQUEST", 400))(`Invalid tracker : ${value}`, { cause });
    }
    if (!trackerProtocols.has(url.protocol)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))(
        "Trackers must use HTTP, HTTPS, UDP, or WebSocket"
      );
    }
    return value;
  });
}

function trackerStats(url: string): TrackerStats {
  return {
    interval: null,
    lastAnnounce: null,
    leeches: null,
    message: null,
    seeds: null,
    status: "waiting",
    url,
  };
}

export class TorrentEngine {
  readonly client: WebTorrent;
  readonly settings: Settings;
  readonly syncAdapter: DrizzleSqliteSyncAdapter<TofuDatabase>;
  private readonly entries = new Map<string, Entry>();
  private readonly destinations = new Map<string, Destination>();
  private readonly movingDestinations = new Set<string>();
  private destinationOperation: Promise<void> | null = null;
  private readonly startedAt = Date.now();
  private readonly db: TofuDatabase;
  private readonly history: SpeedSample[] = [];
  private timer: ReturnType<typeof setInterval>;
  private telemetryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private storageCheck: Promise<void> | null = null;
  private received = 0;
  private uploaded = 0;
  private freeSpace: number | null = null;
  private lastTick = Date.now();
  private lastDiskAt = 0;
  private lastPersistAt = 0;
  private readonly connections: ConnectionScheduler;
  private readonly cryptoDiagnostics: ReturnType<typeof installCryptoDiagnostics> | null;
  private readonly dirtyEntries = new Set<Entry>();
  private readonly persistedEntries = new Map<Entry, string>();
  private readonly entryStructures = new Map<Entry, string>();
  private trafficDirty = false;
  private readonly listeners = new Set<(change: EngineChange) => void>();
  private observed = false;
  private diskCheck: Promise<void> | null = null;
  private lastTelemetryAt = Date.now();
  private telemetryValues: number[] = [];
  stateRevision = 0;
  telemetryRevision = 0;
  mode: "desktop" | "server" = "server";

  private constructor(
    settings: Settings,
    network: Options,
    database: TofuDatabase,
    policy: ConnectionPolicy,
    cryptoDiagnostics: ReturnType<typeof installCryptoDiagnostics> | null
  ) {
    this.db = database;
    this.syncAdapter = drizzleSyncAdapter({ db: database, namespace: "tofu" });
    this.cryptoDiagnostics = cryptoDiagnostics;
    const stored = this.db
      .select()
      .from(torrentConfig)
      .where(eq(torrentConfig.key, "settings"))
      .get();
    this.settings = stored ? { ...settings, ...(JSON.parse(stored.value) as Settings) } : settings;
    for (const destination of this.db
      .select()
      .from(torrentDestinations)
      .orderBy(sql`rowid`)
      .all()) {
      this.destinations.set(destination.id, destination);
    }
    if (!this.destinations.has("default")) {
      this.storeDestination({
        downloadPath: this.settings.downloadPath,
        icon: "folder",
        id: "default",
        name: "Downloads",
        pinned: false,
      });
    }
    const totals = this.db
      .select()
      .from(torrentConfig)
      .where(eq(torrentConfig.key, "traffic"))
      .get();
    if (totals) {
      const parsed: { received: number; uploaded: number } = JSON.parse(totals.value);
      this.received = parsed.received;
      this.uploaded = parsed.uploaded;
    }
    this.client = new WebTorrent(network);
    this.client.seedOutgoingConnections = this.settings.seedingConnectionMode === "balanced";
    this.connections = new ConnectionScheduler(
      this.client,
      policy,
      this.settings.seedingConnectionMode
    );
    this.client.throttleDownload(this.settings.downloadLimit);
    this.client.throttleUpload(this.settings.uploadLimit);
    this.client.on("error", console.error);
    for (const row of this.db.select().from(torrentRecords).orderBy(sql`rowid`).all()) {
      const storedEntry: StoredEntry = JSON.parse(row.value);
      storedEntry.detail.destinationId ??= this.destinationForPath(
        dirname(storedEntry.detail.savePath)
      ).id;
      storedEntry.detail.storageIssue ??= null;
      this.entries.set(storedEntry.detail.id, {
        ...storedEntry,
        operation: Promise.resolve(),
        storageClaimed: storedEntry.storageClaimed ?? storedEntry.detail.error === null,
        storageFiles: storedEntry.storageFiles ?? [],
        storageRoot: storedEntry.storageRoot ?? null,
        torrent: null,
      });
    }
    this.timer = setInterval(this.tick, 5000);
    this.timer.unref();
  }

  private readonly tick = () => {
    const now = Date.now();
    const seconds = (now - this.lastTick) / 1000;
    this.lastTick = now;
    for (const entry of this.entries.values()) {
      if (!entry.paused && entry.torrent) {
        this.dirtyEntries.add(entry);
        entry.detail.activeSeconds += seconds;
        if (entry.torrent.done) {
          entry.detail.seedSeconds += seconds;
        }
      }
      this.summary(entry);
    }
    if (now - this.lastPersistAt >= 5000) {
      this.checkpoint();
      this.lastPersistAt = now;
    }
    // biome-ignore lint/suspicious/noUnnecessaryConditions: subscriptions change observation after startup.
    if (this.observed) {
      this.history.push({
        download: this.client.downloadSpeed,
        time: now,
        upload: this.client.uploadSpeed,
      });
      if (this.history.length > 120) {
        this.history.shift();
      }
      // Speeds decay with time even when no transfer event arrives.
      this.publishTelemetry(now);
    }
    if (now - this.lastDiskAt >= this.diskInterval) {
      this.diskSpace();
    }
    if (!this.storageCheck) {
      this.storageCheck = this.checkStorage().finally(() => {
        this.storageCheck = null;
      });
    }
  };

  static async open(options: EngineOpenOptions) {
    await mkdir(options.dataDir, { recursive: true });
    const database = await openDatabase(options.dataDir);
    const cryptoDiagnostics =
      (options.cryptoDiagnostics ?? process.env.TOFU_CRYPTO_DIAGNOSTICS === "1")
        ? installCryptoDiagnostics()
        : null;
    let engine: TorrentEngine;
    try {
      engine = new TorrentEngine(
        {
          deleteTorrentFileAfterAdd: false,
          downloadLimit: -1,
          downloadPath: options.downloadPath,
          runInBackground: false,
          seedingConnectionMode: "balanced",
          theme: "system",
          uploadLimit: -1,
        },
        options.network,
        database,
        options.connectionPolicy ?? defaultConnectionPolicy,
        cryptoDiagnostics
      );
    } catch (error) {
      cryptoDiagnostics?.close();
      database.$client.close(true);
      throw error;
    }
    try {
      if (engine.entries.size === 0) {
        await mkdir(engine.settings.downloadPath, { recursive: true });
      }
      await engine.diskSpace();
      await Promise.all(
        [...engine.entries.values()].map(async (entry) => {
          await engine.inspectStorage(entry);
          if (!entry.paused) {
            await engine.start(entry);
          }
        })
      );
      engine.telemetryValues = engine.measureTelemetry();
      return engine;
    } catch (error) {
      await engine.close().catch(() => undefined);
      throw error;
    }
  }

  assertReady() {
    if (this.client.destroyed) {
      throw new (HTTPError.id("SERVICE_UNAVAILABLE", 503))("The torrent engine has stopped");
    }
    this.db.run(sql`SELECT 1 FROM config, torrents, destinations LIMIT 0`);
  }

  private checkpoint() {
    const saved = new Map<Entry, string>();
    this.db.transaction((tx) => {
      for (const entry of this.dirtyEntries) {
        saved.set(entry, this.save(entry, tx));
      }
      // biome-ignore lint/suspicious/noUnnecessaryConditions: transfer callbacks mark traffic dirty between checkpoints.
      if (this.trafficDirty) {
        this.config("traffic", { received: this.received, uploaded: this.uploaded }, tx);
      }
    });
    for (const [entry, value] of saved) {
      this.persistedEntries.set(entry, value);
    }
    this.dirtyEntries.clear();
    this.trafficDirty = false;
  }

  private get diskInterval() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: browser subscriptions update observation after startup.
    return this.observed ? 15_000 : 60_000;
  }

  private measureTelemetry() {
    const values = [
      this.received,
      this.uploaded,
      this.client.downloadSpeed,
      this.client.uploadSpeed,
      this.freeSpace ?? -1,
    ];
    for (const entry of this.entries.values()) {
      values.push(
        entry.torrent?.numPeers ?? 0,
        entry.torrent?.ready ? entry.torrent.progress : (entry.detail.progress ?? -1)
      );
    }
    return values;
  }

  private publishTelemetry(now: number) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: subscriptions change observation after startup.
    if (!this.observed || now - this.lastTelemetryAt < 1000) {
      return;
    }
    this.lastTelemetryAt = now;
    const values = this.measureTelemetry();
    if (
      values.length !== this.telemetryValues.length ||
      values.some((value, index) => value !== this.telemetryValues[index])
    ) {
      this.telemetryValues = values;
      this.changed("telemetry");
    }
  }

  private queueTelemetry() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: subscriptions change observation after startup.
    if (!this.observed || this.closed || this.telemetryTimer) {
      return;
    }
    this.telemetryTimer = setTimeout(
      () => {
        this.telemetryTimer = null;
        this.publishTelemetry(Date.now());
      },
      Math.max(0, 1000 - (Date.now() - this.lastTelemetryAt))
    );
    this.telemetryTimer.unref();
  }

  private diskSpace() {
    if (!this.diskCheck) {
      this.lastDiskAt = Date.now();
      this.diskCheck = statfs(this.settings.downloadPath)
        .then((disk) => {
          this.freeSpace = disk.bavail * disk.bsize;
        })
        .catch(() => {
          this.freeSpace = null;
        })
        .finally(() => {
          this.diskCheck = null;
        });
    }
    return this.diskCheck;
  }

  connectionDiagnostics() {
    return { ...this.connections.diagnostics, crypto: this.cryptoDiagnostics?.snapshot() ?? null };
  }

  setObserved(observed: boolean) {
    if (this.observed === observed || this.closed) {
      return;
    }
    clearInterval(this.timer);
    this.observed = observed;
    this.timer = setInterval(this.tick, observed ? 1000 : 5000);
    this.timer.unref();
    if (observed) {
      this.history.length = 0;
      this.telemetryValues = [];
      this.lastTelemetryAt = 0;
      this.queueTelemetry();
    } else if (this.telemetryTimer) {
      clearTimeout(this.telemetryTimer);
      this.telemetryTimer = null;
    }
  }

  async refreshSnapshot(_maxAgeMs: number) {
    if (Date.now() - this.lastDiskAt >= this.diskInterval) {
      await this.diskSpace();
    }
    return this.snapshot(null, false);
  }

  subscribeChanges(listener: (change: EngineChange) => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private changed(kind: EngineChange["kind"]) {
    if (kind === "state") {
      this.stateRevision += 1;
    } else {
      this.telemetryRevision += 1;
    }
    for (const listener of this.listeners) {
      listener({
        kind,
        stateRevision: this.stateRevision,
        telemetryRevision: this.telemetryRevision,
      });
    }
  }

  private async checkStorage() {
    for (const entry of this.entries.values()) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: close may run while storage checks await filesystem work.
      if (this.closed) {
        return;
      }
      if (!(entry.metadata && entry.storageClaimed) || entry.moving || entry.verifying) {
        continue;
      }
      // Serialize filesystem checks with pause, removal, and other lifecycle operations.
      // biome-ignore lint/performance/noAwaitInLoops: bound filesystem work across torrents.
      await this.serial(entry, () => this.inspectStorage(entry), { checkpoint: true }).catch(
        () => undefined
      );
    }
  }

  private async inspectStorage(entry: Entry) {
    if (entry.detail.storageIssue) {
      return;
    }
    const detail = this.details(entry);
    try {
      entry.storageRoot = await storageRoot(detail.savePath, entry.storageRoot);
      await this.inspectFiles(entry);
    } catch (cause) {
      await this.blockStorage(
        entry,
        storageFailure(
          cause,
          detail.files.map((file) => file.path)
        )
      );
    }
  }

  private async inspectFiles(entry: Entry) {
    const { detail } = entry;
    const missing: string[] = [];
    const modified: string[] = [];
    const previous = new Map(entry.storageFiles.map((file) => [file.path, file]));
    const observed: StoredFileIdentity[] = [];
    for (const file of detail.files) {
      const before = previous.get(file.path);
      if (file.priority === "skip" || !(file.downloaded || before)) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: bound filesystem work within a torrent.
      const stored = await storedFile(this.storagePath(detail.savePath, file.path));
      if (!stored) {
        missing.push(file.path);
      } else if (storageFileChanged(file, stored, before)) {
        modified.push(file.path);
      }
      if (stored) {
        observed.push({
          complete: file.progress === 1,
          dev: stored.dev,
          ino: stored.ino,
          mtimeMs: stored.mtimeMs,
          path: file.path,
          size: stored.size,
        });
      }
    }
    if (missing.length) {
      await this.blockStorage(entry, {
        detectedAt: Date.now(),
        kind: "missing-files",
        message: modified.length
          ? "Downloaded files are missing or modified. Restore them or repair the download."
          : "Downloaded files are missing. Restore them or repair the download.",
        paths: [...missing, ...modified],
      });
    } else if (modified.length) {
      await this.blockStorage(entry, {
        detectedAt: Date.now(),
        kind: "modified-files",
        message: "Downloaded files were modified or truncated. Verify them or repair the download.",
        paths: modified,
      });
    } else {
      entry.storageFiles = observed;
    }
  }

  private async blockStorage(entry: Entry, issue: TorrentStorageIssue) {
    await this.stop(entry);
    this.markStorageIssue(entry, issue);
  }

  private markStorageIssue(entry: Entry, issue: TorrentStorageIssue) {
    entry.detail.storageIssue = issue;
    entry.detail.error = issue.message;
    entry.detail.downloaded = null;
    entry.detail.progress = null;
    entry.detail.completedAt = null;
    entry.detail.eta = null;
    entry.detail.verifiedPieces = null;
    entry.detail.pieceMap = [];
    const affectedPaths = new Set(issue.paths);
    for (const file of entry.detail.files) {
      if (affectedPaths.has(file.path)) {
        file.downloaded = null;
        file.progress = null;
      }
    }
    this.save(entry);
  }

  private config(
    key: string,
    value: Settings | { received: number; uploaded: number },
    connection?: DatabaseConnection
  ) {
    const db = connection ?? this.db;
    const serialized = JSON.stringify(value);
    db.insert(torrentConfig)
      .values({ key, value: serialized })
      .onConflictDoUpdate({ set: { value: serialized }, target: torrentConfig.key })
      .run();
    if (!connection && key === "settings") {
      this.changed("state");
    }
  }

  private save(entry: Entry, connection?: DatabaseConnection) {
    const db = connection ?? this.db;
    const {
      source,
      metadata,
      paused,
      detail,
      storageClaimed,
      storageRoot: root,
      storageFiles,
    } = entry;
    const value = JSON.stringify({
      detail,
      metadata,
      paused,
      source,
      storageClaimed,
      storageFiles,
      storageRoot: root,
    } satisfies StoredEntry);
    if (this.persistedEntries.get(entry) === value) {
      return value;
    }
    db.insert(torrentRecords)
      .values({ id: detail.id, value })
      .onConflictDoUpdate({ set: { value }, target: torrentRecords.id })
      .run();
    if (!connection) {
      this.persistedEntries.set(entry, value);
      this.dirtyEntries.delete(entry);
      const structure = JSON.stringify({
        completedAt: detail.completedAt,
        destinationId: detail.destinationId,
        error: detail.error,
        files: detail.files.map((file) => [file.path, file.priority]),
        id: detail.id,
        magnet: detail.magnet,
        moving: entry.moving ?? false,
        name: detail.name,
        paused,
        savePath: detail.savePath,
        storageIssue: detail.storageIssue,
        trackers: detail.trackers.map((tracker) => tracker.url),
        verifying: entry.verifying ?? false,
      });
      if (this.entryStructures.get(entry) !== structure) {
        this.entryStructures.set(entry, structure);
        this.changed("state");
      }
    }
    return value;
  }

  private writeDestination(destination: Destination, connection?: DatabaseConnection) {
    const db = connection ?? this.db;
    const { id, ...presentation } = destination;
    db.insert(torrentDestinations)
      .values(destination)
      .onConflictDoUpdate({ set: presentation, target: torrentDestinations.id })
      .run();
  }

  private storeDestination(destination: Destination, connection?: DatabaseConnection) {
    this.writeDestination(destination, connection);
    this.destinations.set(destination.id, destination);
    if (!connection) {
      this.changed("state");
    }
    return destination;
  }

  private destinationForPath(downloadPath: string) {
    return (
      [...this.destinations.values()].find(
        (destination) => destination.downloadPath === downloadPath
      ) ??
      this.storeDestination({
        downloadPath,
        icon: "folder",
        id: crypto.randomUUID(),
        name: basename(downloadPath) || "Downloads",
        pinned: false,
      })
    );
  }

  private async prepareDestination(path: string) {
    const bound = [...this.entries.values()].find(
      (entry) => entry.storageRoot && resolvePath(entry.detail.savePath) === resolvePath(path)
    );
    if (bound) {
      try {
        await storageRoot(path, bound.storageRoot);
      } catch (cause) {
        throw new (HTTPError.id("CONFLICT", 409))(storageFailure(cause, []).message, { cause });
      }
    } else {
      await mkdir(path, { recursive: true });
    }
  }

  async saveDestination(id: string | null, input: DestinationInput) {
    const name = input.name.trim();
    if (!(name && isAbsolute(input.downloadPath))) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Enter a name and an absolute folder path");
    }
    if (id && !this.destinations.has(id)) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Tab not found");
    }
    if (this.movingDestinations.size > 0) {
      throw new (HTTPError.id("CONFLICT", 409))("A move is already in progress for this tab");
    }
    const downloadPath = resolvePath(input.downloadPath);
    if (id && input.moveFiles) {
      const previous = this.destinations.get(id);
      const destination: Destination = {
        downloadPath,
        icon: input.icon ?? previous?.icon ?? "folder",
        id,
        name,
        pinned: input.pinned ?? previous?.pinned ?? false,
      };
      const operation = this.moveDestination(destination);
      this.destinationOperation = operation;
      try {
        await operation;
      } finally {
        this.destinationOperation = null;
      }
      return destination;
    }
    await this.prepareDestination(downloadPath);
    if (id && !this.destinations.has(id)) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Tab not found");
    }
    if (this.movingDestinations.size > 0) {
      throw new (HTTPError.id("CONFLICT", 409))("A move is already in progress for this tab");
    }
    const previous = id ? this.destinations.get(id) : undefined;
    const destination = this.storeDestination({
      downloadPath,
      icon: input.icon ?? previous?.icon ?? "folder",
      id: id ?? crypto.randomUUID(),
      name,
      pinned: input.pinned ?? previous?.pinned ?? false,
    });
    if (destination.id === "default") {
      this.settings.downloadPath = destination.downloadPath;
      this.config("settings", this.settings);
      await this.diskSpace();
    }
    return destination;
  }

  updateDestinationPresentation(id: string, input: DestinationPresentation) {
    const destination = this.destinations.get(id);
    if (!destination) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Tab not found");
    }
    if (this.movingDestinations.size > 0) {
      throw new (HTTPError.id("CONFLICT", 409))("Wait for the move to finish before editing a tab");
    }
    return this.storeDestination({
      ...destination,
      icon: input.icon ?? destination.icon,
      pinned: input.pinned ?? destination.pinned,
    });
  }

  async removeDestination(id: string) {
    if (!this.destinations.has(id)) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Tab not found");
    }
    if (this.movingDestinations.size > 0) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "Wait for the move to finish before deleting a tab"
      );
    }
    // Torrents, rules and preferences fall back to the "default" ID, so deleting that tab moves
    // the next tab into the default slot and removes the next tab's former ID instead.
    const removed =
      id === "default" ? [...this.destinations.keys()].find((key) => key !== "default") : id;
    const successor = removed === undefined ? undefined : this.destinations.get(removed);
    if (!(removed && successor)) {
      throw new (HTTPError.id("CONFLICT", 409))("At least one tab is required");
    }
    const reassigned = [...this.entries.values()].filter(
      (entry) => entry.detail.destinationId === removed
    );
    this.db.transaction((tx) => {
      for (const entry of reassigned) {
        this.save({ ...entry, detail: { ...entry.detail, destinationId: "default" } }, tx);
      }
      if (id === "default") {
        this.writeDestination({ ...successor, id: "default" }, tx);
        this.config("settings", { ...this.settings, downloadPath: successor.downloadPath }, tx);
      }
      tx.delete(torrentDestinations).where(eq(torrentDestinations.id, removed)).run();
    });
    for (const entry of reassigned) {
      entry.detail.destinationId = "default";
    }
    if (id === "default") {
      this.destinations.set("default", { ...successor, id: "default" });
      this.settings.downloadPath = successor.downloadPath;
    }
    this.destinations.delete(removed);
    this.changed("state");
    if (id === "default") {
      await this.diskSpace();
    }
    return { ok: true, removed };
  }

  private async moveDestination(destination: Destination) {
    const { id, downloadPath } = destination;
    const entries = [...this.entries.values()].filter(
      (entry) =>
        entry.detail.destinationId === id && resolvePath(entry.detail.savePath) !== downloadPath
    );
    this.validateMove(entries);
    this.movingDestinations.add(id);
    for (const entry of entries) {
      entry.moving = true;
    }
    let running: Entry[] = [];
    let files: RelocatedFile[] = [];
    const originalPaths = new Map(entries.map((entry) => [entry, entry.detail.savePath]));
    const originalStorage = new Map(
      entries.map((entry) => [entry, { files: entry.storageFiles, root: entry.storageRoot }])
    );
    const originalDestination = this.destinations.get(id);
    const originalDefaultPath = this.settings.downloadPath;
    const published: string[] = [];
    let staging: string | null = null;
    let committed = false;
    try {
      await Promise.all(entries.map((entry) => entry.operation.catch(() => undefined)));
      running = entries.filter(
        (entry) => !entry.paused && this.entries.get(entry.detail.id) === entry
      );
      this.validateMove(entries);
      await Promise.all(entries.map((entry) => this.stop(entry)));
      await this.prepareDestination(downloadPath);
      staging = await mkdtemp(join(downloadPath, ".tofu-move-"));
      files = await this.planMove(entries, downloadPath, staging);
      const copies = await Promise.allSettled(
        files.map((file) => copyFile(file.source, file.staged))
      );
      const failure = copies.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
      await this.publishMove(files, published);
      const movedRoot = await storageRoot(downloadPath, null);
      this.db.transaction((tx) => {
        for (const entry of entries) {
          entry.detail.savePath = downloadPath;
          entry.storageRoot = movedRoot;
          entry.storageFiles = [];
          this.save(entry, tx);
        }
        this.storeDestination(destination, tx);
        if (id === "default") {
          this.settings.downloadPath = downloadPath;
          this.config("settings", this.settings, tx);
        }
      });
      committed = true;
      this.changed("state");
      const cleanup = await Promise.allSettled(files.map((file) => rm(file.source)));
      if (cleanup.some((result) => result.status === "rejected")) {
        throw new (HTTPError.id("INTERNAL_SERVER_ERROR", 500))(
          "Files were moved, but some copies in the old folder could not be removed. The new folder is active."
        );
      }
    } catch (cause) {
      if (!committed) {
        for (const [entry, path] of originalPaths) {
          entry.detail.savePath = path;
          entry.storageRoot = originalStorage.get(entry)?.root ?? null;
          entry.storageFiles = originalStorage.get(entry)?.files ?? [];
        }
        if (originalDestination) {
          this.destinations.set(id, originalDestination);
        }
        this.settings.downloadPath = originalDefaultPath;
        await Promise.all(published.map((path) => rm(path, { force: true })));
      }
      throw moveError(cause);
    } finally {
      try {
        if (staging) {
          await rm(staging, { force: true, recursive: true });
        }
      } finally {
        for (const entry of entries) {
          entry.moving = false;
        }
        try {
          await Promise.all(
            running.filter((entry) => !entry.torrent).map((entry) => this.start(entry))
          );
        } finally {
          this.movingDestinations.delete(id);
        }
        await this.diskSpace();
      }
    }
  }

  private validateMove(entries: Entry[]) {
    for (const entry of entries) {
      if (this.entries.get(entry.detail.id) !== entry) {
        throw new (HTTPError.id("NOT_FOUND", 404))("Torrent not found");
      }
      const status = entryStatus(entry);
      if (
        status === "checking" ||
        entry.verifying ||
        (entry.torrent?.metadata && !entry.torrent.ready)
      ) {
        throw new (HTTPError.id("CONFLICT", 409))(
          `${entry.detail.name} is being verified. Try again after verification completes.`
        );
      }
      if (!entry.metadata || status === "metadata") {
        throw new (HTTPError.id("CONFLICT", 409))(
          `The metadata for ${entry.detail.name} is not available yet.`
        );
      }
      if (entry.detail.error) {
        throw new (HTTPError.id("CONFLICT", 409))(
          `Unable to move ${entry.detail.name} : ${entry.detail.error}`
        );
      }
    }
  }

  private async planMove(entries: Entry[], downloadPath: string, staging: string) {
    const movingEntries = new Set(entries);
    const reserved = new Set(
      [...this.entries.values()]
        .filter((entry) => !movingEntries.has(entry) && entry.storageClaimed)
        .flatMap((entry) =>
          entry.detail.files.map((file) => this.storageKey(entry.detail.savePath, file.path))
        )
    );
    const planned = entries.flatMap((entry) =>
      entry.detail.files.map((file) => ({
        file,
        source: this.storagePath(entry.detail.savePath, file.path),
        sourceKey: this.storageKey(entry.detail.savePath, file.path),
        target: this.storagePath(downloadPath, file.path),
        targetKey: this.storageKey(downloadPath, file.path),
      }))
    );
    const sources = new Set(planned.map((item) => item.sourceKey));
    const targets = new Set<string>();
    for (const item of planned) {
      if (
        reserved.has(item.sourceKey) ||
        reserved.has(item.targetKey) ||
        targets.has(item.targetKey) ||
        sources.has(item.targetKey)
      ) {
        throw new (HTTPError.id("CONFLICT", 409))(
          `The file ${item.file.path} is already used by another torrent. Choose another folder.`
        );
      }
      targets.add(item.targetKey);
    }
    const files = await Promise.all(
      planned.map(async ({ file, source, target }, index) => {
        const [existing, stored] = await Promise.all([storedFile(target), storedFile(source)]);
        if (existing) {
          throw new (HTTPError.id("CONFLICT", 409))(
            `A file already exists in the destination folder : ${target}. It will not be overwritten.`
          );
        }
        if (!stored) {
          if ((file.downloaded ?? 0) > 0 || (file.progress === 1 && file.length > 0)) {
            throw new (HTTPError.id("NOT_FOUND", 404))(
              `The downloaded file is no longer present : ${source}. Restore it or verify the torrent before retrying.`
            );
          }
          return null;
        }
        if (!stored.isFile()) {
          throw new (HTTPError.id("CONFLICT", 409))(`This path is not a file : ${source}`);
        }
        if (stored.size < (file.downloaded ?? 0)) {
          throw new (HTTPError.id("CONFLICT", 409))(
            `The downloaded file was modified or truncated : ${source}. Verify the torrent before moving it.`
          );
        }
        return { source, staged: join(staging, String(index)), target };
      })
    );
    return files.filter((file) => file !== null);
  }

  private async publishMove(files: RelocatedFile[], published: string[]) {
    const results = await Promise.allSettled(
      files.map(async (file) => {
        await mkdir(dirname(file.target), { recursive: true });
        // Publish the staged copy on the same volume without overwriting any file.
        await link(file.staged, file.target);
        published.push(file.target);
      })
    );
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") {
      throw failure.reason;
    }
  }

  private canonicalStorageRoot(root: StorageIdentity) {
    return (
      [...this.entries.values()].find(
        (entry) =>
          entry.storageRoot?.dev === root.dev &&
          entry.storageRoot.ino === root.ino &&
          entry.storageRoot.canonicalPath
      )?.storageRoot?.canonicalPath ?? root.canonicalPath
    );
  }

  private storageKey(savePath: string, filePath: string) {
    try {
      return resolvePath(
        this.canonicalStorageRoot(statSync(savePath)) ?? realpathSync(savePath),
        filePath
      );
    } catch (cause) {
      if (
        cause instanceof Error &&
        "code" in cause &&
        ["ENOENT", "EACCES", "EPERM", "ENODEV", "EIO"].includes(String(cause.code))
      ) {
        const root = [...this.entries.values()].find(
          (entry) => resolvePath(entry.detail.savePath) === resolvePath(savePath)
        )?.storageRoot;
        const canonical = root ? this.canonicalStorageRoot(root) : undefined;
        if (canonical) {
          return resolvePath(canonical, filePath);
        }
        if (cause.code === "ENOENT") {
          return resolvePath(savePath, filePath);
        }
        throw new (HTTPError.id("CONFLICT", 409))(
          "Restore access to the unavailable destination before checking file ownership.",
          { cause }
        );
      }
      throw cause;
    }
  }

  private storagePath(savePath: string, filePath: string) {
    const path = resolvePath(savePath, filePath);
    const within = relative(savePath, path);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("File path outside the download folder");
    }
    let component = savePath;
    for (const part of within.split(sep)) {
      component = join(component, part);
      try {
        if (lstatSync(component).isSymbolicLink()) {
          throw new (HTTPError.id("CONFLICT", 409))("A symbolic link is present in the file path");
        }
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          break;
        }
        throw cause;
      }
    }
    return path;
  }

  private resolveDestination(options: { destinationId?: string; downloadPath?: string }) {
    const chosen = this.destinations.get(options.destinationId ?? "");
    if (options.destinationId && !chosen) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Tab not found");
    }
    const downloadPath =
      chosen?.downloadPath ?? (options.downloadPath || this.settings.downloadPath);
    if (!isAbsolute(downloadPath)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("The download folder must be an absolute path");
    }
    const destination = chosen ?? this.destinationForPath(downloadPath);
    if (this.movingDestinations.size > 0) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "Wait for the move to finish before adding a torrent"
      );
    }
    return destination;
  }

  async add(
    input: string | Uint8Array,
    options: { paused: boolean; destinationId?: string; downloadPath?: string; trackers?: string[] }
  ) {
    let source = input;
    if (typeof source === "string" && torrentUrl.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        throw new (HTTPError.id("BAD_REQUEST", 400))(
          `The torrent file is inaccessible (HTTP ${response.status})`
        );
      }
      source = new Uint8Array(await response.arrayBuffer());
      if (source.length > 8 * 1024 * 1024) {
        throw new (HTTPError.id("BAD_REQUEST", 400))("The torrent file is too large");
      }
    }
    let parsed: Awaited<ReturnType<typeof parseTorrent>>;
    try {
      parsed = await parseTorrent(source);
    } catch (cause) {
      throw new (HTTPError.id("BAD_REQUEST", 400))(
        "Invalid magnet link or .torrent file (BitTorrent v1 required)",
        {
          cause,
        }
      );
    }
    const id = parsed.infoHash;
    parsed.announce = trackerUrls([...parsed.announce, ...(options.trackers ?? [])]);
    const destination = this.resolveDestination(options);
    const { downloadPath } = destination;
    const savePath = downloadPath;
    if (!this.destinations.has(destination.id)) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Tab not found");
    }
    if (this.movingDestinations.size > 0) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "Wait for the move to finish before adding a torrent"
      );
    }
    if (this.entries.has(id)) {
      throw new (HTTPError.id("CONFLICT", 409))("This torrent is already in your library");
    }
    await this.prepareDestination(savePath);
    const root = await storageRoot(savePath, null);
    if (this.entries.has(id)) {
      throw new (HTTPError.id("CONFLICT", 409))("This torrent is already in your library");
    }
    if (!this.destinations.has(destination.id) || this.movingDestinations.size > 0) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "The destination changed while adding the torrent. Try again."
      );
    }

    const detail: TorrentDetail = {
      activeSeconds: 0,
      addedAt: Date.now(),
      comment: "",
      completedAt: null,
      createdBy: "",
      destinationId: destination.id,
      downloaded: 0,
      downloadSpeed: 0,
      error: null,
      eta: null,
      files: (parsed.files ?? []).map((file, index) => ({
        downloaded: 0,
        index,
        length: file.length,
        name: file.name,
        path: canonicalPath(file.path),
        priority: "normal",
        progress: 0,
      })),
      id,
      lastTransferAt: null,
      length: parsed.length ?? 0,
      magnet: toMagnetURI(parsed),
      name: parsed.name || id,
      peerList: [],
      peers: 0,
      pieceLength: 0,
      pieceMap: [],
      pieces: 0,
      private: parsed.private ?? false,
      progress: 0,
      ratio: null,
      received: 0,
      savePath,
      seedSeconds: 0,
      seeds: 0,
      status: "metadata",
      storageIssue: null,
      swarmPeers: null,
      swarmSeeds: null,
      trackers: parsed.announce.map(trackerStats),
      uploaded: 0,
      uploadSpeed: 0,
      verifiedPieces: 0,
    };
    const entry: Entry = {
      detail,
      metadata: parsed.info ? Buffer.from(source as Uint8Array).toString("base64") : null,
      operation: Promise.resolve(),
      paused: options.paused,
      source: detail.magnet,
      storageClaimed: false,
      storageFiles: [],
      storageRoot: root,
      torrent: null,
    };
    this.entries.set(id, entry);
    if (!options.paused) {
      await this.start(entry);
    }
    this.save(entry);
    return { id };
  }

  private storageCollision(entry: Entry, torrent: Torrent) {
    const reserved = new Set(
      [...this.entries.values()]
        .filter((other) => other !== entry && other.storageClaimed)
        .flatMap((other) =>
          other.detail.files.map((file) => this.storageKey(other.detail.savePath, file.path))
        )
    );
    return torrent.files.find((file) =>
      reserved.has(this.storageKey(entry.detail.savePath, file.path))
    );
  }

  private async start(entry: Entry, options?: { checking: boolean }) {
    if (!options?.checking) {
      await this.inspectStorage(entry);
      if (entry.detail.storageIssue) {
        return;
      }
    }
    const parsed = await parseTorrent(
      entry.metadata ? Buffer.from(entry.metadata, "base64") : entry.source
    );
    parsed.peerAddresses = (await parseTorrent(entry.source)).peerAddresses;
    parsed.announce = entry.detail.trackers.map((tracker) => tracker.url);
    const expected = new Map(entry.detail.files.map((file) => [file.path, file.downloaded ?? 0]));
    entry.detail.error = entry.detail.storageIssue?.message ?? null;
    entry.torrent = this.client.add(parsed, {
      deselect: true,
      path: entry.detail.savePath,
      paused: options?.checking || entry.paused,
    });
    const { torrent } = entry;
    this.connections.attach(torrent);
    const { detail } = entry;
    torrent.on("metadata", () => {
      entry.metadata = Buffer.from(torrent.torrentFile).toString("base64");
      let collision: Torrent["files"][number] | undefined;
      try {
        // This callback runs before WebTorrent verifies or writes its filesystem store.
        for (const file of torrent.files) {
          this.storagePath(detail.savePath, file.path);
        }
        collision = this.storageCollision(entry, torrent);
      } catch (cause) {
        detail.error = cause instanceof Error ? cause.message : "Invalid file path";
        entry.torrent = null;
        entry.unwatch?.();
        torrent.destroy({ destroyStore: false });
        this.save(entry);
        return;
      }
      // Reserve the metadata paths before another torrent becomes ready.
      const savedFiles = new Map(detail.files.map((file) => [canonicalPath(file.path), file]));
      detail.files = torrent.files.map((file, index) => ({
        downloaded: savedFiles.get(canonicalPath(file.path))?.downloaded ?? 0,
        index,
        length: file.length,
        name: file.name,
        path: canonicalPath(file.path),
        priority: savedFiles.get(canonicalPath(file.path))?.priority ?? "normal",
        progress: savedFiles.get(canonicalPath(file.path))?.progress ?? 0,
      }));
      entry.storageClaimed = !collision;
      if (collision) {
        detail.error = `The file ${canonicalPath(collision.path)} is already used by another torrent. Choose another folder.`;
        entry.torrent = null;
        entry.unwatch?.();
        torrent.destroy({ destroyStore: false });
      }
      this.save(entry);
    });
    // WebTorrent 3.0.21 compares against torrent.peerId rather than client.peerId.
    torrent.on("wire", (wire: Torrent["wires"][number], address: string | undefined) => {
      this.queueTelemetry();
      wire.once("close", this.queueTelemetry.bind(this));
      if (wire.peerId !== this.client.peerId) {
        return;
      }
      if (address) {
        torrent.removePeer(address);
      }
      wire.destroy();
    });
    torrent.on("download", (bytes) => {
      this.dirtyEntries.add(entry);
      this.trafficDirty = true;
      detail.received += bytes;
      this.received += bytes;
      detail.lastTransferAt = Date.now();
      this.queueTelemetry();
    });
    torrent.on("upload", (bytes) => {
      this.dirtyEntries.add(entry);
      this.trafficDirty = true;
      detail.uploaded += bytes;
      this.uploaded += bytes;
      detail.lastTransferAt = Date.now();
      this.queueTelemetry();
    });
    torrent.on("verified", () => {
      this.dirtyEntries.add(entry);
      this.queueTelemetry();
    });
    torrent.on("error", (error) => {
      if (entry.torrent !== torrent) {
        return;
      }
      detail.error = String(error);
      if (entry.torrent === torrent) {
        entry.torrent = null;
      }
      entry.unwatch?.();
      const issue = storageFailure(
        error,
        detail.files.map((file) => file.path)
      );
      if (issue.kind !== "io-error" || (error instanceof Error && "code" in error)) {
        this.markStorageIssue(entry, issue);
      } else {
        this.save(entry);
      }
    });
    torrent.on("ready", () => {
      entry.metadata = Buffer.from(torrent.torrentFile).toString("base64");
      this.details(entry);
      if (!options?.checking) {
        const invalid = detail.files.filter(
          (file) =>
            file.priority !== "skip" && (file.downloaded ?? 0) < (expected.get(file.path) ?? 0)
        );
        if (invalid.length) {
          torrent.pause();
          void this.serial(entry, () =>
            this.blockStorage(entry, {
              detectedAt: Date.now(),
              kind: "modified-files",
              message:
                "Previously downloaded pieces are missing or invalid. Repair the download to continue.",
              paths: invalid.map((file) => file.path),
            })
          ).catch(() => undefined);
          return;
        }
        this.selectFiles(entry);
      }
      this.save(entry);
    });
    torrent.on("done", () => {
      detail.completedAt ??= Date.now();
      this.details(entry);
      this.save(entry);
      // Record completed file identities independently of periodic storage validation.
      void this.serial(entry, async () => {
        const identities = new Map(entry.storageFiles.map((file) => [file.path, file]));
        for (const file of detail.files) {
          if (file.progress !== 1) {
            continue;
          }
          // biome-ignore lint/performance/noAwaitInLoops: bound filesystem work within a torrent.
          const stored = await storedFile(this.storagePath(detail.savePath, file.path));
          if (stored) {
            identities.set(file.path, {
              complete: true,
              dev: stored.dev,
              ino: stored.ino,
              mtimeMs: stored.mtimeMs,
              path: file.path,
              size: stored.size,
            });
          }
        }
        entry.storageFiles = [...identities.values()];
      }).catch(console.error);
    });
    entry.unwatch = watchTrackers(torrent, detail.trackers);
  }

  private async stop(entry: Entry) {
    const { torrent } = entry;
    if (!torrent) {
      return;
    }
    this.details(entry);
    entry.unwatch?.();
    this.connections.detach(torrent);
    entry.torrent = null;
    if (await this.client.get(entry.detail.id)) {
      await new Promise<void>((resolve, reject) =>
        this.client.remove(torrent.infoHash, { destroyStore: false }, (error) =>
          error ? reject(error) : resolve()
        )
      );
    }
  }

  private serial(entry: Entry, action: () => Promise<void>, options?: { checkpoint: boolean }) {
    if (entry.moving) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "This torrent's files are being moved. Try again afterward."
      );
    }
    const next = entry.operation
      .catch(() => undefined)
      .then(async () => {
        if (this.entries.get(entry.detail.id) !== entry) {
          throw new (HTTPError.id("NOT_FOUND", 404))("Torrent not found");
        }
        await action();
        if (this.entries.get(entry.detail.id) === entry) {
          if (options?.checkpoint) {
            this.dirtyEntries.add(entry);
          } else {
            this.save(entry);
          }
        }
      });
    entry.operation = next;
    return next;
  }

  async pause(id: string) {
    const entry = this.get(id);
    await this.serial(entry, async () => {
      entry.paused = true;
      await this.stop(entry);
    });
    return { ok: true };
  }

  async resume(id: string) {
    const entry = this.get(id);
    await this.serial(entry, async () => {
      await this.inspectStorage(entry);
      if (entry.detail.storageIssue) {
        throw new (HTTPError.id("CONFLICT", 409))(
          "Resolve the storage problem or repair the download before resuming"
        );
      }
      entry.paused = false;
      if (!entry.torrent) {
        await this.start(entry);
      }
    });
    return { ok: true };
  }

  async replaceTrackers(id: string, urls: string[]) {
    const valid = trackerUrls(urls);
    const entry = this.get(id);
    await this.serial(entry, async () => {
      await this.stop(entry);
      entry.detail.trackers = valid.map(trackerStats);
      const parsed = await parseTorrent(entry.source);
      parsed.announce = valid;
      entry.source = toMagnetURI(parsed);
      entry.detail.magnet = entry.source;
      if (!entry.paused) {
        await this.start(entry);
      }
    });
    return { ok: true };
  }

  async remove(id: string, deleteFiles: boolean) {
    const entry = this.get(id);
    await this.serial(entry, async () => {
      await this.stop(entry);
      if (deleteFiles && entry.storageClaimed) {
        try {
          await storageRoot(entry.detail.savePath, entry.storageRoot);
        } catch (cause) {
          throw new (HTTPError.id("CONFLICT", 409))(
            "The original storage is unavailable. Reconnect it before deleting files, or remove the torrent while keeping its data.",
            { cause }
          );
        }
        const shared = new Set(
          [...this.entries.values()]
            .filter((other) => other !== entry && other.storageClaimed)
            .flatMap((other) =>
              other.detail.files.map((file) => this.storageKey(other.detail.savePath, file.path))
            )
        );
        const paths = entry.detail.files.map((file) => ({
          key: this.storageKey(entry.detail.savePath, file.path),
          path: this.storagePath(entry.detail.savePath, file.path),
        }));
        await Promise.all(
          paths.map(async ({ key, path }) => {
            if (!shared.has(key)) {
              await rm(path, { force: true });
            }
          })
        );
      }
      this.entries.delete(id);
      this.dirtyEntries.delete(entry);
      this.persistedEntries.delete(entry);
      this.entryStructures.delete(entry);
      this.db.delete(torrentRecords).where(eq(torrentRecords.id, id)).run();
      this.changed("state");
    });
    return { ok: true };
  }

  private selectFiles(entry: Entry) {
    const { torrent } = entry;
    if (!torrent?.ready) {
      return;
    }
    // A file's last piece may also contain the next file; finish deselection first.
    for (const file of torrent.files) {
      file.deselect();
    }
    for (const file of entry.detail.files) {
      const runtime = torrent.files[file.index];
      if (!runtime) {
        continue;
      }
      if (file.priority !== "skip") {
        runtime.select(file.priority === "high" ? 10 : 0);
      }
    }
  }

  async priority(id: string, index: number, priority: FilePriority) {
    const entry = this.get(id);
    await this.serial(entry, () => {
      const file = this.details(entry).files[index];
      if (!file) {
        throw new (HTTPError.id("NOT_FOUND", 404))("File not found");
      }
      file.priority = priority;
      this.selectFiles(entry);
      return Promise.resolve();
    });
    return { ok: true };
  }

  private assertVerification(entry: Entry) {
    if (entry.verifying || entryStatus(entry) === "checking") {
      throw new (HTTPError.id("CONFLICT", 409))(
        "Verification is already in progress for this torrent"
      );
    }
    if (!entry.metadata) {
      throw new (HTTPError.id("CONFLICT", 409))("Metadata must be available before verification");
    }
  }

  private async verifyData(entry: Entry) {
    try {
      entry.storageRoot = await storageRoot(entry.detail.savePath, entry.storageRoot);
      for (const file of entry.detail.files) {
        const path = this.storagePath(entry.detail.savePath, file.path);
        if (file.priority !== "skip") {
          // biome-ignore lint/performance/noAwaitInLoops: preflight access before the engine can treat read failures as missing pieces.
          await storedFile(path);
        }
      }
    } catch (cause) {
      const issue = storageFailure(
        cause,
        entry.detail.files.map((file) => file.path)
      );
      await this.blockStorage(entry, issue);
      throw new (HTTPError.id("CONFLICT", 409))(issue.message, { cause });
    }
    await this.stop(entry);
    await this.start(entry, { checking: true });
    const { torrent } = entry;
    if (!torrent) {
      throw new (HTTPError.id("INTERNAL_SERVER_ERROR", 500))("Unable to verify");
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          torrent.off("error", failed);
          torrent.off("ready", ready);
          torrent.off("close", closed);
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(
            new (HTTPError.id("REQUEST_TIMEOUT", 408))(
              "Verification exceeded the 60-second timeout"
            )
          );
        }, 60_000);
        const ready = () => {
          cleanup();
          resolve();
        };
        const failed = (error: Error | string) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(error));
        };
        const closed = () => {
          cleanup();
          reject(
            new (HTTPError.id("CONFLICT", 409))(
              entry.detail.error ?? "Verification stopped before completion"
            )
          );
        };
        torrent.once("ready", ready);
        torrent.once("error", failed);
        torrent.once("close", closed);
      });
      this.details(entry);
      entry.storageFiles = [];
      await this.inspectFiles(entry);
      if (entry.torrent !== torrent) {
        throw new (HTTPError.id("CONFLICT", 409))(
          entry.detail.storageIssue?.message ?? "Unable to verify storage"
        );
      }
    } catch (cause) {
      await this.stop(entry);
      entry.detail.error ??= cause instanceof Error ? cause.message : "Unable to verify storage";
      this.save(entry);
      throw cause;
    }
  }

  private async finishVerification(entry: Entry) {
    if (entry.paused || entry.detail.storageIssue) {
      await this.stop(entry);
    } else {
      this.selectFiles(entry);
      entry.torrent?.resume();
      const parsed = await parseTorrent(entry.source);
      for (const peer of parsed.peerAddresses ?? []) {
        entry.torrent?.addPeer(peer);
      }
      if (entry.torrent) {
        announce(entry.torrent);
      }
    }
  }

  private async checkedOperation(entry: Entry, action: () => Promise<void>) {
    this.assertVerification(entry);
    const operation = this.serial(entry, action);
    entry.verifying = true;
    try {
      await operation;
    } finally {
      entry.verifying = false;
    }
    return { ok: true };
  }

  verify(id: string) {
    const entry = this.get(id);
    return this.checkedOperation(entry, async () => {
      const expected = new Map(
        this.details(entry).files.map((file) => [file.path, file.downloaded ?? 0])
      );
      await this.inspectStorage(entry);
      await this.verifyData(entry);
      const invalid = entry.detail.files.filter(
        (file) =>
          file.priority !== "skip" && (file.downloaded ?? 0) < (expected.get(file.path) ?? 0)
      );
      if (invalid.length && !entry.detail.storageIssue) {
        entry.detail.storageIssue = {
          detectedAt: Date.now(),
          kind: "modified-files",
          message:
            "Previously downloaded pieces are missing or invalid. Repair the download to continue.",
          paths: invalid.map((file) => file.path),
        };
        entry.detail.error = entry.detail.storageIssue.message;
      }
      if (
        entry.detail.files
          .filter((file) => file.priority !== "skip")
          .every((file) => file.progress === 1)
      ) {
        entry.detail.storageIssue = null;
        entry.detail.error = null;
      }
      await this.finishVerification(entry);
    });
  }

  repair(id: string) {
    const entry = this.get(id);
    return this.checkedOperation(entry, async () => {
      await this.verifyData(entry);
      entry.detail.storageIssue = null;
      entry.detail.error = null;
      await this.finishVerification(entry);
    });
  }

  private assertLocation(entry: Entry, path: string) {
    for (const file of entry.detail.files) {
      this.storagePath(path, file.path);
      const key = this.storageKey(path, file.path);
      if (
        [...this.entries.values()].some(
          (other) =>
            other !== entry &&
            other.storageClaimed &&
            other.detail.files.some(
              (candidate) => this.storageKey(other.detail.savePath, candidate.path) === key
            )
        )
      ) {
        throw new (HTTPError.id("CONFLICT", 409))(
          "These files are already used by another torrent. Choose another folder."
        );
      }
    }
  }

  locate(id: string, downloadPath: string) {
    const entry = this.get(id);
    if (!isAbsolute(downloadPath)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("The folder must be an absolute path");
    }
    const path = resolvePath(downloadPath);
    return this.checkedOperation(entry, async () => {
      let root: StorageIdentity;
      try {
        root = await storageRoot(path, null);
        this.assertLocation(entry, path);
      } catch (cause) {
        throw cause instanceof HTTPError
          ? cause
          : new (HTTPError.id("CONFLICT", 409))(storageFailure(cause, []).message, { cause });
      }
      await this.stop(entry);
      try {
        this.assertLocation(entry, path);
      } catch (cause) {
        if (!(entry.paused || entry.detail.storageIssue)) {
          await this.start(entry);
        }
        throw cause;
      }
      entry.detail.savePath = path;
      entry.storageRoot = root;
      entry.storageFiles = [];
      entry.storageClaimed = true;
      await this.verifyData(entry);
      if (
        entry.detail.files
          .filter((file) => file.priority !== "skip")
          .every((file) => file.progress === 1)
      ) {
        entry.detail.storageIssue = null;
        entry.detail.error = null;
      } else {
        entry.detail.storageIssue = {
          detectedAt: Date.now(),
          kind: "modified-files",
          message:
            "Some selected data is missing or invalid in this folder. Repair the download to continue.",
          paths: entry.detail.files
            .filter((file) => file.priority !== "skip" && file.progress !== 1)
            .map((file) => file.path),
        };
        entry.detail.error = entry.detail.storageIssue.message;
      }
      await this.finishVerification(entry);
    });
  }

  addPeer(id: string, peer: string) {
    const entry = this.get(id);
    if (!entry.torrent || entry.paused) {
      throw new (HTTPError.id("CONFLICT", 409))("Resume the torrent before adding a peer");
    }
    if (
      entry.torrent.ready &&
      entry.torrent.done &&
      this.settings.seedingConnectionMode === "incoming-only"
    ) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "Switch seeding connections to Balanced before adding an outgoing peer to a completed torrent"
      );
    }
    let address: URL;
    try {
      address = new URL(`tcp://${peer}`);
    } catch (cause) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Invalid address, use IP:port", { cause });
    }
    if (!(address.hostname && address.port) || Number(address.port) < 1) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("Invalid address, use IP:port");
    }
    if (!entry.torrent.addPeer(peer, "manual")) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("This peer is invalid or already connected");
    }
    return parseTorrent(entry.source).then((parsed) => {
      parsed.peerAddresses = [...new Set([...(parsed.peerAddresses ?? []), peer])];
      entry.source = toMagnetURI(parsed);
      entry.detail.magnet = entry.source;
      this.save(entry);
      return { ok: true };
    });
  }

  async updateSettings(settings: SettingsInput) {
    if (settings.downloadPath !== undefined && !isAbsolute(settings.downloadPath)) {
      throw new (HTTPError.id("BAD_REQUEST", 400))("The folder must be an absolute path");
    }
    const destination = this.destinations.get("default");
    if (destination && settings.downloadPath !== undefined) {
      await this.saveDestination("default", {
        downloadPath: settings.downloadPath,
        moveFiles: settings.moveFiles,
        name: destination.name,
      });
    }
    Object.assign(this.settings, {
      deleteTorrentFileAfterAdd:
        settings.deleteTorrentFileAfterAdd ?? this.settings.deleteTorrentFileAfterAdd,
      downloadLimit: settings.downloadLimit ?? this.settings.downloadLimit,
      downloadPath:
        settings.downloadPath === undefined
          ? this.settings.downloadPath
          : resolvePath(settings.downloadPath),
      runInBackground: settings.runInBackground ?? this.settings.runInBackground,
      seedingConnectionMode: settings.seedingConnectionMode ?? this.settings.seedingConnectionMode,
      theme: settings.theme ?? this.settings.theme,
      uploadLimit: settings.uploadLimit ?? this.settings.uploadLimit,
    });
    this.client.throttleDownload(this.settings.downloadLimit);
    this.client.throttleUpload(this.settings.uploadLimit);
    this.connections.setSeedingMode(this.settings.seedingConnectionMode);
    this.client.seedOutgoingConnections = this.settings.seedingConnectionMode === "balanced";
    this.config("settings", this.settings);
    await this.diskSpace();
    return this.settings;
  }

  reannounce(id: string) {
    const entry = this.get(id);
    if (!entry.torrent || entry.paused) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "Resume the torrent before refreshing its trackers"
      );
    }
    if (!announce(entry.torrent)) {
      throw new (HTTPError.id("CONFLICT", 409))("The tracker connection is not ready yet");
    }
    for (const row of entry.detail.trackers) {
      row.status = "announcing";
    }
    return { ok: true };
  }

  get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) {
      throw new (HTTPError.id("NOT_FOUND", 404))("Torrent not found");
    }
    return entry;
  }

  private summary(entry: Entry): TorrentDetail {
    const { torrent, detail } = entry;
    detail.status = entryStatus(entry);
    detail.downloadSpeed = torrent?.downloadSpeed ?? 0;
    detail.uploadSpeed = torrent?.uploadSpeed ?? 0;
    detail.peers = torrent?.numPeers ?? 0;
    if (torrent?.ready) {
      detail.name = torrent.name;
      detail.length = torrent.length;
      detail.downloaded = torrent.downloaded;
      detail.progress = detail.length > 0 ? detail.downloaded / detail.length : 0;
      detail.eta =
        detail.downloadSpeed > 0
          ? (detail.length - detail.downloaded) / detail.downloadSpeed
          : null;
      detail.seeds = torrent.wires.filter(
        (wire) => (wire as typeof wire & { isSeeder?: boolean }).isSeeder
      ).length;
    }
    const seeds = detail.trackers.flatMap((row) => (row.seeds === null ? [] : [row.seeds]));
    const leeches = detail.trackers.flatMap((row) => (row.leeches === null ? [] : [row.leeches]));
    detail.swarmSeeds = seeds.length ? Math.max(...seeds) : null;
    detail.swarmPeers = leeches.length ? Math.max(...leeches) : null;
    if (!torrent) {
      detail.peerList = [];
      detail.seeds = 0;
      detail.eta = null;
    }
    if (entry.paused) {
      for (const row of detail.trackers) {
        row.status = "paused";
      }
    }
    detail.ratio =
      detail.downloaded !== null && detail.downloaded > 0
        ? detail.uploaded / detail.downloaded
        : null;
    return detail;
  }

  private details(entry: Entry): TorrentDetail {
    const detail = this.summary(entry);
    const { torrent } = entry;
    if (torrent?.ready) {
      detail.comment = torrent.comment || "";
      detail.createdBy = torrent.createdBy || "";
      detail.pieceLength = torrent.pieceLength;
      detail.pieces = torrent.pieces.length;
      const pieces = torrent.pieces as (Torrent["pieces"][number] | null)[];
      detail.verifiedPieces = pieces.filter((piece) => piece === null).length;
      detail.pieceMap = Array.from({ length: Math.min(100, torrent.pieces.length) }, (_, bin) => {
        const from = Math.floor(
          (bin * torrent.pieces.length) / Math.min(100, torrent.pieces.length)
        );
        const to = Math.floor(
          ((bin + 1) * torrent.pieces.length) / Math.min(100, torrent.pieces.length)
        );
        let verified = 0;
        for (let index = from; index < to; index += 1) {
          if (torrent.pieces[index] === null) {
            verified += 1;
          }
        }
        return verified / (to - from);
      });
      const priorities = new Map(
        detail.files.map((file) => [canonicalPath(file.path), file.priority])
      );
      detail.files = torrent.files.map((file, index) => {
        const downloaded = verifiedFileBytes(torrent, file);
        return {
          downloaded,
          index,
          length: file.length,
          name: file.name,
          path: canonicalPath(file.path),
          priority: priorities.get(canonicalPath(file.path)) ?? "normal",
          progress: file.length ? downloaded / file.length : 1,
        };
      });
      detail.peerList = peers(torrent);
      detail.seeds = detail.peerList.filter((peer) => peer.progress === 1).length;
    }
    return detail;
  }

  detail(id: string) {
    return this.details(this.get(id));
  }

  snapshot(selected: string | null, includeDetail?: boolean): DashboardState {
    const entries = [...this.entries.values()];
    const details = entries.map((entry) => this.summary(entry));
    const chosen = selected ? this.entries.get(selected) : entries[0];
    return {
      destinations: [...this.destinations.values()],
      detail: includeDetail !== false && chosen ? this.details(chosen) : null,
      history: [...this.history],
      session: {
        active: details.filter((detail) => !["paused", "error"].includes(detail.status)).length,
        dhtNodes:
          (this.client.dht as { nodes?: { count: () => number } } | null)?.nodes?.count() ?? 0,
        downloadSpeed: this.client.downloadSpeed,
        engine: WebTorrent.VERSION,
        freeSpace: this.freeSpace,
        mode: this.mode,
        peers: details.reduce((sum, detail) => sum + detail.peers, 0),
        port: this.client.torrentPort,
        received: this.received,
        startedAt: this.startedAt,
        uploaded: this.uploaded,
        uploadSpeed: this.client.uploadSpeed,
      },
      settings: this.settings,
      torrents: details.map(
        ({
          savePath,
          magnet,
          comment,
          createdBy,
          private: isPrivate,
          pieceLength,
          pieces,
          verifiedPieces,
          pieceMap,
          activeSeconds,
          seedSeconds,
          lastTransferAt,
          files,
          trackers,
          peerList,
          ...summary
        }) => summary
      ),
    };
  }

  async file(id: string, index: number) {
    const entry = this.get(id);
    if (!(entry.verifying || entry.moving)) {
      await this.serial(entry, () => this.inspectStorage(entry));
    }
    const detail = this.details(entry);
    if (detail.status === "checking" || entry.verifying) {
      throw new (HTTPError.id("CONFLICT", 409))(
        "Files are being verified. Try again after verification completes."
      );
    }
    if (entry.moving) {
      throw new (HTTPError.id("CONFLICT", 409))("Files are being moved. Try again afterward.");
    }
    const file = detail.files[index];
    if (!file) {
      throw new (HTTPError.id("NOT_FOUND", 404))("File not found");
    }
    if (detail.storageIssue?.paths.includes(file.path)) {
      throw new (HTTPError.id(
        detail.storageIssue.kind === "missing-files" ? "NOT_FOUND" : "CONFLICT",
        detail.storageIssue.kind === "missing-files" ? 404 : 409
      ))(
        detail.storageIssue.kind === "missing-files"
          ? `The downloaded file is no longer present : ${file.path}`
          : detail.storageIssue.message
      );
    }
    if (file.progress !== 1) {
      throw new (HTTPError.id("CONFLICT", 409))("This file has not finished downloading");
    }
    const path = this.storagePath(detail.savePath, file.path);
    if (!(await Bun.file(path).exists())) {
      throw new (HTTPError.id("NOT_FOUND", 404))(
        `The downloaded file is no longer present : ${path}`
      );
    }
    return { name: file.name, path };
  }

  async close() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: lifecycle state changes between public close calls.
    if (this.closed) {
      return;
    }
    this.closed = true;
    try {
      clearInterval(this.timer);
      if (this.telemetryTimer) {
        clearTimeout(this.telemetryTimer);
      }
      this.connections.close();
      this.listeners.clear();
      await this.diskCheck;
      await this.storageCheck;
      await this.destinationOperation?.catch(() => undefined);
      await Promise.all(
        [...this.entries.values()].map((entry) => entry.operation.catch(() => undefined))
      );
      for (const entry of this.entries.values()) {
        this.details(entry);
        entry.unwatch?.();
      }
      if (!this.client.destroyed) {
        await new Promise<void>((resolve) => this.client.destroy(() => resolve()));
      }
      for (const entry of this.entries.values()) {
        this.save(entry);
      }
      this.config("traffic", { received: this.received, uploaded: this.uploaded });
      this.db.$client.close(true);
    } finally {
      this.cryptoDiagnostics?.close();
    }
  }
}
