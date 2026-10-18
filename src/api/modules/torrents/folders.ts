import { type FSWatcher, watch } from "node:fs";
import { readdir, stat, unlink } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import { eq } from "drizzle-orm";
import parseTorrent from "parse-torrent";
import { watchedTorrentFiles } from "../../../db/schema";
import type { Destination, EnginePort } from "../../../types";
import type { TofuDatabase } from "../../lib/db";
import { recordLog } from "../../lib/diagnostics";
import { runtime } from "../../lib/runtime";

interface TorrentFoldersOptions {
  dataDir: string;
  db: TofuDatabase;
  engine: EnginePort;
  /** Interval of the full rescan that catches events missed by the file system. */
  rescanMs?: number;
}

/** Adds the .torrent files that appear in the folder of each thread that opted in. */
export class TorrentFolders {
  private readonly options: TorrentFoldersOptions;
  private readonly watchers = new Map<string, FSWatcher | null>();
  private readonly scheduled = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly processing = new Map<string, Promise<void>>();
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly lifetime = new AbortController();

  constructor(options: TorrentFoldersOptions) {
    this.options = options;
    this.timer = setInterval(() => this.sync(), options.rescanMs ?? 30_000);
    this.timer.unref();
    this.sync();
  }

  /** Follows the current thread folders and checks each watched folder for new files. */
  sync() {
    if (this.lifetime.signal.aborted) {
      return;
    }
    let destinations: Destination[];
    try {
      ({ destinations } = this.options.engine.snapshot(null, false));
    } catch {
      // The engine stopped; its failure is reported by the engine itself.
      return;
    }
    const folders = new Set(
      destinations
        .filter((destination) => destination.autoAddTorrentFilesSince !== null)
        .map((destination) => destination.downloadPath)
    );
    for (const [folder, watcher] of this.watchers) {
      if (!folders.has(folder)) {
        watcher?.close();
        this.watchers.delete(folder);
      }
    }
    for (const folder of folders) {
      if (!this.watchers.get(folder)) {
        const retrying = this.watchers.has(folder);
        try {
          // Only the folder itself is watched: torrent contents may include .torrent files.
          const watcher = watch(folder, (_event, name) => {
            if (name && extname(name).toLowerCase() === ".torrent") {
              this.schedule(join(folder, name), 500);
            }
          });
          watcher.on("error", (error) => {
            watcher.close();
            this.watchers.set(folder, null);
            recordLog({
              component: "torrent-folders",
              context: { folder },
              dataDir: this.options.dataDir,
              error,
              level: "warn",
              operation: "watch",
            });
          });
          this.watchers.set(folder, watcher);
        } catch (error) {
          this.watchers.set(folder, null);
          // The rescan retries every interval; report the failure once.
          if (!retrying) {
            recordLog({
              component: "torrent-folders",
              context: { folder },
              dataDir: this.options.dataDir,
              error,
              level: "warn",
              operation: "watch",
            });
          }
          continue;
        }
      }
      void this.scan(folder);
    }
  }

  private async scan(folder: string) {
    let names: string[];
    try {
      names = await readdir(folder);
    } catch {
      return;
    }
    for (const name of names) {
      if (extname(name).toLowerCase() === ".torrent") {
        this.schedule(join(folder, name), 0);
      }
    }
  }

  private schedule(path: string, delay: number) {
    if (this.lifetime.signal.aborted) {
      return;
    }
    clearTimeout(this.scheduled.get(path));
    const timer = setTimeout(async () => {
      this.scheduled.delete(path);
      if (this.lifetime.signal.aborted || this.processing.has(path)) {
        return;
      }
      const operation = this.process(path);
      this.processing.set(path, operation);
      try {
        await operation;
      } catch (error) {
        recordLog({
          component: "torrent-folders",
          context: { path },
          dataDir: this.options.dataDir,
          error,
          level: "error",
          operation: "add",
        });
      } finally {
        this.processing.delete(path);
      }
    }, delay);
    timer.unref();
    this.scheduled.set(path, timer);
  }

