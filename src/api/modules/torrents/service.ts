import { once } from "node:events";
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
import { eq, sql } from "drizzle-orm";
import { ElysiaStatus, problem } from "elysia";
import { createLogger } from "evlog";
import parseTorrent, { toMagnetURI } from "parse-torrent";
import type { Options as TorrentNetworkOptions } from "webtorrent";
import WebTorrent, { type Options, type Torrent } from "webtorrent";
import {
  operationReceipts,
  torrentConfig,
  torrentDestinations,
  torrentRecords,
} from "../../../db/schema";
import { type DatabaseConnection, openDatabase, type TofuDatabase } from "../../lib/db";
import { sanitizeLog } from "../../lib/diagnostics";
import type { Destination, DestinationInput, DestinationPresentation } from "../destinations/model";
import type { Settings, SettingsInput } from "../settings/model";
import type { ConnectionPolicy } from "./connections";
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
import type {
  DashboardState,
  EngineChange,
  FilePriority,
  FileStats,
  SpeedSample,
  TorrentDetail,
  TorrentStorageIssue,
  TrackerStats,
} from "./types";
import type { WorkerTorrentEngine } from "./worker-client";

interface RelocatedFile {
  source: string;
  staged: string;
  target: string;
}

function canonicalPath(filePath: string) {
  return filePath.replaceAll("\\", "/");
}

async function storedFile(path: string) {
  let stored: Awaited<ReturnType<typeof lstat>>;
  try {
    stored = await lstat(path);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  }
  if (stored?.isFile()) {
    await access(path, constants.R_OK);
  }
  return stored;
}

