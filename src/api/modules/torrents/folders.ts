import { type FSWatcher, watch } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { eq } from "drizzle-orm";
import { Cause, Context, Effect, Layer, Result, Scope } from "effect";
import { ElysiaStatus } from "elysia";
import { createLogger } from "evlog";
import parseTorrent from "parse-torrent";
import { watchedTorrentFiles } from "../../../db/schema";
import { nativeControl } from "../../../native/control";
import { Database } from "../../lib/database-layer";
import { instance } from "../../lib/instance";
import type { Destination } from "../destinations/model";
import type { EnginePort } from "./service";

const RESCAN_MS = 30_000;

export class TorrentFolderEngine extends Context.Service<TorrentFolderEngine, EnginePort>()(
  "tofu/torrent-folders/engine"
) {}

/** Adds the .torrent files that appear in the folder of each thread that opted in. */
const make = Effect.gen(function* () {
  const db = yield* Database;
  const engine = yield* TorrentFolderEngine;
  const { dataDir } = instance;
  const watchers = new Map<string, FSWatcher | null>();
  const scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  const processing = new Set<string>();
  const lifetime = new AbortController();

  const tasks = yield* Scope.fork(yield* Effect.scope, "parallel");
  const runFork = Effect.runForkWith(yield* Effect.context<never>());

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      lifetime.abort();
      for (const timer of scheduled.values()) {
        clearTimeout(timer);
      }
      scheduled.clear();
      for (const watcher of watchers.values()) {
        watcher?.close();
      }
      watchers.clear();
    })
  );

  /** Follows the current thread folders and checks each watched folder for new files. */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Reconcile native watchers and retry failed folders before scanning.
  const syncFolders = Effect.fn("TorrentFolders.sync")(function* () {
    if (lifetime.signal.aborted) {
      return;
    }
    const snapshot = yield* Effect.result(Effect.try(() => engine.snapshot(null, false)));
    if (Result.isFailure(snapshot)) {
      // The engine stopped; its failure is reported by the engine itself.
      return;
    }
    const folders = new Set(
      snapshot.success.destinations
        .filter((destination) => destination.autoAddTorrentFilesSince !== null)
        .map((destination) => destination.downloadPath)
    );
    for (const [folder, watcher] of watchers) {
      if (!folders.has(folder)) {
        watcher?.close();
        watchers.delete(folder);
      }
    }
    for (const folder of folders) {
      if (!watchers.get(folder)) {
        const retrying = watchers.has(folder);
        const opened = yield* Effect.result(
          Effect.try(() =>
            // Only the folder itself is watched: torrent contents may include .torrent files.
            watch(folder, (_event, name) => {
              if (name && extname(name).toLowerCase() === ".torrent") {
                schedule(join(folder, name), 500);
              }
            })
          )
        );
        if (Result.isFailure(opened)) {
          watchers.set(folder, null);
          // The rescan retries every interval; report the failure once.
          if (!retrying) {
            const log = createLogger({
              component: "torrent-folders",
              context: { folder },
              dataDir,
              error: opened.failure,
              operation: "watch",
            });
            log.setLevel("warn");
            log.emit();
          }
          continue;
        }
        const watcher = opened.success;
        watchers.set(folder, watcher);
        watcher.on("error", (error) => {
          watcher.close();
          watchers.set(folder, null);
          const log = createLogger({
            component: "torrent-folders",
            context: { folder },
            dataDir,
            error,
            operation: "watch",
          });
          log.setLevel("warn");
          log.emit();
        });
      }
      yield* Effect.forkIn(scan(folder), tasks);
    }
  });

  const scan = Effect.fn("TorrentFolders.scan")(function* (folder: string) {
    const names = yield* Effect.result(Effect.tryPromise(() => readdir(folder)));
    if (Result.isFailure(names)) {
      return;
    }
    for (const name of names.success) {
      if (extname(name).toLowerCase() === ".torrent") {
        schedule(join(folder, name), 0);
      }
    }
  });

  function schedule(path: string, delay: number) {
    if (lifetime.signal.aborted) {
      return;
    }
    clearTimeout(scheduled.get(path));
    const timer = setTimeout(() => {
      scheduled.delete(path);
      if (lifetime.signal.aborted || processing.has(path)) {
        return;
      }
      processing.add(path);
      // This native callback has no awaiting caller; observe failures before releasing its slot.
      const operation = processFile(path).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            if (result instanceof ElysiaStatus) {
              const log = createLogger({
                component: "torrent-folders",
                context: { path },
                dataDir,
                error: result.response,
                operation: "add",
              });
              log.setLevel("error");
              log.emit();
            }
          })
        ),
        Effect.catchCause((cause) =>
          Effect.sync(() => {
            const log = createLogger({
              component: "torrent-folders",
              context: { path },
              dataDir,
              error: Cause.squash(cause),
              operation: "add",
            });
            log.setLevel("error");
            log.emit();
          })
        ),
        Effect.ensuring(Effect.sync(() => processing.delete(path))),
        // Finish an import already sent to the worker before its engine is closed.
        Effect.uninterruptible
      );
      runFork(Effect.forkIn(operation, tasks));
    }, delay);
    timer.unref();
    scheduled.set(path, timer);
  }

  const processFile = Effect.fn("TorrentFolders.processFile")(function* (path: string) {
    const snapshot = yield* Effect.try(() => engine.snapshot(null, false));
    const destination = snapshot.destinations.find(
      (item) => item.autoAddTorrentFilesSince !== null && item.downloadPath === dirname(path)
    );
    if (!destination?.autoAddTorrentFilesSince) {
      return;
    }
    const file = Bun.file(path);
    const info = yield* Effect.result(Effect.tryPromise(() => file.stat()));
    if (Result.isFailure(info)) {
      return;
    }
    // A copied or moved file keeps its modification time but gets a new change time.
    const changedAt = Math.floor(Math.max(info.success.mtimeMs, info.success.ctimeMs));
    if (!info.success.isFile() || changedAt < destination.autoAddTorrentFilesSince) {
      return;
    }
    const seen = db
      .select()
      .from(watchedTorrentFiles)
      .where(eq(watchedTorrentFiles.path, path))
      .get();
    if (seen?.changedAt === changedAt) {
      return;
    }
    const age = Date.now() - changedAt;
    // Browsers may create the file before writing it; wait until it stops changing.
    if (age < 1000 || info.success.size === 0) {
      if (age < 60_000) {
        schedule(path, 1000);
      }
      return;
    }
    const infoHash = yield* importTorrentFile(path, destination, info.success.size, age);
    if (infoHash instanceof ElysiaStatus) {
      return infoHash;
    }
    if (infoHash === undefined) {
      return;
    }
    // Remember the file so a torrent removed from the library is not added again.
    db.insert(watchedTorrentFiles)
      .values({ changedAt, infoHash, path })
      .onConflictDoUpdate({ set: { changedAt, infoHash }, target: watchedTorrentFiles.path })
      .run();
  });

  /**
   * Adds the torrent file to its thread. Returns the info hash to remember, null for an unusable
   * file, a returned API failure, or undefined when the file was deleted or will be checked again.
   */
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Validate, import and optionally remove the source file as one ordered operation.
  const importTorrentFile = Effect.fn("TorrentFolders.importTorrentFile")(function* (
    path: string,
    destination: Destination,
    size: number,
    age: number
  ) {
    if (size > 8 * 1024 * 1024) {
      const log = createLogger({
        component: "torrent-folders",
        context: { path, size },
        dataDir,
        operation: "skip-large-file",
      });
      log.setLevel("warn");
      log.emit();
      return null;
    }
    const bytes = yield* Effect.tryPromise(() => Bun.file(path).bytes());
    const parsed = yield* Effect.result(Effect.tryPromise(() => parseTorrent(bytes)));
    if (Result.isFailure(parsed)) {
      if (age < 60_000) {
        schedule(path, 2000);
        return;
      }
      const log = createLogger({
        component: "torrent-folders",
        context: { path },
        dataDir,
        error: parsed.failure,
        operation: "skip-invalid-file",
      });
      log.setLevel("warn");
      log.emit();
      return null;
    }
    const { infoHash } = parsed.success;
    const context = { destinationId: destination.id, path, torrentId: infoHash };
    const snapshot = yield* Effect.try(() => engine.snapshot(null, false));
    if (!snapshot.torrents.some((torrent) => torrent.id === infoHash)) {
      const added = yield* Effect.tryPromise(() =>
        engine.call("add", [bytes, { destinationId: destination.id, paused: false }])
      );
      if (added instanceof ElysiaStatus) {
        return added;
      }
      const log = createLogger({
        component: "torrent-folders",
        context,
        dataDir,
        operation: "add",
      });
      log.emit();
      if (nativeControl.tofuNativeSdk) {
        nativeControl.tofuNativeSdk.Utils.showNotification({
          body: `${[parsed.success.name].flat()[0] || infoHash} was added to ${destination.name}`,
          title: "Torrent added",
        });
      }
    }
    if (!(destination.deleteTorrentFileAfterAdd ?? engine.settings().deleteTorrentFileAfterAdd)) {
      return infoHash;
    }
    const deleted = yield* Effect.result(Effect.tryPromise(() => Bun.file(path).delete()));
    if (Result.isFailure(deleted)) {
      const log = createLogger({
        component: "torrent-folders",
        context: { path },
        dataDir,
        error: deleted.failure,
        operation: "delete-source",
      });
      log.setLevel("warn");
      log.emit();
      return infoHash;
    }
    db.delete(watchedTorrentFiles).where(eq(watchedTorrentFiles.path, path)).run();
  });

  const rescan = yield* Effect.acquireRelease(
    Effect.sync(() => setInterval(() => runFork(Effect.forkIn(syncFolders(), tasks)), RESCAN_MS)),
    (interval) => Effect.sync(() => clearInterval(interval))
  );
  rescan.unref();
  yield* syncFolders();
  return { sync: syncFolders() };
});

export class TorrentFolders extends Context.Service<TorrentFolders, Effect.Success<typeof make>>()(
  "tofu/torrent-folders"
) {}

export const torrentFoldersLayer = Layer.effect(TorrentFolders, make);
