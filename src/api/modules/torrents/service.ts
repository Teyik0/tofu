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
import { type Context, Effect, Result } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { ElysiaStatus, problem } from "elysia";
import { createLogger } from "evlog";
import parseTorrent, { toMagnetURI } from "parse-torrent";
import type { Options as TorrentNetworkOptions } from "webtorrent";
import WebTorrent, { type Torrent } from "webtorrent";
import {
  operationReceipts,
  torrentConfig,
  torrentDestinations,
  torrentRecords,
} from "../../../db/schema";
import type { DatabaseInstance as Database, DatabaseConnection } from "../../lib/database-layer";
import type { Destination, DestinationInput, DestinationPresentation } from "../destinations/model";
import type { Settings, SettingsInput } from "../settings/model";
import type { ConnectionPolicy } from "./connections";
import { ConnectionScheduler, defaultConnectionPolicy } from "./connections";
import { installCryptoDiagnostics } from "./crypto-diagnostics";
import type { TorrentClient } from "./layer";
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

interface RelocatedFile {
  source: string;
  staged: string;
  target: string;
}

function canonicalPath(filePath: string) {
  return filePath.replaceAll("\\", "/");
}

async function storedFile(path: string) {
  const observed = await Effect.runPromise(
    Effect.result(
      Effect.tryPromise({
        catch: (cause) => cause,
        try: () => lstat(path),
      })
    )
  );
  if (Result.isFailure(observed)) {
    const cause = observed.failure;
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return null;
    }
    throw cause;
  }
  const stored = observed.success;
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Initialize resources and reconcile persisted operations before exposing the engine.
export async function openTorrentEngine(engineOptions: EngineOpenOptions, db: Database) {
  await mkdir(engineOptions.dataDir, { recursive: true });
  await using startup = new AsyncDisposableStack();
  const cryptoDiagnostics =
    (engineOptions.cryptoDiagnostics ?? process.env.TOFU_CRYPTO_DIAGNOSTICS === "1")
      ? installCryptoDiagnostics()
      : null;
  startup.defer(() => cryptoDiagnostics?.close());

  const state = {
    closed: false,
    destinations: new Map<string, Destination>(),
    dirtyEntries: new Set<Entry>(),
    diskCheck: null as Promise<void> | null,
    entries: new Map<string, Entry>(),
    entryStructures: new Map<Entry, string>(),
    freeSpace: null as number | null,
    history: [] as SpeedSample[],
    lastDiskAt: 0,
    lastPersistAt: 0,
    lastTelemetryAt: Date.now(),
    lastTick: Date.now(),
    listeners: new Set<(change: EngineChange) => void>(),
    mode: "server" as "desktop" | "server",
    movingDestinations: new Set<string>(),
    persistedEntries: new Map<Entry, string>(),
    ranges: new Map<string, { id: string; controller: AbortController }>(),
    readAhead: new Map<
      string,
      { id: string; release: () => void; timer: ReturnType<typeof setTimeout> }
    >(),
    received: 0,
    startedAt: Date.now(),
    stateRevision: 0,
    storageCheck: null as Promise<void> | null,
    telemetryRevision: 0,
    telemetryTimer: null as ReturnType<typeof setTimeout> | null,
    telemetryValues: [] as number[],
    timer: setInterval(tick, 1000),
    trafficDirty: false,
    uploaded: 0,
  };
  let destinationOperation: ReturnType<typeof moveDestination> | null = null;
  startup.defer(() => clearInterval(state.timer));
  const defaults: Settings = {
    deleteTorrentFileAfterAdd: false,
    downloadLimit: -1,
    downloadPath: engineOptions.downloadPath,
    runInBackground: false,
    seedingConnectionMode: "balanced",
    theme: "system",
    uploadLimit: -1,
  };

  const storedSettings = db
    .select()
    .from(torrentConfig)
    .where(eq(torrentConfig.key, "settings"))
    .get();
  const engineSettings = storedSettings
    ? { ...defaults, ...(JSON.parse(storedSettings.value) as Settings) }
    : defaults;
  for (const destination of db.select().from(torrentDestinations).orderBy(sql`rowid`).all()) {
    state.destinations.set(destination.id, destination);
  }
  if (!state.destinations.has("default")) {
    storeDestination({
      autoAddTorrentFilesSince: null,
      deleteTorrentFileAfterAdd: null,
      downloadPath: engineSettings.downloadPath,
      icon: "folder",
      id: "default",
      name: "Downloads",
      pinned: false,
    });
  }
  const totals = db.select().from(torrentConfig).where(eq(torrentConfig.key, "traffic")).get();
  if (totals) {
    const parsed: { received: number; uploaded: number } = JSON.parse(totals.value);
    state.received = parsed.received;
    state.uploaded = parsed.uploaded;
  }
  const torrentClient = new WebTorrent(engineOptions.network);
  startup.defer(async () => {
    if (!torrentClient.destroyed) {
      await new Promise<void>((resolve, reject) =>
        torrentClient.destroy((error) => (error ? reject(error) : resolve()))
      );
    }
  });
  torrentClient.seedOutgoingConnections = engineSettings.seedingConnectionMode === "balanced";
  const scheduler = new ConnectionScheduler(
    torrentClient,
    engineOptions.connectionPolicy ?? defaultConnectionPolicy,
    engineSettings.seedingConnectionMode
  );
  startup.defer(() => scheduler.close());
  torrentClient.throttleDownload(engineSettings.downloadLimit);
  torrentClient.throttleUpload(engineSettings.uploadLimit);
  torrentClient.on("error", (error) => {
    const log = createLogger({
      component: "torrent-engine",
      dataDir: engineOptions.dataDir,
      error,
      operation: "client",
    });
    log.setLevel("error");
    log.emit();
  });
  for (const row of db.select().from(torrentRecords).orderBy(sql`rowid`).all()) {
    const storedEntry: StoredEntry = JSON.parse(row.value);
    storedEntry.detail.destinationId ??= destinationForPath(
      dirname(storedEntry.detail.savePath)
    ).id;
    storedEntry.detail.storageIssue ??= null;
    state.entries.set(storedEntry.detail.id, {
      ...storedEntry,
      operation: Promise.resolve(),
      storageClaimed: storedEntry.storageClaimed ?? storedEntry.detail.error === null,
      storageFiles: storedEntry.storageFiles ?? [],
      storageRoot: storedEntry.storageRoot ?? null,
      torrent: null,
    });
  }
  state.timer.unref();

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep the existing persistence, telemetry, and storage tick together.
  function tick() {
    const now = Date.now();
    const seconds = (now - state.lastTick) / 1000;
    state.lastTick = now;
    for (const entry of state.entries.values()) {
      if (!entry.paused && entry.torrent) {
        state.dirtyEntries.add(entry);
        entry.detail.activeSeconds += seconds;
        if (entry.torrent.done) {
          entry.detail.seedSeconds += seconds;
        }
      }
      summarizeTorrent(entry);
    }
    if (now - state.lastPersistAt >= 5000) {
      checkpoint();
      state.lastPersistAt = now;
    }
    const download = torrentClient.downloadSpeed;
    const upload = torrentClient.uploadSpeed;
    const previous = state.history.at(-1);
    if (download > 0 || upload > 0 || previous?.download || previous?.upload) {
      state.history.push({ download, time: now, upload });
      if (state.history.length > 120) {
        state.history.shift();
      }
    }
    // Speeds decay with time even when no transfer event arrives.
    publishTelemetry(now);
    if (now - state.lastDiskAt >= 60_000) {
      diskSpace();
    }
    if (!state.storageCheck) {
      const pending = Promise.withResolvers<void>();
      state.storageCheck = pending.promise;
      const check = async () => {
        using completion = new DisposableStack();
        completion.defer(() => {
          state.storageCheck = null;
          pending.resolve();
        });
        // This timer boundary reports failures that have no awaiting caller.
        const checked = await Effect.runPromise(
          Effect.result(
            Effect.tryPromise({
              catch: (error) => error,
              try: () => checkStorage(),
            })
          )
        );
        if (Result.isFailure(checked)) {
          const log = createLogger({
            component: "storage",
            error: checked.failure,
            operation: "check",
          });
          log.setLevel("error");
          log.emit();
        }
      };
      void check();
    }
  }

  function assertReady() {
    if (torrentClient.destroyed) {
      return problem(503, { detail: "The torrent engine has stopped" });
    }
    db.run(sql`SELECT 1 FROM config, torrents, destinations LIMIT 0`);
  }

  function checkpoint() {
    const saved = new Map<Entry, string>();
    db.transaction((tx) => {
      for (const entry of state.dirtyEntries) {
        saved.set(entry, save(entry, tx));
      }
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Event handlers and lifecycle cleanup can change this state between calls or awaits.
      if (state.trafficDirty) {
        config("traffic", { received: state.received, uploaded: state.uploaded }, tx);
      }
    });
    for (const [entry, value] of saved) {
      state.persistedEntries.set(entry, value);
    }
    state.dirtyEntries.clear();
    state.trafficDirty = false;
  }

  function measureTelemetry() {
    const values = [
      state.received,
      state.uploaded,
      torrentClient.downloadSpeed,
      torrentClient.uploadSpeed,
      state.freeSpace ?? -1,
    ];
    for (const entry of state.entries.values()) {
      values.push(
        entry.torrent?.numPeers ?? 0,
        entry.torrent?.ready ? entry.torrent.progress : (entry.detail.progress ?? -1)
      );
    }
    return values;
  }

  function publishTelemetry(now: number) {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Event handlers and lifecycle cleanup can change this state between calls or awaits.
    if (state.closed || now - state.lastTelemetryAt < 1000) {
      return;
    }
    state.lastTelemetryAt = now;
    const values = measureTelemetry();
    if (
      values.length !== state.telemetryValues.length ||
      values.some((value, index) => value !== state.telemetryValues[index])
    ) {
      state.telemetryValues = values;
      changed("telemetry");
    }
  }

  function queueTelemetry() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: Event handlers and lifecycle cleanup can change this state between calls or awaits.
    if (state.closed || state.telemetryTimer) {
      return;
    }
    state.telemetryTimer = setTimeout(
      () => {
        state.telemetryTimer = null;
        publishTelemetry(Date.now());
      },
      Math.max(0, 1000 - (Date.now() - state.lastTelemetryAt))
    );
    state.telemetryTimer.unref();
  }

  function diskSpace() {
    if (!state.diskCheck) {
      state.lastDiskAt = Date.now();
      const pending = Promise.withResolvers<void>();
      state.diskCheck = pending.promise;
      const check = async () => {
        using completion = new DisposableStack();
        completion.defer(() => {
          state.diskCheck = null;
          pending.resolve();
        });
        const disk = await Effect.runPromise(
          Effect.result(
            Effect.tryPromise({
              catch: (cause) => cause,
              try: () => statfs(engineSettings.downloadPath),
            })
          )
        );
        state.freeSpace = Result.isSuccess(disk) ? disk.success.bavail * disk.success.bsize : null;
      };
      void check();
    }
    return state.diskCheck;
  }

  function connectionDiagnostics() {
    return { ...scheduler.diagnostics, crypto: cryptoDiagnostics?.snapshot() ?? null };
  }

  async function refreshSnapshot(_maxAgeMs: number) {
    if (Date.now() - state.lastDiskAt >= 60_000) {
      await diskSpace();
    }
    return snapshot(null, false);
  }

  function subscribeChanges(listener: (change: EngineChange) => void) {
    state.listeners.add(listener);
    return () => {
      state.listeners.delete(listener);
    };
  }

  function changed(kind: EngineChange["kind"]) {
    if (kind === "state") {
      state.stateRevision += 1;
    } else {
      state.telemetryRevision += 1;
    }
    for (const listener of state.listeners) {
      listener({
        kind,
        stateRevision: state.stateRevision,
        telemetryRevision: state.telemetryRevision,
      });
    }
  }

  async function checkStorage() {
    for (const entry of state.entries.values()) {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Event handlers and lifecycle cleanup can change this state between calls or awaits.
      if (state.closed) {
        return;
      }
      if (!(entry.metadata && entry.storageClaimed) || entry.moving || entry.verifying) {
        continue;
      }
      // Serialize filesystem checks with pause, removal, and other lifecycle operations.
      // biome-ignore lint/performance/noAwaitInLoops: Each filesystem check shares the torrent operation queue.
      const inspected = await Effect.runPromise(
        Effect.result(
          Effect.tryPromise({
            catch: (error) => error,
            try: () => serial(entry, () => inspectStorage(entry), { checkpoint: true }),
          })
        )
      );
      if (Result.isFailure(inspected)) {
        const log = createLogger({
          component: "storage",
          error: inspected.failure,
          operation: "inspect",
        });
        log.setLevel("error");
        log.emit();
      }
    }
  }

  async function inspectStorage(entry: Entry) {
    if (entry.detail.storageIssue && entry.detail.storageIssue.kind !== "storage-unavailable") {
      return;
    }
    const detail = buildDetail(entry);
    const inspectedStorage = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const root = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => storageRoot(detail.savePath, null),
          });
          const recovered = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => recoverStorage(entry, root),
          });
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
            yield* Effect.tryPromise({
              catch: (cause) => cause,
              try: () => storageRoot(detail.savePath, entry.storageRoot),
            });
          }
          entry.storageRoot = root;
          if (entry.validateRetained) {
            return;
          }
          const inspected = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => inspectFiles(entry),
          });
          if (inspected instanceof ElysiaStatus) {
            yield* Effect.promise(() =>
              blockStorage(entry, {
                detectedAt: Date.now(),
                kind: "invalid-path",
                message: inspected.response.detail,
                paths: entry.detail.files.map((file) => file.path),
              })
            );
            return inspected;
          }
        })
      )
    );
    if (Result.isSuccess(inspectedStorage)) {
      return inspectedStorage.success;
    }
    const { failure } = inspectedStorage;
    if (
      detail.storageIssue?.kind === "storage-unavailable" &&
      failure instanceof Error &&
      "code" in failure &&
      ["ENOENT", "ENODEV", "EIO"].includes(String(failure.code))
    ) {
      return;
    }
    await blockStorage(
      entry,
      storageFailure(
        failure,
        detail.files.map((file) => file.path),
        {
          dataDir: engineOptions.dataDir,
          expected: entry.storageRoot,
          savePath: detail.savePath,
          torrentId: detail.id,
        }
      )
    );
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validate retained file identities before rebinding storage.
  async function recoverStorage(entry: Entry, root: StorageIdentity) {
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
      const path = storagePath(entry.detail.savePath, file.path);
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
    using verification = new DisposableStack();
    verification.defer(() => {
      entry.verifying = verifying;
    });
    await stop(entry);
    entry.storageRoot = root;
    entry.storageFiles = entry.storageFiles.map((file) => ({ ...file, dev: root.dev }));
    // Hash existing pieces with networking paused before accepting the new device identity.
    const verified = await verifyData(entry);
    if (verified instanceof ElysiaStatus) {
      return verified;
    }
    const invalid = entry.detail.files.filter(
      (file) => (file.downloaded ?? 0) < (expected.get(file.path) ?? 0)
    );
    if (invalid.length) {
      await blockStorage(entry, {
        detectedAt: Date.now(),
        kind: "modified-files",
        message:
          "Previously downloaded pieces are missing or invalid. Repair the download to continue.",
        paths: invalid.map((file) => file.path),
      });
    } else {
      entry.detail.storageIssue = null;
      entry.detail.error = null;
      await finishVerification(entry);
      const log = createLogger({
        component: "storage",
        context: { previous, root, savePath: entry.detail.savePath, torrentId: entry.detail.id },
        dataDir: engineOptions.dataDir,
        operation: "recovered",
      });
      log.emit();
    }
    return true;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep file identity checks and missing-data classification together.
  async function inspectFiles(entry: Entry) {
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
      const path = storagePath(detail.savePath, file.path);
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
      await blockStorage(entry, {
        detectedAt: Date.now(),
        kind: "missing-files",
        message: modified.length
          ? "Downloaded files are missing or modified. Restore them or repair the download."
          : "Downloaded files are missing. Restore them or repair the download.",
        paths: [...missing, ...modified],
      });
    } else if (modified.length) {
      await blockStorage(entry, {
        detectedAt: Date.now(),
        kind: "modified-files",
        message: "Downloaded files were modified or truncated. Verify them or repair the download.",
        paths: modified,
      });
    } else {
      entry.storageFiles = observed;
    }
  }

  async function blockStorage(entry: Entry, issue: TorrentStorageIssue) {
    await stop(entry);
    markStorageIssue(entry, issue);
  }

  function markStorageIssue(entry: Entry, issue: TorrentStorageIssue) {
    const log = createLogger({
      component: "storage",
      context: {
        expected: entry.storageRoot,
        issue,
        savePath: entry.detail.savePath,
        torrentId: entry.detail.id,
      },
      dataDir: engineOptions.dataDir,
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
    save(entry);
  }

  function config(
    key: string,
    value: Settings | { received: number; uploaded: number },
    connection?: DatabaseConnection
  ) {
    const database = connection ?? db;
    const serialized = JSON.stringify(value);
    database
      .insert(torrentConfig)
      .values({ key, value: serialized })
      .onConflictDoUpdate({ set: { value: serialized }, target: torrentConfig.key })
      .run();
    if (!connection && key === "settings") {
      changed("state");
    }
  }

  function save(entry: Entry, connection?: DatabaseConnection) {
    const database = connection ?? db;

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
    if (state.persistedEntries.get(entry) === value) {
      return value;
    }
    database
      .insert(torrentRecords)
      .values({ id: detail.id, value })
      .onConflictDoUpdate({ set: { value }, target: torrentRecords.id })
      .run();
    if (!connection) {
      state.persistedEntries.set(entry, value);
      state.dirtyEntries.delete(entry);
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
      if (state.entryStructures.get(entry) !== structure) {
        state.entryStructures.set(entry, structure);
        changed("state");
      }
    }
    return value;
  }

  function writeDestination(destination: Destination, connection?: DatabaseConnection) {
    const database = connection ?? db;
    const { id, ...presentation } = destination;
    database
      .insert(torrentDestinations)
      .values(destination)
      .onConflictDoUpdate({ set: presentation, target: torrentDestinations.id })
      .run();
  }

  function storeDestination(destination: Destination, connection?: DatabaseConnection) {
    writeDestination(destination, connection);
    state.destinations.set(destination.id, destination);
    if (!connection) {
      changed("state");
    }
    return destination;
  }

  function destinationForPath(downloadPath: string) {
    return (
      [...state.destinations.values()].find(
        (destination) => destination.downloadPath === downloadPath
      ) ??
      storeDestination({
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

  async function prepareDestination(path: string) {
    const bound = [...state.entries.values()].filter(
      (entry) => entry.storageRoot && resolvePath(entry.detail.savePath) === resolvePath(path)
    );
    if (bound.length) {
      const root = await Effect.runPromise(
        Effect.result(
          Effect.gen(function* () {
            const observed = yield* Effect.tryPromise({
              catch: (cause) => cause,
              try: () => storageRoot(path, null),
            });
            if (
              !bound.some(
                (entry) =>
                  entry.storageRoot?.dev === observed.dev && entry.storageRoot.ino === observed.ino
              )
            ) {
              yield* Effect.tryPromise({
                catch: (cause) => cause,
                try: () => storageRoot(path, bound[0]?.storageRoot ?? null),
              });
            }
          })
        )
      );
      if (Result.isFailure(root)) {
        return problem(409, {
          detail: storageFailure(root.failure, [], {
            dataDir: engineOptions.dataDir,
            expected: bound[0]?.storageRoot,
            savePath: path,
          }).message,
        });
      }
    } else {
      await mkdir(path, { recursive: true });
    }
  }

  /** Resolves how a thread handles .torrent files, keeping each folder watched by one thread. */
  function torrentFileOptions(id: string | null, input: DestinationInput, downloadPath: string) {
    const current = id ? state.destinations.get(id) : undefined;
    let autoAddTorrentFilesSince = current?.autoAddTorrentFilesSince ?? null;
    if (input.autoAddTorrentFiles !== undefined) {
      autoAddTorrentFilesSince = input.autoAddTorrentFiles
        ? (autoAddTorrentFilesSince ?? Date.now())
        : null;
    }
    if (
      autoAddTorrentFilesSince !== null &&
      [...state.destinations.values()].some(
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
  async function saveDestination(id: string | null, input: DestinationInput) {
    const name = input.name.trim();
    if (!(name && isAbsolute(input.downloadPath))) {
      return problem(400, { detail: "Enter a name and an absolute folder path" });
    }
    if (id && !state.destinations.has(id)) {
      return problem(404, { detail: "Tab not found" });
    }
    if (state.movingDestinations.size > 0) {
      return problem(409, { detail: "A move is already in progress for this tab" });
    }
    const downloadPath = resolvePath(input.downloadPath);
    const fileOptions = torrentFileOptions(id, input, downloadPath);
    if (fileOptions instanceof ElysiaStatus) {
      return fileOptions;
    }
    const { autoAddTorrentFilesSince, deleteTorrentFileAfterAdd } = fileOptions;
    if (id && input.moveFiles) {
      const previous = state.destinations.get(id);
      const destination: Destination = {
        autoAddTorrentFilesSince,
        deleteTorrentFileAfterAdd,
        downloadPath,
        icon: input.icon ?? previous?.icon ?? "folder",
        id,
        name,
        pinned: input.pinned ?? previous?.pinned ?? false,
      };
      const operation = moveDestination(destination);
      destinationOperation = operation;
      using reservation = new DisposableStack();
      reservation.defer(() => {
        destinationOperation = null;
      });
      const result = await operation;
      if (result instanceof ElysiaStatus) {
        return result;
      }
      return destination;
    }
    const validationResult0 = await prepareDestination(downloadPath);
    if (validationResult0 instanceof ElysiaStatus) {
      return validationResult0;
    }
    if (id && !state.destinations.has(id)) {
      return problem(404, { detail: "Tab not found" });
    }
    if (state.movingDestinations.size > 0) {
      return problem(409, { detail: "A move is already in progress for this tab" });
    }
    const previous = id ? state.destinations.get(id) : undefined;
    const destination = storeDestination({
      autoAddTorrentFilesSince,
      deleteTorrentFileAfterAdd,
      downloadPath,
      icon: input.icon ?? previous?.icon ?? "folder",
      id: id ?? crypto.randomUUID(),
      name,
      pinned: input.pinned ?? previous?.pinned ?? false,
    });
    if (destination.id === "default") {
      engineSettings.downloadPath = destination.downloadPath;
      config("settings", engineSettings);
      await diskSpace();
    }
    return destination;
  }

  function updateDestinationPresentation(id: string, input: DestinationPresentation) {
    const destination = state.destinations.get(id);
    if (!destination) {
      return problem(404, { detail: "Tab not found" });
    }
    if (state.movingDestinations.size > 0) {
      return problem(409, { detail: "Wait for the move to finish before editing a tab" });
    }
    return storeDestination({
      ...destination,
      icon: input.icon ?? destination.icon,
      pinned: input.pinned ?? destination.pinned,
    });
  }

  async function removeDestination(id: string) {
    if (!state.destinations.has(id)) {
      return problem(404, { detail: "Tab not found" });
    }
    if (state.movingDestinations.size > 0) {
      return problem(409, { detail: "Wait for the move to finish before deleting a tab" });
    }
    // Torrents, rules and preferences fall back to the "default" ID, so deleting that tab moves
    // the next tab into the default slot and removes the next tab's former ID instead.
    const removed =
      id === "default" ? [...state.destinations.keys()].find((key) => key !== "default") : id;
    const successor = removed === undefined ? undefined : state.destinations.get(removed);
    if (!(removed && successor)) {
      return problem(409, { detail: "At least one tab is required" });
    }
    const reassigned = [...state.entries.values()].filter(
      (entry) => entry.detail.destinationId === removed
    );
    db.transaction((tx) => {
      for (const entry of reassigned) {
        save({ ...entry, detail: { ...entry.detail, destinationId: "default" } }, tx);
      }
      if (id === "default") {
        writeDestination({ ...successor, id: "default" }, tx);
        config("settings", { ...engineSettings, downloadPath: successor.downloadPath }, tx);
      }
      tx.delete(torrentDestinations).where(eq(torrentDestinations.id, removed)).run();
    });
    for (const entry of reassigned) {
      entry.detail.destinationId = "default";
    }
    if (id === "default") {
      state.destinations.set("default", { ...successor, id: "default" });
      engineSettings.downloadPath = successor.downloadPath;
    }
    state.destinations.delete(removed);
    changed("state");
    if (id === "default") {
      await diskSpace();
    }
    return { ok: true, removed };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep validation, state changes, and cleanup in the same lifecycle operation.
  async function moveDestination(destination: Destination) {
    const { id, downloadPath } = destination;
    const entries = [...state.entries.values()].filter(
      (entry) =>
        entry.detail.destinationId === id && resolvePath(entry.detail.savePath) !== downloadPath
    );
    const validationResult1 = validateMove(entries);
    if (validationResult1 instanceof ElysiaStatus) {
      return validationResult1;
    }
    state.movingDestinations.add(id);
    for (const entry of entries) {
      entry.moving = true;
      cancelRanges(entry.detail.id);
    }
    let running: Entry[] = [];
    let files: RelocatedFile[] = [];
    const originalPaths = new Map(entries.map((entry) => [entry, entry.detail.savePath]));
    const originalStorage = new Map(
      entries.map((entry) => [entry, { files: entry.storageFiles, root: entry.storageRoot }])
    );
    const originalDestination = state.destinations.get(id);
    const originalDefaultPath = engineSettings.downloadPath;
    const published: string[] = [];
    let staging: string | null = null;
    let journalId: string | null = null;
    let committed = false;
    await using cleanup = new AsyncDisposableStack();
    cleanup.defer(async () => {
      await diskSpace();
    });
    cleanup.defer(() => {
      state.movingDestinations.delete(id);
    });
    cleanup.defer(async () => {
      for (const entry of entries) {
        entry.moving = false;
      }
      await Promise.all(
        running.filter((entry) => !entry.torrent).map((entry) => startTorrent(entry))
      );
    });
    cleanup.defer(async () => {
      if (staging && !journalId) {
        await rm(staging, { force: true, recursive: true });
      }
    });
    const moved = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          yield* Effect.promise(() => Promise.allSettled(entries.map((entry) => entry.operation)));
          running = entries.filter(
            (entry) => !entry.paused && state.entries.get(entry.detail.id) === entry
          );
          const validationResult2 = validateMove(entries);
          if (validationResult2 instanceof ElysiaStatus) {
            return validationResult2;
          }
          yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => Promise.all(entries.map((entry) => stop(entry))),
          });
          const validationResult3 = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => prepareDestination(downloadPath),
          });
          if (validationResult3 instanceof ElysiaStatus) {
            return validationResult3;
          }
          staging = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => mkdtemp(join(downloadPath, ".tofu-move-")),
          });
          const stage = staging;
          const planned = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => planMove(entries, downloadPath, stage),
          });
          if (planned instanceof ElysiaStatus) {
            return planned;
          }
          files = planned;
          const sourceIdentities = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              Promise.all(
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
              ),
          });
          const moveId = `move:${crypto.randomUUID()}`;
          const journal = { committed: false, files: sourceIdentities, staging };
          yield* Effect.try({
            catch: (cause) => cause,
            try: () =>
              db
                .insert(operationReceipts)
                .values({
                  createdAt: Date.now(),
                  id: moveId,
                  kind: "move",
                  result: JSON.stringify(journal),
                  status: "pending",
                  target: id,
                })
                .run(),
          });
          journalId = moveId;
          const copies = yield* Effect.promise(() =>
            Promise.allSettled(files.map((file) => copyFile(file.source, file.staged)))
          );
          const failure = copies.find((result) => result.status === "rejected");
          if (failure?.status === "rejected") {
            return yield* Effect.fail(failure.reason);
          }
          yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => publishMove(files, published),
          });
          const movedRoot = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => storageRoot(downloadPath, null),
          });
          yield* Effect.try({
            catch: (cause) => cause,
            try: () =>
              db.transaction((tx) => {
                tx.update(operationReceipts)
                  .set({ result: JSON.stringify({ ...journal, committed: true }) })
                  .where(eq(operationReceipts.id, journalId as string))
                  .run();
                for (const entry of entries) {
                  entry.detail.savePath = downloadPath;
                  entry.storageRoot = movedRoot;
                  entry.storageFiles = [];
                  save(entry, tx);
                }
                storeDestination(destination, tx);
                if (id === "default") {
                  engineSettings.downloadPath = downloadPath;
                  config("settings", engineSettings, tx);
                }
              }),
          });
          committed = true;
          changed("state");
          const receiptId = journalId;
          const reconciled = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => finishMoveJournal(receiptId),
          });
          if (reconciled instanceof ElysiaStatus) {
            return reconciled;
          }
        })
      )
    );
    if (Result.isFailure(moved)) {
      if (!committed) {
        for (const [entry, path] of originalPaths) {
          entry.detail.savePath = path;
          entry.storageRoot = originalStorage.get(entry)?.root ?? null;
          entry.storageFiles = originalStorage.get(entry)?.files ?? [];
        }
        if (originalDestination) {
          state.destinations.set(id, originalDestination);
        }
        engineSettings.downloadPath = originalDefaultPath;
        if (journalId) {
          const rollback = await finishMoveJournal(journalId);
          if (rollback instanceof ElysiaStatus) {
            return rollback;
          }
        }
      }
      return moveError(moved.failure);
    }
    return moved.success;
  }

  /** Reconcile a persisted move using inode ownership before removing any old or published copy. */
  async function finishMoveJournal(id: string) {
    const receipt = db.select().from(operationReceipts).where(eq(operationReceipts.id, id)).get();
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
        const observed = await Effect.runPromise(
          Effect.result(
            Effect.tryPromise({
              catch: (cause) => cause,
              try: () => lstat(path),
            })
          )
        );
        if (Result.isFailure(observed)) {
          const cause = observed.failure;
          if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
            return;
          }
          throw cause;
        }
        const current = observed.success;
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
          const staging = await Effect.runPromise(
            Effect.result(
              Effect.tryPromise({
                catch: (cause) => cause,
                try: () => lstat(file.staged),
              })
            )
          );
          if (Result.isFailure(staging)) {
            const cause = staging.failure;
            if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
              return;
            }
            throw cause;
          }
          const staged = staging.success;
          if (current.dev !== staged.dev || current.ino !== staged.ino) {
            return;
          }
        }
        await rm(path);
      })
    );
    await rm(journal.staging, { force: true, recursive: true });
    db.update(operationReceipts)
      .set({ completedAt: Date.now(), status: journal.committed ? "done" : "failed" })
      .where(eq(operationReceipts.id, id))
      .run();
    return results.find((result) => result instanceof ElysiaStatus);
  }

  function validateMove(entries: Entry[]) {
    for (const entry of entries) {
      if (state.entries.get(entry.detail.id) !== entry) {
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

  function storageReservations(excluded: Set<Entry>) {
    const reserved = new Set<string>();
    for (const entry of state.entries.values()) {
      if (excluded.has(entry) || !entry.storageClaimed) {
        continue;
      }
      for (const file of entry.detail.files) {
        const key = storageKey(entry.detail.savePath, file.path);
        if (key instanceof ElysiaStatus) {
          return key;
        }
        reserved.add(key);
      }
    }
    return reserved;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep filesystem identity checks and recovery decisions in the same operation.
  async function planMove(entries: Entry[], downloadPath: string, staging: string) {
    const reserved = storageReservations(new Set(entries));
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
        const source = storagePath(entry.detail.savePath, file.path);
        if (source instanceof ElysiaStatus) {
          return source;
        }
        const sourceKey = storageKey(entry.detail.savePath, file.path);
        if (sourceKey instanceof ElysiaStatus) {
          return sourceKey;
        }
        const target = storagePath(downloadPath, file.path);
        if (target instanceof ElysiaStatus) {
          return target;
        }
        const targetKey = storageKey(downloadPath, file.path);
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

  async function publishMove(files: RelocatedFile[], published: string[]) {
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

  function canonicalStorageRoot(root: StorageIdentity) {
    return (
      [...state.entries.values()].find(
        (entry) =>
          entry.storageRoot?.dev === root.dev &&
          entry.storageRoot.ino === root.ino &&
          entry.storageRoot.canonicalPath
      )?.storageRoot?.canonicalPath ?? root.canonicalPath
    );
  }

  function storageKey(savePath: string, filePath: string) {
    const inspected = Effect.runSync(
      Effect.result(
        Effect.try({
          catch: (cause) => cause,
          try: () => canonicalStorageRoot(statSync(savePath)) ?? realpathSync(savePath),
        })
      )
    );
    if (Result.isFailure(inspected)) {
      const cause = inspected.failure;
      if (
        cause instanceof Error &&
        "code" in cause &&
        ["ENOENT", "EACCES", "EPERM", "ENODEV", "EIO"].includes(String(cause.code))
      ) {
        const root = [...state.entries.values()].find(
          (entry) => resolvePath(entry.detail.savePath) === resolvePath(savePath)
        )?.storageRoot;
        const canonical = root ? canonicalStorageRoot(root) : undefined;
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
    return resolvePath(inspected.success, filePath);
  }

  function storagePath(savePath: string, filePath: string) {
    const path = resolvePath(savePath, filePath);
    const within = relative(savePath, path);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) {
      return problem(400, { detail: "File path outside the download folder" });
    }
    let component = savePath;
    for (const part of within.split(sep)) {
      component = join(component, part);
      const inspected = Effect.runSync(
        Effect.result(
          Effect.try({
            catch: (cause) => cause,
            try: () => lstatSync(component),
          })
        )
      );
      if (Result.isFailure(inspected)) {
        const cause = inspected.failure;
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          break;
        }
        throw cause;
      }
      if (inspected.success.isSymbolicLink()) {
        return problem(409, { detail: "A symbolic link is present in the file path" });
      }
    }
    return path;
  }

  function resolveDestination(options: { destinationId?: string; downloadPath?: string }) {
    const chosen = state.destinations.get(options.destinationId ?? "");
    if (options.destinationId && !chosen) {
      return problem(404, { detail: "Tab not found" });
    }
    const downloadPath =
      chosen?.downloadPath ?? (options.downloadPath || engineSettings.downloadPath);
    if (!isAbsolute(downloadPath)) {
      return problem(400, { detail: "The download folder must be an absolute path" });
    }
    const destination = chosen ?? destinationForPath(downloadPath);
    if (state.movingDestinations.size > 0) {
      return problem(409, { detail: "Wait for the move to finish before adding a torrent" });
    }
    return destination;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep validation, state changes, and cleanup in the same lifecycle operation.
  async function add(
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
      const url = source;
      const downloaded = await Effect.runPromise(
        Effect.gen(function* () {
          const http = HttpClient.withScope(yield* HttpClient.HttpClient);
          const response = yield* http.get(url);
          if (response.status < 200 || response.status >= 300) {
            return problem(400, {
              detail: `The torrent file is inaccessible (HTTP ${response.status})`,
            });
          }
          return new Uint8Array(yield* response.arrayBuffer);
        }).pipe(Effect.timeout(15_000), Effect.scoped, Effect.provide(FetchHttpClient.layer))
      );
      if (downloaded instanceof ElysiaStatus) {
        return downloaded;
      }
      source = downloaded;
      if (source.length > 8 * 1024 * 1024) {
        return problem(400, { detail: "The torrent file is too large" });
      }
    }
    const decoded = await Effect.runPromise(
      Effect.result(
        Effect.tryPromise({
          catch: (cause) => cause,
          try: () => parseTorrent(source),
        })
      )
    );
    if (Result.isFailure(decoded)) {
      return problem(400, {
        detail: "Invalid magnet link or .torrent file (BitTorrent v1 required)",
      });
    }
    const parsed = decoded.success;
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
      const receipt = db
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
    const destination = resolveDestination(options);
    if (destination instanceof ElysiaStatus) {
      return destination;
    }
    const { downloadPath } = destination;
    const savePath = downloadPath;
    if (!state.destinations.has(destination.id)) {
      return problem(404, { detail: "Tab not found" });
    }
    if (state.movingDestinations.size > 0) {
      return problem(409, { detail: "Wait for the move to finish before adding a torrent" });
    }
    if (state.entries.has(id)) {
      return problem(409, { detail: "This torrent is already in your library" });
    }
    const validationResult4 = await prepareDestination(savePath);
    if (validationResult4 instanceof ElysiaStatus) {
      return validationResult4;
    }
    const root = await storageRoot(savePath, null);
    if (state.entries.has(id)) {
      return problem(409, { detail: "This torrent is already in your library" });
    }
    if (!state.destinations.has(destination.id) || state.movingDestinations.size > 0) {
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
    const retainedRow = db
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
    for (const file of parsed.files ?? []) {
      const located = Effect.runSync(
        Effect.result(
          Effect.try({
            catch: (cause) => cause,
            try: () => storagePath(savePath, file.path),
          })
        )
      );
      if (Result.isFailure(located)) {
        return problem(400, { detail: "The torrent contains an unsafe or inaccessible file path" });
      }
      const path = located.success;
      if (path instanceof ElysiaStatus) {
        return path;
      }
      const observed = Effect.runSync(
        Effect.result(
          Effect.try({
            catch: (cause) => cause,
            try: () => lstatSync(path),
          })
        )
      );
      if (Result.isFailure(observed)) {
        const cause = observed.failure;
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          continue;
        }
        return problem(400, { detail: "The torrent contains an unsafe or inaccessible file path" });
      }
      const existing = observed.success;
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
    }
    if (options.operationKey) {
      db.insert(operationReceipts)
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
    state.entries.set(id, entry);
    // Persist identity and metadata before the worker starts any file or network effect.
    save(entry);
    if (!options.paused) {
      await startTorrent(entry);
    }
    save(entry);
    if (options.operationKey) {
      db.update(operationReceipts)
        .set({ completedAt: Date.now(), status: "done" })
        .where(eq(operationReceipts.id, options.operationKey))
        .run();
    }
    return { id };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep filesystem identity checks and recovery decisions in the same operation.
  function storageCollision(entry: Entry, torrent: Torrent) {
    const reserved = storageReservations(new Set([entry]));
    if (reserved instanceof ElysiaStatus) {
      return reserved;
    }
    for (const file of torrent.files) {
      const key = storageKey(entry.detail.savePath, file.path);
      if (key instanceof ElysiaStatus) {
        return key;
      }
      if (reserved.has(key)) {
        return file;
      }
      const path = storagePath(entry.detail.savePath, file.path);
      if (path instanceof ElysiaStatus) {
        return path;
      }
      const owned = entry.storageFiles.find((item) => item.path === canonicalPath(file.path));
      if (entry.storageClaimed && !entry.validateRetained) {
        continue;
      }
      const observed = Effect.runSync(
        Effect.result(
          Effect.try({
            catch: (cause) => cause,
            try: () => lstatSync(path),
          })
        )
      );
      if (Result.isFailure(observed)) {
        const cause = observed.failure;
        if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
          continue;
        }
        throw cause;
      }
      const existing = observed.success;
      if (
        !(entry.storageClaimed && owned) ||
        existing.dev !== owned.dev ||
        existing.ino !== owned.ino ||
        existing.size !== owned.size ||
        existing.mtimeMs !== owned.mtimeMs
      ) {
        return file;
      }
    }
  }

  async function startTorrent(entry: Entry, options?: { checking: boolean }) {
    if (!options?.checking) {
      await inspectStorage(entry);
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
    entry.torrent = torrentClient.add(parsed, {
      deselect: true,
      path: entry.detail.savePath,
      paused: options?.checking || entry.paused,
      // Rely on the OS file cache instead of retaining 20 full pieces per torrent while idle.
      storeCacheSlots: 0,
    });
    const { torrent } = entry;
    scheduler.attach(torrent);
    const { detail } = entry;
    torrent.on("metadata", () => {
      entry.metadata = Buffer.from(torrent.torrentFile).toString("base64");
      const checked = Effect.runSync(
        Effect.result(
          Effect.try({
            catch: (cause) => cause,
            // This callback runs before WebTorrent verifies or writes its filesystem store.
            try: () => storageCollision(entry, torrent),
          })
        )
      );
      if (Result.isFailure(checked) || checked.success instanceof ElysiaStatus) {
        const cause = Result.isFailure(checked) ? checked.failure : checked.success;
        detail.error = cause instanceof Error ? cause.message : "Invalid file path";
        if (cause instanceof ElysiaStatus) {
          detail.error = cause.response.detail;
        }
        entry.torrent = null;
        entry.unwatch?.();
        torrent.destroy({ destroyStore: false });
        save(entry);
        return;
      }
      const collision = checked.success;
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
      save(entry);
    });
    // WebTorrent 3.0.21 compares against torrent.peerId rather than client.peerId.
    torrent.on("wire", (wire: Torrent["wires"][number], address: string | undefined) => {
      queueTelemetry();
      wire.once("close", queueTelemetry);
      if (wire.peerId !== torrentClient.peerId) {
        return;
      }
      if (address) {
        torrent.removePeer(address);
      }
      wire.destroy();
    });
    torrent.on("download", (bytes) => {
      state.dirtyEntries.add(entry);
      state.trafficDirty = true;
      detail.received += bytes;
      state.received += bytes;
      detail.lastTransferAt = Date.now();
      queueTelemetry();
    });
    torrent.on("upload", (bytes) => {
      state.dirtyEntries.add(entry);
      state.trafficDirty = true;
      detail.uploaded += bytes;
      state.uploaded += bytes;
      detail.lastTransferAt = Date.now();
      queueTelemetry();
    });
    torrent.on("verified", () => {
      state.dirtyEntries.add(entry);
      queueTelemetry();
    });
    torrent.on("error", (error) => {
      if (entry.torrent !== torrent) {
        return;
      }
      detail.error = String(error);
      const log = createLogger({
        component: "torrent-engine",
        context: { savePath: detail.savePath, torrentId: detail.id },
        dataDir: engineOptions.dataDir,
        error,
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
          dataDir: engineOptions.dataDir,
          expected: entry.storageRoot,
          savePath: detail.savePath,
          torrentId: detail.id,
        }
      );
      if (issue.kind !== "io-error" || (error instanceof Error && "code" in error)) {
        markStorageIssue(entry, issue);
      } else {
        save(entry);
      }
    });
    torrent.on("ready", () => {
      entry.metadata = Buffer.from(torrent.torrentFile).toString("base64");
      buildDetail(entry);
      if (!options?.checking) {
        const invalid = detail.files.filter(
          (file) =>
            file.priority !== "skip" && (file.downloaded ?? 0) < (expected.get(file.path) ?? 0)
        );
        if (invalid.length) {
          torrent.pause();
          const block = async () => {
            // The native event has no awaiting caller to observe this operation.
            const blocked = await Effect.runPromise(
              Effect.result(
                Effect.tryPromise({
                  catch: (error) => error,
                  try: () =>
                    serial(entry, () =>
                      blockStorage(entry, {
                        detectedAt: Date.now(),
                        kind: "modified-files",
                        message:
                          "Previously downloaded pieces are missing or invalid. Repair the download to continue.",
                        paths: invalid.map((file) => file.path),
                      })
                    ),
                })
              )
            );
            if (Result.isFailure(blocked)) {
              const log = createLogger({
                component: "storage",
                error: blocked.failure,
                operation: "block",
              });
              log.setLevel("error");
              log.emit();
            }
          };
          void block();
          return;
        }
        selectFiles(entry);
      }
      save(entry);
    });
    torrent.on("done", () => {
      detail.completedAt ??= Date.now();
      buildDetail(entry);
      save(entry);
      // Record completed file identities independently of periodic storage validation.
      const recordIdentity = async () => {
        // Observe filesystem and persistence failures at the native event boundary.
        const recorded = await Effect.runPromise(
          Effect.result(
            Effect.tryPromise({
              catch: (error) => error,
              try: () =>
                // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Record completed file identities within the torrent's operation queue.
                serial(entry, async () => {
                  const identities = new Map(entry.storageFiles.map((file) => [file.path, file]));
                  for (const file of detail.files) {
                    if (file.progress !== 1) {
                      continue;
                    }
                    const path = storagePath(detail.savePath, file.path);
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
                }),
            })
          )
        );
        if (Result.isFailure(recorded)) {
          const log = createLogger({
            component: "storage",
            context: { savePath: detail.savePath, torrentId: detail.id },
            dataDir: engineOptions.dataDir,
            error: recorded.failure,
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

  async function stop(entry: Entry) {
    cancelRanges(entry.detail.id);
    const { torrent } = entry;
    if (!torrent) {
      return;
    }
    buildDetail(entry);
    entry.unwatch?.();
    scheduler.detach(torrent);
    entry.torrent = null;
    if (await torrentClient.get(entry.detail.id)) {
      await new Promise<void>((resolve, reject) =>
        torrentClient.remove(torrent.infoHash, { destroyStore: false }, (error) =>
          error ? reject(error) : resolve()
        )
      );
    }
  }

  async function serial<Result>(
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
    using reservation = new DisposableStack();
    reservation.defer(() => reserved.resolve());
    await Promise.allSettled([previous]);
    if (state.entries.get(entry.detail.id) !== entry) {
      return problem(404, { detail: "Torrent not found" });
    }
    const result = await action();
    if (result instanceof ElysiaStatus) {
      return result;
    }
    if (state.entries.get(entry.detail.id) === entry) {
      if (options?.checkpoint) {
        state.dirtyEntries.add(entry);
      } else {
        save(entry);
      }
    }
    return result;
  }

  async function pause(id: string) {
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    const operationResult0 = await serial(entry, async () => {
      entry.paused = true;
      await stop(entry);
    });
    if (operationResult0 instanceof ElysiaStatus) {
      return operationResult0;
    }
    return { ok: true };
  }

  async function resume(id: string) {
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    const operationResult1 = await serial(entry, async () => {
      await inspectStorage(entry);
      if (entry.detail.storageIssue) {
        return problem(409, {
          detail: "Resolve the storage problem or repair the download before resuming",
        });
      }
      entry.paused = false;
      if (!entry.torrent) {
        await startTorrent(entry);
      }
    });
    if (operationResult1 instanceof ElysiaStatus) {
      return operationResult1;
    }
    return { ok: true };
  }

  async function replaceTrackers(id: string, urls: string[]) {
    const valid = trackerUrls(urls);
    if (valid instanceof ElysiaStatus) {
      return valid;
    }
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    const operationResult2 = await serial(entry, async () => {
      await stop(entry);
      entry.detail.trackers = valid.map(trackerStats);
      const parsed = await parseTorrent(entry.source);
      parsed.announce = valid;
      entry.source = toMagnetURI(parsed);
      entry.detail.magnet = entry.source;
      if (!entry.paused) {
        await startTorrent(entry);
      }
    });
    if (operationResult2 instanceof ElysiaStatus) {
      return operationResult2;
    }
    return { ok: true };
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Reconcile removal receipts before changing the torrent or its files.
  async function remove(id: string, deleteFiles: boolean, operationKey?: string) {
    if (operationKey) {
      const receipt = db
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
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    if (operationKey) {
      db.insert(operationReceipts)
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
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep file ownership checks and persisted removal in one serialized operation.
    const operationResult3 = await serial(entry, async () => {
      await stop(entry);
      if (deleteFiles && entry.storageClaimed) {
        const root = await Effect.runPromise(
          Effect.result(
            Effect.tryPromise({
              catch: (cause) => cause,
              try: () => storageRoot(entry.detail.savePath, entry.storageRoot),
            })
          )
        );
        if (Result.isFailure(root)) {
          return problem(409, {
            detail:
              "The original storage is unavailable. Reconnect it before deleting files, or remove the torrent while keeping its data.",
          });
        }
        const shared = storageReservations(new Set([entry]));
        if (shared instanceof ElysiaStatus) {
          return shared;
        }
        const paths: { key: string; path: string }[] = [];
        for (const file of entry.detail.files) {
          const key = storageKey(entry.detail.savePath, file.path);
          if (key instanceof ElysiaStatus) {
            return key;
          }
          const path = storagePath(entry.detail.savePath, file.path);
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
      state.entries.delete(id);
      state.dirtyEntries.delete(entry);
      state.persistedEntries.delete(entry);
      state.entryStructures.delete(entry);
      db.transaction((tx) => {
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
      changed("state");
    });
    if (operationResult3 instanceof ElysiaStatus) {
      return operationResult3;
    }
    return { ok: true };
  }

  function selectFiles(entry: Entry) {
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

  async function setFilePriority(id: string, index: number, priority: FilePriority) {
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    const operationResult4 = await serial(entry, () => {
      const file = buildDetail(entry).files[index];
      if (!file) {
        return problem(404, { detail: "File not found" });
      }
      file.priority = priority;
      selectFiles(entry);
    });
    if (operationResult4 instanceof ElysiaStatus) {
      return operationResult4;
    }
    return { ok: true };
  }

  function assertVerification(entry: Entry) {
    if (entry.verifying || entryStatus(entry) === "checking") {
      return problem(409, { detail: "Verification is already in progress for this torrent" });
    }
    if (!entry.metadata) {
      return problem(409, { detail: "Metadata must be available before verification" });
    }
  }

  async function verifyData(entry: Entry) {
    const preflight = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          entry.storageRoot = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => storageRoot(entry.detail.savePath, entry.storageRoot),
          });
          for (const file of entry.detail.files) {
            const path = yield* Effect.try({
              catch: (cause) => cause,
              try: () => storagePath(entry.detail.savePath, file.path),
            });
            if (path instanceof ElysiaStatus) {
              return path;
            }
            if (file.priority !== "skip") {
              yield* Effect.tryPromise({ catch: (cause) => cause, try: () => storedFile(path) });
            }
          }
        })
      )
    );
    if (Result.isFailure(preflight)) {
      const issue = storageFailure(
        preflight.failure,
        entry.detail.files.map((file) => file.path),
        {
          dataDir: engineOptions.dataDir,
          expected: entry.storageRoot,
          savePath: entry.detail.savePath,
          torrentId: entry.detail.id,
        }
      );
      await blockStorage(entry, issue);
      return problem(409, { detail: issue.message });
    }
    if (preflight.success instanceof ElysiaStatus) {
      return preflight.success;
    }
    await stop(entry);
    await startTorrent(entry, { checking: true });
    const { torrent } = entry;
    if (!torrent) {
      return problem(500, { detail: "Unable to verify" });
    }
    const verified = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const outcome = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () =>
              new Promise<"ready" | "timeout" | "closed">((resolve, reject) => {
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
              }),
          });
          if (outcome !== "ready") {
            yield* Effect.promise(() => stop(entry));
            return outcome === "timeout"
              ? problem(408, { detail: "Verification exceeded the 60-second timeout" })
              : problem(409, { detail: "Verification stopped before completion" });
          }
          buildDetail(entry);
          entry.storageFiles = [];
          const inspected = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => inspectFiles(entry),
          });
          if (inspected instanceof ElysiaStatus) {
            yield* Effect.promise(() =>
              blockStorage(entry, {
                detectedAt: Date.now(),
                kind: "invalid-path",
                message: inspected.response.detail,
                paths: entry.detail.files.map((file) => file.path),
              })
            );
            return inspected;
          }
          if (entry.torrent !== torrent) {
            return problem(409, {
              detail: entry.detail.storageIssue?.message ?? "Unable to verify storage",
            });
          }
        })
      )
    );
    if (Result.isFailure(verified)) {
      const cause = verified.failure;
      await stop(entry);
      entry.detail.error ??= cause instanceof Error ? cause.message : "Unable to verify storage";
      save(entry);
      throw cause;
    }
    return verified.success;
  }

  async function finishVerification(entry: Entry) {
    if (entry.paused || entry.detail.storageIssue) {
      await stop(entry);
    } else {
      selectFiles(entry);
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

  async function checkedOperation<Result>(entry: Entry, action: () => Promise<Result>) {
    const denied = assertVerification(entry);
    if (denied instanceof ElysiaStatus) {
      return denied;
    }
    const operation = serial(entry, action);
    entry.verifying = true;
    cancelRanges(entry.detail.id);
    using verification = new DisposableStack();
    verification.defer(() => {
      entry.verifying = false;
    });
    const result = await operation;
    if (result instanceof ElysiaStatus) {
      return result;
    }
    return { ok: true };
  }

  function verify(id: string) {
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    return checkedOperation(entry, async () => {
      const expected = new Map(
        buildDetail(entry).files.map((file) => [file.path, file.downloaded ?? 0])
      );
      await inspectStorage(entry);
      const validationResult5 = await verifyData(entry);
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
      await finishVerification(entry);
    });
  }

  function repair(id: string) {
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    return checkedOperation(entry, async () => {
      const validationResult6 = await verifyData(entry);
      if (validationResult6 instanceof ElysiaStatus) {
        return validationResult6;
      }
      entry.detail.storageIssue = null;
      entry.detail.error = null;
      await finishVerification(entry);
    });
  }

  function assertLocation(entry: Entry, path: string) {
    const reserved = storageReservations(new Set([entry]));
    if (reserved instanceof ElysiaStatus) {
      return reserved;
    }
    for (const file of entry.detail.files) {
      const target = storagePath(path, file.path);
      if (target instanceof ElysiaStatus) {
        return target;
      }
      const key = storageKey(path, file.path);
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

  function locate(id: string, downloadPath: string) {
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    if (!isAbsolute(downloadPath)) {
      return problem(400, { detail: "The folder must be an absolute path" });
    }
    const path = resolvePath(downloadPath);
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Keep filesystem identity checks and recovery decisions in the same operation.
    return checkedOperation(entry, async () => {
      const location = await Effect.runPromise(
        Effect.result(
          Effect.gen(function* () {
            const root = yield* Effect.tryPromise({
              catch: (cause) => cause,
              try: () => storageRoot(path, null),
            });
            const denied = yield* Effect.try({
              catch: (cause) => cause,
              try: () => assertLocation(entry, path),
            });
            return denied instanceof ElysiaStatus ? denied : root;
          })
        )
      );
      if (Result.isFailure(location)) {
        return problem(409, {
          detail: storageFailure(location.failure, [], {
            dataDir: engineOptions.dataDir,
            savePath: path,
            torrentId: id,
          }).message,
        });
      }
      if (location.success instanceof ElysiaStatus) {
        return location.success;
      }
      const root = location.success;
      await stop(entry);
      const checked = Effect.runSync(
        Effect.result(
          Effect.try({
            catch: (cause) => cause,
            try: () => assertLocation(entry, path),
          })
        )
      );
      if (Result.isFailure(checked) || checked.success instanceof ElysiaStatus) {
        if (!(entry.paused || entry.detail.storageIssue)) {
          await startTorrent(entry);
        }
        if (Result.isFailure(checked)) {
          throw checked.failure;
        }
        return checked.success;
      }
      entry.detail.savePath = path;
      entry.storageRoot = root;
      entry.storageFiles = [];
      entry.storageClaimed = true;
      const validationResult9 = await verifyData(entry);
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
      await finishVerification(entry);
    });
  }

  async function addPeer(id: string, peer: string) {
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    if (!entry.torrent || entry.paused) {
      return problem(409, { detail: "Resume the torrent before adding a peer" });
    }
    if (
      entry.torrent.ready &&
      entry.torrent.done &&
      engineSettings.seedingConnectionMode === "incoming-only"
    ) {
      return problem(409, {
        detail:
          "Switch seeding connections to Balanced before adding an outgoing peer to a completed torrent",
      });
    }
    const address = URL.parse(`tcp://${peer}`);
    if (!address) {
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
    save(entry);
    return { ok: true };
  }

  async function updateSettings(settings: SettingsInput) {
    if (settings.downloadPath !== undefined && !isAbsolute(settings.downloadPath)) {
      return problem(400, { detail: "The folder must be an absolute path" });
    }
    const destination = state.destinations.get("default");
    if (destination && settings.downloadPath !== undefined) {
      await saveDestination("default", {
        downloadPath: settings.downloadPath,
        moveFiles: settings.moveFiles,
        name: destination.name,
      });
    }
    Object.assign(engineSettings, {
      deleteTorrentFileAfterAdd:
        settings.deleteTorrentFileAfterAdd ?? engineSettings.deleteTorrentFileAfterAdd,
      downloadLimit: settings.downloadLimit ?? engineSettings.downloadLimit,
      downloadPath:
        settings.downloadPath === undefined
          ? engineSettings.downloadPath
          : resolvePath(settings.downloadPath),
      runInBackground: settings.runInBackground ?? engineSettings.runInBackground,
      seedingConnectionMode: settings.seedingConnectionMode ?? engineSettings.seedingConnectionMode,
      theme: settings.theme ?? engineSettings.theme,
      uploadLimit: settings.uploadLimit ?? engineSettings.uploadLimit,
    });
    torrentClient.throttleDownload(engineSettings.downloadLimit);
    torrentClient.throttleUpload(engineSettings.uploadLimit);
    scheduler.setSeedingMode(engineSettings.seedingConnectionMode);
    torrentClient.seedOutgoingConnections = engineSettings.seedingConnectionMode === "balanced";
    config("settings", engineSettings);
    await diskSpace();
    return engineSettings;
  }

  function reannounce(id: string) {
    const entry = get(id);
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

  function get(id: string) {
    const entry = state.entries.get(id);
    if (!entry) {
      return problem(404, { detail: "Torrent not found" });
    }
    return entry;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Preserve the existing summary calculation while moving it into the engine closure.
  function summarizeTorrent(entry: Entry): TorrentDetail {
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

  function buildDetail(entry: Entry): TorrentDetail {
    const detail = summarizeTorrent(entry);
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

  function readDetail(id: string) {
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    return buildDetail(entry);
  }

  function snapshot(selected: string | null, includeDetail?: boolean): DashboardState {
    const entries = [...state.entries.values()];
    const details = entries.map((entry) => summarizeTorrent(entry));
    const chosen = selected ? state.entries.get(selected) : entries[0];
    return {
      destinations: [...state.destinations.values()],
      detail: includeDetail !== false && chosen ? buildDetail(chosen) : null,
      history: [...state.history],
      session: {
        active: details.filter((detail) => !["paused", "error"].includes(detail.status)).length,
        dhtNodes:
          (torrentClient.dht as { nodes?: { count: () => number } } | null)?.nodes?.count() ?? 0,
        downloadSpeed: torrentClient.downloadSpeed,
        engine: WebTorrent.VERSION,
        freeSpace: state.freeSpace,
        mode: state.mode,
        peers: details.reduce((sum, detail) => sum + detail.peers, 0),
        port: torrentClient.torrentPort,
        received: state.received,
        startedAt: state.startedAt,
        uploaded: state.uploaded,
        uploadSpeed: torrentClient.uploadSpeed,
      },
      settings: engineSettings,
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
  async function waitForRange(
    request: string,
    id: string,
    index: number,
    start: number,
    end: number
  ) {
    const entry = get(id);
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
    const stats = buildDetail(entry).files[index];
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
    const path = storagePath(entry.detail.savePath, stats.path);
    if (path instanceof ElysiaStatus) {
      return path;
    }
    const first = Math.floor((file.offset + start) / torrent.pieceLength);
    const last = Math.floor((file.offset + end) / torrent.pieceLength);
    // These stream selections are pinned to WebTorrent 3.0.21. Unlike public
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
    const previous = state.readAhead.get(playing);
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
    state.readAhead.set(playing, {
      id,
      release,
      // A player that stopped reading gives the bandwidth back to the whole torrent.
      timer: setTimeout(() => {
        release();
        state.readAhead.delete(playing);
      }, 30_000),
    });
    if (!missing()) {
      const identity = await lstat(path);
      return { identity: { dev: identity.dev, ino: identity.ino }, path };
    }
    const controller = new AbortController();
    state.ranges.set(request, { controller, id });
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]);
    // The first request also fetches the end of the file, where containers often keep indexes.
    const tail = start === 0 ? Math.max(first, fileLast - 1) : null;
    const stopped = () => controller.abort();
    using waiting = new DisposableStack();
    waiting.defer(() => {
      torrent.off("close", stopped);
      if (tail !== null && !runtime.destroyed) {
        runtime._deselect(tail, fileLast, true);
      }
      state.ranges.delete(request);
    });
    torrent.once("close", stopped);
    if (tail !== null) {
      runtime._select(tail, fileLast, 15, null, true);
    }
    const waited = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          while (missing()) {
            yield* Effect.tryPromise({
              catch: (cause) => cause,
              try: () => once(torrent, "verified", { signal }),
            });
          }
          const identity = yield* Effect.tryPromise({
            catch: (cause) => cause,
            try: () => lstat(path),
          });
          return { identity: { dev: identity.dev, ino: identity.ino }, path };
        })
      )
    );
    if (Result.isFailure(waited)) {
      if (controller.signal.aborted) {
        return problem(499, { detail: "Playback stopped" });
      }
      if (signal.aborted) {
        return problem(504, {
          detail: "No peer sent this part of the file. Try again when more peers are available.",
        });
      }
      throw waited.failure;
    }
    return waited.success;
  }

  function cancelRange(request: string) {
    state.ranges.get(request)?.controller.abort();
  }

  function cancelRanges(id?: string) {
    for (const range of state.ranges.values()) {
      if (id === undefined || range.id === id) {
        range.controller.abort();
      }
    }
    for (const [playing, readAhead] of state.readAhead) {
      if (id === undefined || readAhead.id === id) {
        clearTimeout(readAhead.timer);
        readAhead.release();
        state.readAhead.delete(playing);
      }
    }
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validate availability and file identity before exposing a disk path.
  async function readFile(id: string, index: number) {
    const entry = get(id);
    if (entry instanceof ElysiaStatus) {
      return entry;
    }
    if (!(entry.verifying || entry.moving)) {
      const operationResult5 = await serial(entry, () => inspectStorage(entry));
      if (operationResult5 instanceof ElysiaStatus) {
        return operationResult5;
      }
    }
    const detail = buildDetail(entry);
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
    const path = storagePath(detail.savePath, file.path);
    if (path instanceof ElysiaStatus) {
      return path;
    }
    if (!(await Bun.file(path).exists())) {
      return problem(404, { detail: `The downloaded file is no longer present : ${path}` });
    }
    const identity = await lstat(path);
    return { identity: { dev: identity.dev, ino: identity.ino }, name: file.name, path };
  }

  async function close() {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: A prior lifecycle close can change this state.
    if (state.closed) {
      return;
    }
    state.closed = true;
    cancelRanges();
    await using lifetime = new AsyncDisposableStack();
    lifetime.defer(() => cryptoDiagnostics?.close());
    lifetime.defer(async () => {
      if (!torrentClient.destroyed) {
        let deadline: ReturnType<typeof setTimeout> | undefined;
        using timeout = new DisposableStack();
        timeout.defer(() => clearTimeout(deadline));
        await Promise.race([
          new Promise<void>((resolve, reject) =>
            torrentClient.destroy((error) => (error ? reject(error) : resolve()))
          ),
          new Promise<void>((resolve) => {
            deadline = setTimeout(resolve, 1000);
          }),
        ]);
      }
    });
    clearInterval(state.timer);
    if (state.telemetryTimer) {
      clearTimeout(state.telemetryTimer);
    }
    scheduler.close();
    state.listeners.clear();
    await state.diskCheck;
    await state.storageCheck;
    await Promise.allSettled(destinationOperation ? [destinationOperation] : []);
    await Promise.allSettled([...state.entries.values()].map((entry) => entry.operation));
    // Drain torrent stores before bounding cleanup of remote router mappings.
    const stopped = await Promise.allSettled(
      [...state.entries.values()].map((entry) => stop(entry))
    );
    const failed = stopped.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") {
      throw failed.reason;
    }
    for (const entry of state.entries.values()) {
      save(entry);
    }
    config("traffic", { received: state.received, uploaded: state.uploaded });
  }
  startup.move();
  await using recovery = new AsyncDisposableStack();
  recovery.defer(close);
  // Reconcile receipts before a restored torrent may resume writing to storage.
  for (const receipt of db
    .select()
    .from(operationReceipts)
    .where(eq(operationReceipts.status, "pending"))
    .all()) {
    if (receipt.kind === "move") {
      // biome-ignore lint/performance/noAwaitInLoops: Filesystem recovery precedes all torrent starts.
      const recovered = await finishMoveJournal(receipt.id);
      if (recovered instanceof ElysiaStatus) {
        throw new Error(recovered.response.detail);
      }
    } else if (receipt.kind === "add") {
      db.update(operationReceipts)
        .set({
          completedAt: Date.now(),
          status: state.entries.has(receipt.target) ? "done" : "failed",
        })
        .where(eq(operationReceipts.id, receipt.id))
        .run();
    } else if (receipt.kind === "remove") {
      if (state.entries.has(receipt.target)) {
        const removed = await remove(
          receipt.target,
          JSON.parse(receipt.result ?? "{}").deleteFiles === true,
          receipt.id
        );
        if (removed instanceof ElysiaStatus) {
          throw new Error(removed.response.detail);
        }
      } else {
        db.update(operationReceipts)
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
  if (state.entries.size === 0) {
    await mkdir(engineSettings.downloadPath, { recursive: true });
  }
  await diskSpace();
  await Promise.all(
    [...state.entries.values()].map(async (entry) => {
      await inspectStorage(entry);
      if (!entry.paused) {
        await startTorrent(entry);
      }
    })
  );
  state.telemetryValues = measureTelemetry();

  recovery.move();
  return {
    add,
    addPeer,
    assertReady,
    cancelRange,
    cancelRanges,
    client: torrentClient,
    close,
    connectionDiagnostics,
    detail: readDetail,
    file: readFile,
    get,
    locate,
    get mode() {
      return state.mode;
    },
    set mode(value: "desktop" | "server") {
      state.mode = value;
    },
    pause,
    priority: setFilePriority,
    reannounce,
    refreshSnapshot,
    remove,
    removeDestination,
    repair,
    replaceTrackers,
    resume,
    saveDestination,
    settings: engineSettings,
    snapshot,
    get stateRevision() {
      return state.stateRevision;
    },
    subscribeChanges,
    get telemetryRevision() {
      return state.telemetryRevision;
    },
    updateDestinationPresentation,
    updateSettings,
    verify,
    waitForRange,
  };
}

export type TorrentEngine = Awaited<ReturnType<typeof openTorrentEngine>>;

export type EnginePort = Context.Service.Shape<typeof TorrentClient>;

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