function moveError(cause: unknown) {
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
  return problem(409, { detail: `${message}. The original files are preserved.` });
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
  validateRetained?: boolean;
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
  const values = [...new Set(urls.map((value) => value.trim()).filter(Boolean))];
  for (const value of values) {
    const url = URL.parse(value);
    if (!(url && trackerProtocols.has(url.protocol))) {
      return problem(400, {
        detail: "Trackers must use valid HTTP, HTTPS, UDP, or WebSocket URLs",
      });
    }
  }
  return values;
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
  private readonly entries = new Map<string, Entry>();
  private readonly ranges = new Map<string, { id: string; controller: AbortController }>();
  // The window played next in each file, kept between the player's requests.
  private readonly readAhead = new Map<
    string,
    { id: string; release: () => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly destinations = new Map<string, Destination>();
  private readonly movingDestinations = new Set<string>();
  private destinationOperation: ReturnType<TorrentEngine["moveDestination"]> | null = null;
  private readonly startedAt = Date.now();
  private readonly db: TofuDatabase;
  private readonly dataDir: string;
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
    cryptoDiagnostics: ReturnType<typeof installCryptoDiagnostics> | null,
    dataDir: string
  ) {
    this.db = database;
    this.dataDir = dataDir;
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
        autoAddTorrentFilesSince: null,
        deleteTorrentFileAfterAdd: null,
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
    this.client.on("error", (error) => {
      const log = createLogger({
        component: "torrent-engine",
        dataDir: this.dataDir,
        error: sanitizeLog(error),
        operation: "client",
      });
      log.setLevel("error");
      log.emit();
    });
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
      const pending = Promise.withResolvers<void>();
      this.storageCheck = pending.promise;
      const check = async () => {
        try {
          await this.checkStorage();
        } catch (error) {
          const log = createLogger({
            component: "storage",
            error: sanitizeLog(error),
            operation: "check",
          });
          log.setLevel("error");
          log.emit();
        } finally {
          this.storageCheck = null;
          pending.resolve();
        }
      };
      void check();
    }
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep validation, state changes, and cleanup in the same lifecycle operation.
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
        cryptoDiagnostics,
        options.dataDir
      );
    } catch (error) {
      cryptoDiagnostics?.close();
      database.$client.close(true);
      throw error;
    }
    try {
      // Reconcile receipts before a restored torrent may resume writing to storage.
      for (const receipt of database
        .select()
        .from(operationReceipts)
        .where(eq(operationReceipts.status, "pending"))
        .all()) {
        if (receipt.kind === "move") {
          // biome-ignore lint/performance/noAwaitInLoops: Filesystem recovery precedes all torrent starts.
          const recovered = await engine.finishMoveJournal(receipt.id);
          if (recovered instanceof ElysiaStatus) {
            throw new Error(recovered.response.detail);
          }
        } else if (receipt.kind === "add") {
          database
            .update(operationReceipts)
            .set({
              completedAt: Date.now(),
              status: engine.entries.has(receipt.target) ? "done" : "failed",
            })
            .where(eq(operationReceipts.id, receipt.id))
            .run();
        } else if (receipt.kind === "remove") {
          if (engine.entries.has(receipt.target)) {
            const removed = await engine.remove(
              receipt.target,
              JSON.parse(receipt.result ?? "{}").deleteFiles === true,
              receipt.id
            );
            if (removed instanceof ElysiaStatus) {
              throw new Error(removed.response.detail);
            }
          } else {
            database
              .update(operationReceipts)
              .set({
                completedAt: Date.now(),
                result: JSON.stringify({
                  deleteFiles: JSON.parse(receipt.result ?? "{}").deleteFiles === true,
                  ok: true,
                }),
                status: "done",
              })
              .where(eq(operationReceipts.id, receipt.id))
              .run();
          }
        }
      }
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
      try {
        await engine.close();
      } catch {
        /* The startup failure remains primary. */
      }
      throw error;
    }
  }

  assertReady() {
    if (this.client.destroyed) {
      return problem(503, { detail: "The torrent engine has stopped" });
    }
    this.db.run(sql`SELECT 1 FROM config, torrents, destinations LIMIT 0`);
  }

  private checkpoint() {
    const saved = new Map<Entry, string>();
    this.db.transaction((tx) => {
      for (const entry of this.dirtyEntries) {
        saved.set(entry, this.save(entry, tx));
      }
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Event handlers and lifecycle cleanup can change this state between calls or awaits.
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
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Event handlers and lifecycle cleanup can change this state between calls or awaits.
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
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Event handlers and lifecycle cleanup can change this state between calls or awaits.
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
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Event handlers and lifecycle cleanup can change this state between calls or awaits.
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
      const pending = Promise.withResolvers<void>();
      this.diskCheck = pending.promise;
      const check = async () => {
        try {
          const disk = await statfs(this.settings.downloadPath);
          this.freeSpace = disk.bavail * disk.bsize;
        } catch {
          this.freeSpace = null;
        } finally {
          this.diskCheck = null;
          pending.resolve();
        }
      };
      void check();
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
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Event handlers and lifecycle cleanup can change this state between calls or awaits.
      if (this.closed) {
        return;
      }
      if (!(entry.metadata && entry.storageClaimed) || entry.moving || entry.verifying) {
        continue;
      }
      // Serialize filesystem checks with pause, removal, and other lifecycle operations.
      try {
        // biome-ignore lint/performance/noAwaitInLoops: Each iteration depends on the previous lifecycle or readiness result.
        await this.serial(entry, () => this.inspectStorage(entry), { checkpoint: true });
      } catch (error) {
        const log = createLogger({
          component: "storage",
          error: sanitizeLog(error),
          operation: "inspect",
        });
        log.setLevel("error");
        log.emit();
      }
    }
  }

  private async inspectStorage(entry: Entry) {
    if (entry.detail.storageIssue && entry.detail.storageIssue.kind !== "storage-unavailable") {
      return;
    }
    const detail = this.details(entry);
    try {
      const root = await storageRoot(detail.savePath, null);
      const recovered = await this.recoverStorage(entry, root);
      if (recovered instanceof ElysiaStatus) {
        return recovered;
      }
      if (recovered) {
        return;
      }
      if (detail.storageIssue) {
        return;
      }
      if (
        entry.storageRoot &&
        (entry.storageRoot.dev !== root.dev || entry.storageRoot.ino !== root.ino)
      ) {
        await storageRoot(detail.savePath, entry.storageRoot);
      }
      entry.storageRoot = root;
      if (entry.validateRetained) {
        return;
      }
      const inspected = await this.inspectFiles(entry);
      if (inspected instanceof ElysiaStatus) {
        await this.blockStorage(entry, {
          detectedAt: Date.now(),
          kind: "invalid-path",
          message: inspected.response.detail,
          paths: entry.detail.files.map((file) => file.path),
        });
        return inspected;
      }
    } catch (cause) {
      if (
        detail.storageIssue?.kind === "storage-unavailable" &&
        cause instanceof Error &&
        "code" in cause &&
        ["ENOENT", "ENODEV", "EIO"].includes(String(cause.code))
      ) {
        return;
      }
      await this.blockStorage(
        entry,
        storageFailure(
          cause,
          detail.files.map((file) => file.path),
          {
            dataDir: this.dataDir,
            expected: entry.storageRoot,
            savePath: detail.savePath,
            torrentId: detail.id,
          }
        )
      );
    }
  }

  private async recoverStorage(entry: Entry, root: StorageIdentity) {
    const previous = entry.storageRoot;
    if (
      !previous ||
      previous.dev === root.dev ||
      previous.ino !== root.ino ||
      !previous.canonicalPath ||
      previous.canonicalPath !== root.canonicalPath ||
      !entry.metadata ||
      !entry.storageClaimed
    ) {
      return false;
    }
    const files = entry.detail.files.filter((file) => file.priority !== "skip");
    const identities = new Map(entry.storageFiles.map((file) => [file.path, file]));
    if (!files.length) {
      return false;
    }
    const expected = new Map<string, number>();
    for (const file of files) {
      const before = identities.get(file.path);
      const path = this.storagePath(entry.detail.savePath, file.path);
      if (path instanceof ElysiaStatus) {
        return path;
      }
      // biome-ignore lint/performance/noAwaitInLoops: Validate each file before rebinding storage.
      const stored = await storedFile(path);
      if (
        !(before && stored?.isFile()) ||
        stored.dev !== root.dev ||
        stored.ino !== before.ino ||
        stored.size !== before.size ||
        stored.mtimeMs !== before.mtimeMs ||
        (file.downloaded === null && !before.complete)
      ) {
        return false;
      }
      expected.set(file.path, file.downloaded ?? (before.complete ? file.length : 0));
    }
    const { verifying } = entry;
    entry.verifying = true;
    try {
      await this.stop(entry);
      entry.storageRoot = root;
      entry.storageFiles = entry.storageFiles.map((file) => ({ ...file, dev: root.dev }));
      // Hash existing pieces with networking paused before accepting the new device identity.
      await this.verifyData(entry);
      const invalid = entry.detail.files.filter(
        (file) => (file.downloaded ?? 0) < (expected.get(file.path) ?? 0)
      );
      if (invalid.length) {
        await this.blockStorage(entry, {
          detectedAt: Date.now(),
          kind: "modified-files",
          message:
            "Previously downloaded pieces are missing or invalid. Repair the download to continue.",
          paths: invalid.map((file) => file.path),
        });
      } else {
        entry.detail.storageIssue = null;
        entry.detail.error = null;
        await this.finishVerification(entry);
        const log = createLogger({
          component: "storage",
          context: { previous, root, savePath: entry.detail.savePath, torrentId: entry.detail.id },
          dataDir: this.dataDir,
          operation: "recovered",
        });
        log.emit();
      }
    } finally {
      entry.verifying = verifying;
    }
    return true;
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
      const path = this.storagePath(detail.savePath, file.path);
      if (path instanceof ElysiaStatus) {
        return path;
      }
      // biome-ignore lint/performance/noAwaitInLoops: bound filesystem work within a torrent.
      const stored = await storedFile(path);
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
    const log = createLogger({
      component: "storage",
      context: {
        expected: entry.storageRoot,
        issue,
        savePath: entry.detail.savePath,
        torrentId: entry.detail.id,
      },
      dataDir: this.dataDir,
      operation: "blocked",
    });
    log.setLevel("warn");
    log.emit();
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
        autoAddTorrentFilesSince: null,
        deleteTorrentFileAfterAdd: null,
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
        return problem(409, {
          detail: storageFailure(cause, [], {
            dataDir: this.dataDir,
            expected: bound.storageRoot,
            savePath: path,
          }).message,
        });
      }
    } else {
      await mkdir(path, { recursive: true });
    }
  }

  /** Resolves how a thread handles .torrent files, keeping each folder watched by one thread. */
  private torrentFileOptions(id: string | null, input: DestinationInput, downloadPath: string) {
    const current = id ? this.destinations.get(id) : undefined;
    let autoAddTorrentFilesSince = current?.autoAddTorrentFilesSince ?? null;
    if (input.autoAddTorrentFiles !== undefined) {
      autoAddTorrentFilesSince = input.autoAddTorrentFiles
        ? (autoAddTorrentFilesSince ?? Date.now())
        : null;
    }
    if (
      autoAddTorrentFilesSince !== null &&
      [...this.destinations.values()].some(
        (other) =>
          other.id !== id &&
          other.autoAddTorrentFilesSince !== null &&
          other.downloadPath === downloadPath
      )
    ) {
      return problem(409, {
        detail: "Another thread already adds .torrent files from this folder",
      });
    }
    return {
      autoAddTorrentFilesSince,
      deleteTorrentFileAfterAdd:
        input.deleteTorrentFileAfterAdd === undefined
          ? (current?.deleteTorrentFileAfterAdd ?? null)
          : input.deleteTorrentFileAfterAdd,
    };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep validation, state changes, and cleanup in the same lifecycle operation.
  async saveDestination(id: string | null, input: DestinationInput) {
    const name = input.name.trim();
    if (!(name && isAbsolute(input.downloadPath))) {
      return problem(400, { detail: "Enter a name and an absolute folder path" });
    }
    if (id && !this.destinations.has(id)) {
      return problem(404, { detail: "Tab not found" });
    }
    if (this.movingDestinations.size > 0) {
      return problem(409, { detail: "A move is already in progress for this tab" });
    }
    const downloadPath = resolvePath(input.downloadPath);
    const fileOptions = this.torrentFileOptions(id, input, downloadPath);
    if (fileOptions instanceof ElysiaStatus) {
      return fileOptions;
    }
    const { autoAddTorrentFilesSince, deleteTorrentFileAfterAdd } = fileOptions;
    if (id && input.moveFiles) {
      const previous = this.destinations.get(id);
      const destination: Destination = {
        autoAddTorrentFilesSince,
        deleteTorrentFileAfterAdd,
        downloadPath,
        icon: input.icon ?? previous?.icon ?? "folder",
        id,
        name,
        pinned: input.pinned ?? previous?.pinned ?? false,
      };
      const operation = this.moveDestination(destination);
      this.destinationOperation = operation;
      try {
        const result = await operation;
        if (result instanceof ElysiaStatus) {
          return result;
        }
      } finally {
        this.destinationOperation = null;
      }
      return destination;
    }
    const validationResult0 = await this.prepareDestination(downloadPath);
    if (validationResult0 instanceof ElysiaStatus) {
      return validationResult0;
    }
    if (id && !this.destinations.has(id)) {
      return problem(404, { detail: "Tab not found" });
    }
    if (this.movingDestinations.size > 0) {
      return problem(409, { detail: "A move is already in progress for this tab" });
    }
    const previous = id ? this.destinations.get(id) : undefined;
    const destination = this.storeDestination({
      autoAddTorrentFilesSince,
      deleteTorrentFileAfterAdd,
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
      return problem(404, { detail: "Tab not found" });
    }
    if (this.movingDestinations.size > 0) {
      return problem(409, { detail: "Wait for the move to finish before editing a tab" });
    }
    return this.storeDestination({
      ...destination,
      icon: input.icon ?? destination.icon,
      pinned: input.pinned ?? destination.pinned,
    });
  }

  async removeDestination(id: string) {
    if (!this.destinations.has(id)) {
      return problem(404, { detail: "Tab not found" });
    }
    if (this.movingDestinations.size > 0) {
      return problem(409, { detail: "Wait for the move to finish before deleting a tab" });
    }
    // Torrents, rules and preferences fall back to the "default" ID, so deleting that tab moves
    // the next tab into the default slot and removes the next tab's former ID instead.
    const removed =
      id === "default" ? [...this.destinations.keys()].find((key) => key !== "default") : id;
    const successor = removed === undefined ? undefined : this.destinations.get(removed);
    if (!(removed && successor)) {
      return problem(409, { detail: "At least one tab is required" });
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep validation, state changes, and cleanup in the same lifecycle operation.
  private async moveDestination(destination: Destination) {
    const { id, downloadPath } = destination;
    const entries = [...this.entries.values()].filter(
      (entry) =>
        entry.detail.destinationId === id && resolvePath(entry.detail.savePath) !== downloadPath
    );
    const validationResult1 = this.validateMove(entries);
    if (validationResult1 instanceof ElysiaStatus) {
      return validationResult1;
    }
    this.movingDestinations.add(id);
    for (const entry of entries) {
      entry.moving = true;
      this.cancelRanges(entry.detail.id);
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
    let journalId: string | null = null;
    let committed = false;
    try {
      await Promise.allSettled(entries.map((entry) => entry.operation));
      running = entries.filter(
        (entry) => !entry.paused && this.entries.get(entry.detail.id) === entry
      );
      const validationResult2 = this.validateMove(entries);
      if (validationResult2 instanceof ElysiaStatus) {
        return validationResult2;
      }
      await Promise.all(entries.map((entry) => this.stop(entry)));
      const validationResult3 = await this.prepareDestination(downloadPath);
      if (validationResult3 instanceof ElysiaStatus) {
        return validationResult3;
      }
      staging = await mkdtemp(join(downloadPath, ".tofu-move-"));
      const planned = await this.planMove(entries, downloadPath, staging);
      if (planned instanceof ElysiaStatus) {
        return planned;
      }
      files = planned;
      const sourceIdentities = await Promise.all(
        files.map(async (file) => {
          const stats = await lstat(file.source);
          return {
            ...file,
            dev: stats.dev,
            ino: stats.ino,
            mtimeMs: stats.mtimeMs,
            size: stats.size,
          };
        })
      );
      journalId = `move:${crypto.randomUUID()}`;
      const journal = { committed: false, files: sourceIdentities, staging };
      this.db
        .insert(operationReceipts)
        .values({
          createdAt: Date.now(),
          id: journalId,
          kind: "move",
          result: JSON.stringify(journal),
          status: "pending",
          target: id,
        })
        .run();
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
        tx.update(operationReceipts)
          .set({ result: JSON.stringify({ ...journal, committed: true }) })
          .where(eq(operationReceipts.id, journalId as string))
          .run();
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
      const cleanup = await this.finishMoveJournal(journalId);
      if (cleanup instanceof ElysiaStatus) {
        return cleanup;
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
        if (journalId) {
          const rollback = await this.finishMoveJournal(journalId);
          if (rollback instanceof ElysiaStatus) {
            return rollback;
          }
        }
      }
      return moveError(cause);
    } finally {
      try {
        if (staging && !journalId) {
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

  /** Reconcile a persisted move using inode ownership before removing any old or published copy. */
  private async finishMoveJournal(id: string) {
    const receipt = this.db
      .select()
      .from(operationReceipts)
      .where(eq(operationReceipts.id, id))
      .get();
    if (receipt?.status !== "pending") {
      return;
    }
    const journal = JSON.parse(receipt.result ?? "{}") as {
      committed: boolean;
      staging: string;
      files: (RelocatedFile & { dev: number; ino: number; size: number; mtimeMs: number })[];
    };
    const results = await Promise.all(
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep filesystem identity checks and recovery decisions in the same operation.
      journal.files.map(async (file) => {
        const path = journal.committed ? file.source : file.target;
        let current: Awaited<ReturnType<typeof lstat>>;
        try {
          current = await lstat(path);
        } catch (cause) {
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
            return;
          }
          throw cause;
        }
        if (journal.committed) {
          if (
            current.dev !== file.dev ||
            current.ino !== file.ino ||
            current.size !== file.size ||
            current.mtimeMs !== file.mtimeMs
          ) {
            return problem(409, {
              detail:
                "Files moved successfully, but an old source changed. It was preserved for owner review.",
            });
          }
        } else {
          let staged: Awaited<ReturnType<typeof lstat>>;
          try {
            staged = await lstat(file.staged);
          } catch (cause) {
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
              return;
            }
            throw cause;
          }
          if (current.dev !== staged.dev || current.ino !== staged.ino) {
            return;
          }
        }
        await rm(path);
      })
    );
    await rm(journal.staging, { force: true, recursive: true });
    this.db
      .update(operationReceipts)
      .set({ completedAt: Date.now(), status: journal.committed ? "done" : "failed" })
      .where(eq(operationReceipts.id, id))
      .run();
    return results.find((result) => result instanceof ElysiaStatus);
  }

  private validateMove(entries: Entry[]) {
    for (const entry of entries) {
      if (this.entries.get(entry.detail.id) !== entry) {
        return problem(404, { detail: "Torrent not found" });
      }
      const status = entryStatus(entry);
      if (
        status === "checking" ||
        entry.verifying ||
        (entry.torrent?.metadata && !entry.torrent.ready)
      ) {
        return problem(409, {
          detail: `${entry.detail.name} is being verified. Try again after verification completes.`,
        });
      }
      if (!entry.metadata || status === "metadata") {
        return problem(409, {
          detail: `The metadata for ${entry.detail.name} is not available yet.`,
        });
      }
      if (entry.detail.error) {
        return problem(409, {
          detail: `Unable to move ${entry.detail.name} : ${entry.detail.error}`,
        });
      }
    }
  }

  private storageReservations(excluded: Set<Entry>) {
    const reserved = new Set<string>();
    for (const entry of this.entries.values()) {
      if (excluded.has(entry) || !entry.storageClaimed) {
        continue;
      }
      for (const file of entry.detail.files) {
        const key = this.storageKey(entry.detail.savePath, file.path);
        if (key instanceof ElysiaStatus) {
          return key;
        }
        reserved.add(key);
      }
    }
    return reserved;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep filesystem identity checks and recovery decisions in the same operation.
  private async planMove(entries: Entry[], downloadPath: string, staging: string) {
    const reserved = this.storageReservations(new Set(entries));
    if (reserved instanceof ElysiaStatus) {
      return reserved;
    }
    const planned: {
      file: FileStats;
      source: string;
      target: string;
      sourceKey: string;
      targetKey: string;
    }[] = [];
    for (const entry of entries) {
      for (const file of entry.detail.files) {
        const source = this.storagePath(entry.detail.savePath, file.path);
        if (source instanceof ElysiaStatus) {
          return source;
        }
        const sourceKey = this.storageKey(entry.detail.savePath, file.path);
        if (sourceKey instanceof ElysiaStatus) {
          return sourceKey;
        }
        const target = this.storagePath(downloadPath, file.path);
        if (target instanceof ElysiaStatus) {
          return target;
        }
        const targetKey = this.storageKey(downloadPath, file.path);
        if (targetKey instanceof ElysiaStatus) {
          return targetKey;
        }
        planned.push({ file, source, sourceKey, target, targetKey });
      }
    }
    const sources = new Set(planned.map((item) => item.sourceKey));
    const targets = new Set<string>();
    for (const item of planned) {
      if (
        reserved.has(item.sourceKey) ||
        reserved.has(item.targetKey) ||
        targets.has(item.targetKey) ||
        sources.has(item.targetKey)
      ) {
        return problem(409, {
          detail: `The file ${item.file.path} is already used by another torrent. Choose another folder.`,
        });
      }
      targets.add(item.targetKey);
    }
    const files = await Promise.all(
      planned.map(async ({ file, source, target }, index) => {
        const [existing, stored] = await Promise.all([storedFile(target), storedFile(source)]);
        if (existing) {
          return problem(409, {
            detail: `A file already exists in the destination folder : ${target}. It will not be overwritten.`,
          });
        }
        if (!stored) {
          if ((file.downloaded ?? 0) > 0 || (file.progress === 1 && file.length > 0)) {
            return problem(404, {
              detail: `The downloaded file is no longer present : ${source}. Restore it or verify the torrent before retrying.`,
            });
          }
          return null;
        }
        if (!stored.isFile()) {
          return problem(409, { detail: `This path is not a file : ${source}` });
        }
        if (stored.size < (file.downloaded ?? 0)) {
          return problem(409, {
            detail: `The downloaded file was modified or truncated : ${source}. Verify the torrent before moving it.`,
          });
        }
        return { source, staged: join(staging, String(index)), target };
      })
    );
    const resolved: RelocatedFile[] = [];
    for (const file of files) {
      if (file instanceof ElysiaStatus) {
        return file;
      }
      if (file) {
        resolved.push(file);
      }
    }
    return resolved;
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
        return problem(409, {
          detail: "Restore access to the unavailable destination before checking file ownership.",
        });
      }
      throw cause;
    }
  }

  private storagePath(savePath: string, filePath: string) {
    const path = resolvePath(savePath, filePath);
    const within = relative(savePath, path);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      return problem(400, { detail: "File path outside the download folder" });
    }
    let component = savePath;
    for (const part of within.split(sep)) {
      component = join(component, part);
      try {
        if (lstatSync(component).isSymbolicLink()) {
          return problem(409, { detail: "A symbolic link is present in the file path" });
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
      return problem(404, { detail: "Tab not found" });
    }
    const downloadPath =
      chosen?.downloadPath ?? (options.downloadPath || this.settings.downloadPath);
    if (!isAbsolute(downloadPath)) {
      return problem(400, { detail: "The download folder must be an absolute path" });
    }
    const destination = chosen ?? this.destinationForPath(downloadPath);
    if (this.movingDestinations.size > 0) {
      return problem(409, { detail: "Wait for the move to finish before adding a torrent" });
    }
    return destination;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep validation, state changes, and cleanup in the same lifecycle operation.
  async add(
    input: string | Uint8Array,
    options: {
      paused: boolean;
      destinationId?: string;
      downloadPath?: string;
      trackers?: string[];
      operationKey?: string;
    }
  ) {
    let source = input;
    if (typeof source === "string" && torrentUrl.test(source)) {
      const response = await fetch(source, { signal: AbortSignal.timeout(15_000) });
      if (!response.ok) {
        return problem(400, {
          detail: `The torrent file is inaccessible (HTTP ${response.status})`,
        });
      }
      source = new Uint8Array(await response.arrayBuffer());
      if (source.length > 8 * 1024 * 1024) {
        return problem(400, { detail: "The torrent file is too large" });
      }
    }
    let parsed: Awaited<ReturnType<typeof parseTorrent>>;
    try {
      parsed = await parseTorrent(source);
    } catch {
      return problem(400, {
        detail: "Invalid magnet link or .torrent file (BitTorrent v1 required)",
      });
    }
    const id = parsed.infoHash;
    const fingerprint = new Bun.CryptoHasher("sha256")
      .update(
        JSON.stringify({
          destinationId: options.destinationId ?? null,
          downloadPath: options.downloadPath ?? null,
          id,
          paused: options.paused,
          trackers: options.trackers ?? [],
        })
      )
      .digest("hex");
    if (options.operationKey) {
      const receipt = this.db
        .select()
        .from(operationReceipts)
        .where(eq(operationReceipts.id, options.operationKey))
        .get();
      if (
        receipt &&
        (receipt.target !== id || JSON.parse(receipt.result ?? "{}").fingerprint !== fingerprint)
      ) {
        return problem(409, {
          detail: "This operation key was used for different torrent options",
        });
      }
      if (receipt?.status === "done") {
        return { id };
      }
      if (receipt && receipt.target !== id) {
        return problem(409, { detail: "This operation key was used for another torrent" });
      }
      if (receipt?.status === "pending") {
        return problem(409, {
          detail: "This torrent operation is being reconciled. Try again shortly",
        });
      }
    }
    const trackers = trackerUrls([...parsed.announce, ...(options.trackers ?? [])]);
    if (trackers instanceof ElysiaStatus) {
      return trackers;
    }
    parsed.announce = trackers;
    const destination = this.resolveDestination(options);
    if (destination instanceof ElysiaStatus) {
      return destination;
    }
    const { downloadPath } = destination;
    const savePath = downloadPath;
    if (!this.destinations.has(destination.id)) {
      return problem(404, { detail: "Tab not found" });
    }
    if (this.movingDestinations.size > 0) {
      return problem(409, { detail: "Wait for the move to finish before adding a torrent" });
    }
    if (this.entries.has(id)) {
      return problem(409, { detail: "This torrent is already in your library" });
    }
    const validationResult4 = await this.prepareDestination(savePath);
    if (validationResult4 instanceof ElysiaStatus) {
      return validationResult4;
    }
    const root = await storageRoot(savePath, null);
    if (this.entries.has(id)) {
      return problem(409, { detail: "This torrent is already in your library" });
    }
    if (!this.destinations.has(destination.id) || this.movingDestinations.size > 0) {
      return problem(409, {
        detail: "The destination changed while adding the torrent. Try again.",
      });
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
    const retainedKey = `retained:${id}:${new Bun.CryptoHasher("sha256").update(savePath).digest("hex")}`;
    const retainedRow = this.db
      .select()
      .from(operationReceipts)
      .where(eq(operationReceipts.id, retainedKey))
      .get();
    const retained = retainedRow?.result
      ? (JSON.parse(retainedRow.result) as {
          files: StoredFileIdentity[];
          root: StorageIdentity | null;
        })
      : null;
    const entry: Entry = {
      detail,
      metadata: parsed.info ? Buffer.from(source as Uint8Array).toString("base64") : null,
      operation: Promise.resolve(),
      paused: options.paused,
      source: detail.magnet,
      storageClaimed: retained !== null,
      storageFiles: retained?.files ?? [],
      storageRoot: retained?.root ?? root,
      torrent: null,
      validateRetained: retained !== null,
    };
    try {
      for (const file of parsed.files ?? []) {
        const path = this.storagePath(savePath, file.path);
        if (path instanceof ElysiaStatus) {
          return path;
        }
        try {
          const existing = lstatSync(path);
          const owned = retained?.files.find((item) => item.path === canonicalPath(file.path));
          if (
            owned &&
            existing.dev === owned.dev &&
            existing.ino === owned.ino &&
            existing.size === owned.size &&
            existing.mtimeMs === owned.mtimeMs
          ) {
            continue;
          }
          return problem(409, {
            detail:
              "A file already exists in this folder. Choose another thread or explicitly locate existing data on the host",
          });
        } catch (cause) {
          if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) {
            throw cause;
          }
        }
      }
    } catch {
      return problem(400, { detail: "The torrent contains an unsafe or inaccessible file path" });
    }
    if (options.operationKey) {
      this.db
        .insert(operationReceipts)
        .values({
          createdAt: Date.now(),
          id: options.operationKey,
          kind: "add",
          result: JSON.stringify({ fingerprint, id }),
          status: "pending",
          target: id,
        })
        .onConflictDoUpdate({ set: { status: "pending" }, target: operationReceipts.id })
        .run();
    }
    this.entries.set(id, entry);
    // Persist identity and metadata before the worker starts any file or network effect.
    this.save(entry);
    if (!options.paused) {
      await this.start(entry);
    }
    this.save(entry);
    if (options.operationKey) {
      this.db
        .update(operationReceipts)
        .set({ completedAt: Date.now(), status: "done" })
        .where(eq(operationReceipts.id, options.operationKey))
        .run();
    }
    return { id };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep filesystem identity checks and recovery decisions in the same operation.
  private storageCollision(entry: Entry, torrent: Torrent) {
    const reserved = this.storageReservations(new Set([entry]));
    if (reserved instanceof ElysiaStatus) {
      return reserved;
    }
    for (const file of torrent.files) {
      const key = this.storageKey(entry.detail.savePath, file.path);
      if (key instanceof ElysiaStatus) {
        return key;
      }
      if (reserved.has(key)) {
        return file;
      }
      const path = this.storagePath(entry.detail.savePath, file.path);
      if (path instanceof ElysiaStatus) {
        return path;
      }
      const owned = entry.storageFiles.find((item) => item.path === canonicalPath(file.path));
      if (entry.storageClaimed && !entry.validateRetained) {
        continue;
      }
      try {
        const existing = lstatSync(path);
        if (
          !(entry.storageClaimed && owned) ||
          existing.dev !== owned.dev ||
          existing.ino !== owned.ino ||
          existing.size !== owned.size ||
          existing.mtimeMs !== owned.mtimeMs
        ) {
          return file;
        }
      } catch (cause) {
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          continue;
        }
        throw cause;
      }
    }
  }

  private async start(entry: Entry, options?: { checking: boolean }) {
    if (!options?.checking) {
      await this.inspectStorage(entry);
      if (entry.detail.storageIssue || entry.torrent) {
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
      // Rely on the OS file cache instead of retaining 20 full pieces per torrent while idle.
      storeCacheSlots: 0,
    });
    const { torrent } = entry;
    this.connections.attach(torrent);
    const { detail } = entry;
    torrent.on("metadata", () => {
      entry.metadata = Buffer.from(torrent.torrentFile).toString("base64");
      let collision: Torrent["files"][number] | undefined;
      try {
        // This callback runs before WebTorrent verifies or writes its filesystem store.
        const checked = this.storageCollision(entry, torrent);
        if (checked instanceof ElysiaStatus) {
          detail.error = checked.response.detail;
          entry.torrent = null;
          entry.unwatch?.();
          torrent.destroy({ destroyStore: false });
          this.save(entry);
          return;
        }
        collision = checked;
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
      entry.validateRetained = false;
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
      const log = createLogger({
        component: "torrent-engine",
        context: { savePath: detail.savePath, torrentId: detail.id },
        dataDir: this.dataDir,
        error: sanitizeLog(error),
        operation: "torrent",
      });
      log.setLevel("error");
      log.emit();
      if (entry.torrent === torrent) {
        entry.torrent = null;
      }
      entry.unwatch?.();
      const issue = storageFailure(
        error,
        detail.files.map((file) => file.path),
        {
          dataDir: this.dataDir,
          expected: entry.storageRoot,
          savePath: detail.savePath,
          torrentId: detail.id,
        }
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
          const block = async () => {
            try {
              await this.serial(entry, () =>
                this.blockStorage(entry, {
                  detectedAt: Date.now(),
                  kind: "modified-files",
                  message:
                    "Previously downloaded pieces are missing or invalid. Repair the download to continue.",
                  paths: invalid.map((file) => file.path),
                })
              );
            } catch (error) {
              const log = createLogger({
                component: "storage",
                error: sanitizeLog(error),
                operation: "block",
              });
              log.setLevel("error");
              log.emit();
            }
          };
          void block();
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
      const recordIdentity = async () => {
        try {
          await this.serial(entry, async () => {
            const identities = new Map(entry.storageFiles.map((file) => [file.path, file]));
            for (const file of detail.files) {
              if (file.progress !== 1) {
                continue;
              }
              const path = this.storagePath(detail.savePath, file.path);
              if (path instanceof ElysiaStatus) {
                return path;
              }
              // biome-ignore lint/performance/noAwaitInLoops: bound filesystem work within a torrent.
              const stored = await storedFile(path);
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
          });
        } catch (error) {
          const log = createLogger({
            component: "storage",
            context: { savePath: detail.savePath, torrentId: detail.id },
            dataDir: this.dataDir,
            error: sanitizeLog(error),
            operation: "completed-file-identity",
          });
          log.setLevel("error");
          log.emit();
        }
      };
      void recordIdentity();
    });
    entry.unwatch = watchTrackers(torrent, detail.trackers);
  }

  private async stop(entry: Entry) {
    this.cancelRanges(entry.detail.id);
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

  private async serial<Result>(
    entry: Entry,
    action: () => Result,
    options?: { checkpoint: boolean }
  ) {
    if (entry.moving) {
      return problem(409, { detail: "This torrent's files are being moved. Try again afterward." });
    }
    const previous = entry.operation;
    const reserved = Promise.withResolvers<void>();
    entry.operation = reserved.promise;
    try {
      try {
        await previous;
      } catch {
        /* A previous operation reports its own failure. */
      }
      if (this.entries.get(entry.detail.id) !== entry) {
        return problem(404, { detail: "Torrent not found" });
      }
      const result = await action();
      if (result instanceof ElysiaStatus) {
        return result;
      }
      if (this.entries.get(entry.detail.id) === entry) {
        if (options?.checkpoint) {
          this.dirtyEntries.add(entry);
        } else {
          this.save(entry);
        }
      }
      return result;
    } finally {
      reserved.resolve();
    }
  }

  async pause(id: string) {
    const entry = this.get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    const operationResult0 = await this.serial(entry, async () => {
      entry.paused = true;
      await this.stop(entry);
    });
    if (operationResult0 instanceof ElysiaStatus) {
      return operationResult0;
    }
    return { ok: true };
  }

  async resume(id: string) {
    const entry = this.get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    const operationResult1 = await this.serial(entry, async () => {
      await this.inspectStorage(entry);
      if (entry.detail.storageIssue) {
        return problem(409, {
          detail: "Resolve the storage problem or repair the download before resuming",
        });
      }
      entry.paused = false;
      if (!entry.torrent) {
        await this.start(entry);
      }
    });
    if (operationResult1 instanceof ElysiaStatus) {
      return operationResult1;
    }
    return { ok: true };
  }

  async replaceTrackers(id: string, urls: string[]) {
    const valid = trackerUrls(urls);
    if (valid instanceof ElysiaStatus) {
      return valid;
    }
    const entry = this.get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    const operationResult2 = await this.serial(entry, async () => {
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
    if (operationResult2 instanceof ElysiaStatus) {
      return operationResult2;
    }
    return { ok: true };
  }

  async remove(id: string, deleteFiles: boolean, operationKey?: string) {
    if (operationKey) {
      const receipt = this.db
        .select()
        .from(operationReceipts)
        .where(eq(operationReceipts.id, operationKey))
        .get();
      if (
        receipt &&
        (receipt.target !== id || JSON.parse(receipt.result ?? "{}").deleteFiles !== deleteFiles)
      ) {
        return problem(409, {
          detail: "This operation key was used for different removal options",
        });
      }
      if (receipt?.status === "done") {
        return { ok: true };
      }
      if (receipt && receipt.target !== id) {
        return problem(409, { detail: "This operation key was used for another torrent" });
      }
    }
    const entry = this.get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    if (operationKey) {
      this.db
        .insert(operationReceipts)
        .values({
          createdAt: Date.now(),
          id: operationKey,
          kind: "remove",
          result: JSON.stringify({ deleteFiles }),
          status: "pending",
          target: id,
        })
        .onConflictDoNothing()
        .run();
    }
    const operationResult3 = await this.serial(entry, async () => {
      await this.stop(entry);
      if (deleteFiles && entry.storageClaimed) {
        try {
          await storageRoot(entry.detail.savePath, entry.storageRoot);
        } catch {
          return problem(409, {
            detail:
              "The original storage is unavailable. Reconnect it before deleting files, or remove the torrent while keeping its data.",
          });
        }
        const shared = this.storageReservations(new Set([entry]));
        if (shared instanceof ElysiaStatus) {
          return shared;
        }
        const paths: { key: string; path: string }[] = [];
        for (const file of entry.detail.files) {
          const key = this.storageKey(entry.detail.savePath, file.path);
          if (key instanceof ElysiaStatus) {
            return key;
          }
          const path = this.storagePath(entry.detail.savePath, file.path);
          if (path instanceof ElysiaStatus) {
            return path;
          }
          paths.push({ key, path });
        }
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
      this.db.transaction((tx) => {
        const retainedKey = `retained:${id}:${new Bun.CryptoHasher("sha256").update(entry.detail.savePath).digest("hex")}`;
        if (!deleteFiles && entry.storageClaimed) {
          const result = JSON.stringify({ files: entry.storageFiles, root: entry.storageRoot });
          tx.insert(operationReceipts)
            .values({
              completedAt: Date.now(),
              createdAt: Date.now(),
              id: retainedKey,
              kind: "retained-storage",
              result,
              status: "done",
              target: id,
            })
            .onConflictDoUpdate({
              set: { completedAt: Date.now(), result },
              target: operationReceipts.id,
            })
            .run();
        } else {
          tx.delete(operationReceipts).where(eq(operationReceipts.id, retainedKey)).run();
        }
        tx.delete(torrentRecords).where(eq(torrentRecords.id, id)).run();
        if (operationKey) {
          tx.update(operationReceipts)
            .set({
              completedAt: Date.now(),
              result: JSON.stringify({ deleteFiles, ok: true }),
              status: "done",
            })
            .where(eq(operationReceipts.id, operationKey))
            .run();
        }
      });
      this.changed("state");
    });
    if (operationResult3 instanceof ElysiaStatus) {
      return operationResult3;
    }
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
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    const operationResult4 = await this.serial(entry, () => {
      const file = this.details(entry).files[index];
      if (!file) {
        return problem(404, { detail: "File not found" });
      }
      file.priority = priority;
      this.selectFiles(entry);
    });
    if (operationResult4 instanceof ElysiaStatus) {
      return operationResult4;
    }
    return { ok: true };
  }

  private assertVerification(entry: Entry) {
    if (entry.verifying || entryStatus(entry) === "checking") {
      return problem(409, { detail: "Verification is already in progress for this torrent" });
    }
    if (!entry.metadata) {
      return problem(409, { detail: "Metadata must be available before verification" });
    }
  }

  private async verifyData(entry: Entry) {
    try {
      entry.storageRoot = await storageRoot(entry.detail.savePath, entry.storageRoot);
      for (const file of entry.detail.files) {
        const path = this.storagePath(entry.detail.savePath, file.path);
        if (path instanceof ElysiaStatus) {
          return path;
        }
        if (file.priority !== "skip") {
          // biome-ignore lint/performance/noAwaitInLoops: preflight access before the engine can treat read failures as missing pieces.
          await storedFile(path);
        }
      }
    } catch (cause) {
      const issue = storageFailure(
        cause,
        entry.detail.files.map((file) => file.path),
        {
          dataDir: this.dataDir,
          expected: entry.storageRoot,
          savePath: entry.detail.savePath,
          torrentId: entry.detail.id,
        }
      );
      await this.blockStorage(entry, issue);
      return problem(409, { detail: issue.message });
    }
    await this.stop(entry);
    await this.start(entry, { checking: true });
    const { torrent } = entry;
    if (!torrent) {
      return problem(500, { detail: "Unable to verify" });
    }
    try {
      const outcome = await new Promise<"ready" | "timeout" | "closed">((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timeout);
          torrent.off("error", failed);
          torrent.off("ready", ready);
          torrent.off("close", closed);
        };
        const timeout = setTimeout(() => {
          cleanup();
          resolve("timeout");
        }, 60_000);
        const ready = () => {
          cleanup();
          resolve("ready");
        };
        const failed = (error: Error | string) => {
          cleanup();
          reject(error instanceof Error ? error : new Error(error));
        };
        const closed = () => {
          cleanup();
          resolve("closed");
        };
        torrent.once("ready", ready);
        torrent.once("error", failed);
        torrent.once("close", closed);
      });
      if (outcome !== "ready") {
        await this.stop(entry);
        return outcome === "timeout"
          ? problem(408, { detail: "Verification exceeded the 60-second timeout" })
          : problem(409, { detail: "Verification stopped before completion" });
      }
      this.details(entry);
      entry.storageFiles = [];
      const inspected = await this.inspectFiles(entry);
      if (inspected instanceof ElysiaStatus) {
        await this.blockStorage(entry, {
          detectedAt: Date.now(),
          kind: "invalid-path",
          message: inspected.response.detail,
          paths: entry.detail.files.map((file) => file.path),
        });
        return inspected;
      }
      if (entry.torrent !== torrent) {
        return problem(409, {
          detail: entry.detail.storageIssue?.message ?? "Unable to verify storage",
        });
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

  private async checkedOperation<Result>(entry: Entry, action: () => Promise<Result>) {
    const denied = this.assertVerification(entry);
    if (denied instanceof ElysiaStatus) {
      return denied;
    }
    const operation = this.serial(entry, action);
    entry.verifying = true;
    this.cancelRanges(entry.detail.id);
    try {
      const result = await operation;
      if (result instanceof ElysiaStatus) {
        return result;
      }
    } finally {
      entry.verifying = false;
    }
    return { ok: true };
  }

  verify(id: string) {
    const entry = this.get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    return this.checkedOperation(entry, async () => {
      const expected = new Map(
        this.details(entry).files.map((file) => [file.path, file.downloaded ?? 0])
      );
      await this.inspectStorage(entry);
      const validationResult5 = await this.verifyData(entry);
      if (validationResult5 instanceof ElysiaStatus) {
        return validationResult5;
      }
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
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    return this.checkedOperation(entry, async () => {
      const validationResult6 = await this.verifyData(entry);
      if (validationResult6 instanceof ElysiaStatus) {
        return validationResult6;
      }
      entry.detail.storageIssue = null;
      entry.detail.error = null;
      await this.finishVerification(entry);
    });
  }

  private assertLocation(entry: Entry, path: string) {
    const reserved = this.storageReservations(new Set([entry]));
    if (reserved instanceof ElysiaStatus) {
      return reserved;
    }
    for (const file of entry.detail.files) {
      const target = this.storagePath(path, file.path);
      if (target instanceof ElysiaStatus) {
        return target;
      }
      const key = this.storageKey(path, file.path);
      if (key instanceof ElysiaStatus) {
        return key;
      }
      if (reserved.has(key)) {
        return problem(409, {
          detail: "These files are already used by another torrent. Choose another folder.",
        });
      }
    }
  }

  locate(id: string, downloadPath: string) {
    const entry = this.get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    if (!isAbsolute(downloadPath)) {
      return problem(400, { detail: "The folder must be an absolute path" });
    }
    const path = resolvePath(downloadPath);
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep filesystem identity checks and recovery decisions in the same operation.
    return this.checkedOperation(entry, async () => {
      let root: StorageIdentity;
      try {
        root = await storageRoot(path, null);
        const validationResult7 = this.assertLocation(entry, path);
        if (validationResult7 instanceof ElysiaStatus) {
          return validationResult7;
        }
      } catch (cause) {
        return problem(409, {
          detail: storageFailure(cause, [], {
            dataDir: this.dataDir,
            savePath: path,
            torrentId: id,
          }).message,
        });
      }
      await this.stop(entry);
      try {
        const validationResult8 = this.assertLocation(entry, path);
        if (validationResult8 instanceof ElysiaStatus) {
          if (!(entry.paused || entry.detail.storageIssue)) {
            await this.start(entry);
          }
          return validationResult8;
        }
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
      const validationResult9 = await this.verifyData(entry);
      if (validationResult9 instanceof ElysiaStatus) {
        return validationResult9;
      }
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

  async addPeer(id: string, peer: string) {
    const entry = this.get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    if (!entry.torrent || entry.paused) {
      return problem(409, { detail: "Resume the torrent before adding a peer" });
    }
    if (
      entry.torrent.ready &&
      entry.torrent.done &&
      this.settings.seedingConnectionMode === "incoming-only"
    ) {
      return problem(409, {
        detail:
          "Switch seeding connections to Balanced before adding an outgoing peer to a completed torrent",
      });
    }
    let address: URL;
    try {
      address = new URL(`tcp://${peer}`);
    } catch {
      return problem(400, { detail: "Invalid address, use IP:port" });
    }
    if (!(address.hostname && address.port) || Number(address.port) < 1) {
      return problem(400, { detail: "Invalid address, use IP:port" });
    }
    if (!entry.torrent.addPeer(peer, "manual")) {
      return problem(400, { detail: "This peer is invalid or already connected" });
    }
    const parsed = await parseTorrent(entry.source);
    parsed.peerAddresses = [...new Set([...(parsed.peerAddresses ?? []), peer])];
    entry.source = toMagnetURI(parsed);
    entry.detail.magnet = entry.source;
    this.save(entry);
    return { ok: true };
  }

  async updateSettings(settings: SettingsInput) {
    if (settings.downloadPath !== undefined && !isAbsolute(settings.downloadPath)) {
      return problem(400, { detail: "The folder must be an absolute path" });
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
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    if (!entry.torrent || entry.paused) {
      return problem(409, { detail: "Resume the torrent before refreshing its trackers" });
    }
    if (!announce(entry.torrent)) {
      return problem(409, { detail: "The tracker connection is not ready yet" });
    }
    for (const row of entry.detail.trackers) {
      row.status = "announcing";
    }
    return { ok: true };
  }

  get(id: string) {
    const entry = this.entries.get(id);
    if (!entry) {
      return problem(404, { detail: "Torrent not found" });
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
    const entry = this.get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    return this.details(entry);
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validation and cancellation stay with the selection cleanup they protect.
  async waitForRange(request: string, id: string, index: number, start: number, end: number) {
    const entry = this.get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    if (entry.verifying || entryStatus(entry) === "checking") {
      return problem(409, {
        detail: "Files are being verified. Try again after verification completes.",
      });
    }
    if (entry.moving) {
      return problem(409, { detail: "Files are being moved. Try again afterward." });
    }
    const { torrent } = entry;
    const stats = this.details(entry).files[index];
    if (!stats) {
      return problem(404, { detail: "File not found" });
    }
    if (entry.paused || !torrent?.ready) {
      return problem(409, { detail: "Resume this torrent to play it" });
    }
    const file = torrent.files[index];
    if (!file) {
      return problem(404, { detail: "File not found" });
    }
    if (entry.detail.storageIssue) {
      return problem(409, { detail: entry.detail.storageIssue.message });
    }
    if (
      !(Number.isSafeInteger(start) && Number.isSafeInteger(end)) ||
      start < 0 ||
      end < start ||
      end >= file.length
    ) {
      return problem(416, { detail: "The requested range is outside the file" });
    }
    const path = this.storagePath(entry.detail.savePath, stats.path);
    if (path instanceof ElysiaStatus) {
      return path;
    }
    const first = Math.floor((file.offset + start) / torrent.pieceLength);
    const last = Math.floor((file.offset + end) / torrent.pieceLength);
    // These private stream selections are pinned to WebTorrent 3.0.21. Unlike public
    // selections, they never merge with or change the user's file priorities.
    const runtime = torrent as Torrent & {
      bitfield: { get: (piece: number) => boolean };
      destroyed: boolean;
      _select: (from: number, to: number, priority: number, notify: null, stream: boolean) => void;
      _deselect: (from: number, to: number, stream: boolean) => void;
    };
    const missing = () => {
      for (let piece = first; piece <= last; piece += 1) {
        if (!runtime.bitfield.get(piece)) {
          return true;
        }
      }
      return false;
    };
    const fileLast = Math.floor((file.offset + file.length - 1) / torrent.pieceLength);
    // Read ahead in bytes: VLC asks for 1 MiB at a time, and pieces can be 16 KiB to 16 MiB.
    const ahead = Math.min(last + Math.ceil((16 * 1024 * 1024) / torrent.pieceLength), fileLast);
    const playing = `${id}:${index}`;
    const previous = this.readAhead.get(playing);
    if (previous) {
      clearTimeout(previous.timer);
      previous.release();
    }
    runtime._select(first, ahead, 20, null, true);
    const release = () => {
      if (!runtime.destroyed) {
        runtime._deselect(first, ahead, true);
      }
    };
    this.readAhead.set(playing, {
      id,
      release,
      // A player that stopped reading gives the bandwidth back to the whole torrent.
      timer: setTimeout(() => {
        release();
        this.readAhead.delete(playing);
      }, 30_000),
    });
    if (!missing()) {
      const identity = await lstat(path);
      return { identity: { dev: identity.dev, ino: identity.ino }, path };
    }
    const controller = new AbortController();
    this.ranges.set(request, { controller, id });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    // The first request also fetches the end of the file, where containers often keep indexes.
    const tail = start === 0 ? Math.max(first, fileLast - 1) : null;
    const stopped = () => controller.abort();
    torrent.once("close", stopped);
    if (tail !== null) {
      runtime._select(tail, fileLast, 15, null, true);
    }
    try {
      while (missing()) {
        // biome-ignore lint/performance/noAwaitInLoops: Each verified piece may satisfy the pending range.
        await once(torrent, "verified", { signal });
      }
      const identity = await lstat(path);
      return { identity: { dev: identity.dev, ino: identity.ino }, path };
    } catch (cause) {
      if (controller.signal.aborted) {
        return problem(499, { detail: "Playback stopped" });
      }
      if (signal.aborted) {
        return problem(504, {
          detail: "No peer sent this part of the file. Try again when more peers are available.",
        });
      }
      throw cause;
    } finally {
      torrent.off("close", stopped);
      if (tail !== null && !runtime.destroyed) {
        runtime._deselect(tail, fileLast, true);
      }
      this.ranges.delete(request);
    }
  }

  cancelRange(request: string) {
    this.ranges.get(request)?.controller.abort();
  }

  cancelRanges(id?: string) {
    for (const range of this.ranges.values()) {
      if (id === undefined || range.id === id) {
        range.controller.abort();
      }
    }
    for (const [playing, readAhead] of this.readAhead) {
      if (id === undefined || readAhead.id === id) {
        clearTimeout(readAhead.timer);
        readAhead.release();
        this.readAhead.delete(playing);
      }
    }
  }

  async file(id: string, index: number) {
    const entry = this.get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    if (!(entry.verifying || entry.moving)) {
      const operationResult5 = await this.serial(entry, () => this.inspectStorage(entry));
      if (operationResult5 instanceof ElysiaStatus) {
        return operationResult5;
      }
    }
    const detail = this.details(entry);
    if (detail.status === "checking" || entry.verifying) {
      return problem(409, {
        detail: "Files are being verified. Try again after verification completes.",
      });
    }
    if (entry.moving) {
      return problem(409, { detail: "Files are being moved. Try again afterward." });
    }
    const file = detail.files[index];
    if (!file) {
      return problem(404, { detail: "File not found" });
    }
    if (detail.storageIssue?.paths.includes(file.path)) {
      return problem(detail.storageIssue.kind === "missing-files" ? 404 : 409, {
        detail:
          detail.storageIssue.kind === "missing-files"
            ? `The downloaded file is no longer present : ${file.path}`
            : detail.storageIssue.message,
      });
    }
    if (file.progress !== 1) {
      return problem(409, { detail: "This file has not finished downloading" });
    }
    const path = this.storagePath(detail.savePath, file.path);
    if (path instanceof ElysiaStatus) {
      return path;
    }
    if (!(await Bun.file(path).exists())) {
      return problem(404, { detail: `The downloaded file is no longer present : ${path}` });
    }
    const identity = await lstat(path);
    return { identity: { dev: identity.dev, ino: identity.ino }, name: file.name, path };
  }

  async close() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: A prior lifecycle close can change this state.
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelRanges();
    try {
      clearInterval(this.timer);
      if (this.telemetryTimer) {
        clearTimeout(this.telemetryTimer);
      }
      this.connections.close();
      this.listeners.clear();
      await this.diskCheck;
      await this.storageCheck;
      await Promise.allSettled(this.destinationOperation ? [this.destinationOperation] : []);
      await Promise.allSettled([...this.entries.values()].map((entry) => entry.operation));
      // Drain torrent stores before bounding cleanup of remote router mappings.
      await Promise.all([...this.entries.values()].map((entry) => this.stop(entry)));
      for (const entry of this.entries.values()) {
        this.save(entry);
      }
      this.config("traffic", { received: this.received, uploaded: this.uploaded });
      this.db.$client.close(true);
      if (!this.client.destroyed) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            new Promise<void>((resolve, reject) =>
              this.client.destroy((error) => (error ? reject(error) : resolve()))
            ),
            new Promise<void>((resolve) => {
              deadline = setTimeout(resolve, 1000);
            }),
          ]);
        } finally {
          clearTimeout(deadline);
        }
      }
    } finally {
      this.cryptoDiagnostics?.close();
    }
  }
}

export type EnginePort = TorrentEngine | WorkerTorrentEngine;

export interface EngineOpenOptions {
  connectionPolicy?: ConnectionPolicy;
  cryptoDiagnostics?: boolean;
  dataDir: string;
  downloadPath: string;
  network: TorrentNetworkOptions;
}

export interface TorrentAddOptions {
  destinationId?: string;
  downloadPath?: string;
  operationKey?: string;
  paused: boolean;
  trackers?: string[];
}