  private async process(path: string) {
    const { db, engine } = this.options;
    const destination = engine
      .snapshot(null, false)
      .destinations.find(
        (item) => item.autoAddTorrentFilesSince !== null && item.downloadPath === dirname(path)
      );
    if (!destination?.autoAddTorrentFilesSince) {
      return;
    }
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(path);
    } catch {
      return;
    }
    // A copied or moved file keeps its modification time but gets a new change time.
    const changedAt = Math.floor(Math.max(info.mtimeMs, info.ctimeMs));
    if (!info.isFile() || changedAt < destination.autoAddTorrentFilesSince) {
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
    if (age < 1000 || info.size === 0) {
      if (age < 60_000) {
        this.schedule(path, 1000);
      }
      return;
    }
    const infoHash = await this.import(path, destination, info.size, age);
    if (infoHash === undefined) {
      return;
    }
    // Remember the file so a torrent removed from the library is not added again.
    db.insert(watchedTorrentFiles)
      .values({ changedAt, infoHash, path })
      .onConflictDoUpdate({ set: { changedAt, infoHash }, target: watchedTorrentFiles.path })
      .run();
  }

  /**
   * Adds the torrent file to its thread. Returns the info hash to remember, null for an unusable
   * file, or undefined when the file was deleted or will be checked again.
   */
  private async import(path: string, destination: Destination, size: number, age: number) {
    const { db, engine, dataDir } = this.options;
    if (size > 8 * 1024 * 1024) {
      recordLog({
        component: "torrent-folders",
        context: { path, size },
        dataDir,
        level: "warn",
        operation: "skip-large-file",
      });
      return null;
    }
    const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
    let parsed: Awaited<ReturnType<typeof parseTorrent>>;
    try {
      parsed = await parseTorrent(bytes);
    } catch (error) {
      if (age < 60_000) {
        this.schedule(path, 2000);
        return;
      }
      recordLog({
        component: "torrent-folders",
        context: { path },
        dataDir,
        error,
        level: "warn",
        operation: "skip-invalid-file",
      });
      return null;
    }
    const { infoHash } = parsed;
    const context = { destinationId: destination.id, path, torrentId: infoHash };
    if (!engine.snapshot(null, false).torrents.some((torrent) => torrent.id === infoHash)) {
      try {
        await engine.add(bytes, { destinationId: destination.id, paused: false });
      } catch (error) {
        recordLog({
          component: "torrent-folders",
          context,
          dataDir,
          error,
          level: "error",
          operation: "add",
        });
        return infoHash;
      }
      recordLog({
        component: "torrent-folders",
        context,
        dataDir,
        level: "info",
        operation: "add",
      });
      if (runtime.current.kind === "desktop") {
        runtime.current.desktop.notifications.show({
          body: `${[parsed.name].flat()[0] || infoHash} was added to ${destination.name}`,
          title: "Torrent added",
        });
      }
    }
    if (!(destination.deleteTorrentFileAfterAdd ?? engine.settings.deleteTorrentFileAfterAdd)) {
      return infoHash;
    }
    try {
      await unlink(path);
    } catch (error) {
      recordLog({
        component: "torrent-folders",
        context: { path },
        dataDir,
        error,
        level: "warn",
        operation: "delete-source",
      });
      return infoHash;
    }
    db.delete(watchedTorrentFiles).where(eq(watchedTorrentFiles.path, path)).run();
  }

  async close() {
    this.lifetime.abort();
    clearInterval(this.timer);
    for (const timer of this.scheduled.values()) {
      clearTimeout(timer);
    }
    this.scheduled.clear();
    for (const watcher of this.watchers.values()) {
      watcher?.close();
    }
    this.watchers.clear();
    await Promise.allSettled(this.processing.values());
  }
}
