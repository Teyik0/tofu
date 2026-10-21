import { EventEmitter } from "node:events";
import { unlink } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ElysiaStatus, problem } from "elysia";
import parseTorrent from "parse-torrent";
import type { EnginePort, TorrentAddOptions } from "../torrents/service";

interface StagedTorrent {
  opened: OpenedTorrent;
  source: string | Uint8Array;
  sourcePath: string | null;
}

/**
 * Holds magnet links and .torrent files opened from the system until the interface adds or
 * dismisses them. Furin delivers native events in order after application startup.
 */
export class TorrentOpenings extends EventEmitter<{ change: [] }> {
  private readonly staged = new Map<string, StagedTorrent>();

  constructor() {
    super();
    // Every open window follows the waiting torrents.
    this.setMaxListeners(0);
  }

  list() {
    return [...this.staged.values()].map((item) => item.opened);
  }

  async stage(input: string, engine: EnginePort) {
    const url = new URL(input);
    let source: string | Uint8Array;
    let sourcePath: string | null = null;
    if (url.protocol === "magnet:") {
      source = input;
    } else if (url.protocol === "file:") {
      const path = fileURLToPath(url);
      if (extname(path).toLowerCase() !== ".torrent") {
        return problem(400, { detail: "Only .torrent files can be opened" });
      }
      const file = Bun.file(path);
      if (file.size > 8 * 1024 * 1024) {
        return problem(400, { detail: "The torrent file is too large" });
      }
      source = new Uint8Array(await file.arrayBuffer());
      sourcePath = path;
    } else {
      return problem(400, { detail: "Only magnet links and .torrent files can be opened" });
    }
    let parsed: Awaited<ReturnType<typeof parseTorrent>>;
    try {
      parsed = await parseTorrent(source);
    } catch {
      return problem(400, {
        detail: "Invalid magnet link or .torrent file (BitTorrent v1 required)",
      });
    }
    const waiting = [...this.staged.values()].find(
      (item) => item.opened.infoHash === parsed.infoHash
    );
    if (waiting) {
      return waiting.opened;
    }
    const state = engine.snapshot(null, false);
    const existing = state.torrents.find((torrent) => torrent.id === parsed.infoHash);
    const folder = sourcePath === null ? null : resolve(dirname(sourcePath));
    const opened: OpenedTorrent = {
      destinationId:
        state.destinations.find((destination) => destination.downloadPath === folder)?.id ?? null,
      existing: existing ? { destinationId: existing.destinationId } : null,
      fileCount: parsed.files?.length ?? null,
      id: crypto.randomUUID(),
      infoHash: parsed.infoHash,
      length: parsed.length ?? null,
      name: [parsed.name].flat()[0] || parsed.infoHash,
    };
    this.staged.set(opened.id, { opened, source, sourcePath });
    this.emit("change");
    return opened;
  }

  async accept(id: string, options: TorrentAddOptions, engine: EnginePort) {
    const staged = this.staged.get(id);
    if (!staged) {
      return problem(404, { detail: "This torrent is no longer waiting to be added" });
    }
    const result = await engine.add(staged.source, options);
    if (result instanceof ElysiaStatus) {
      return result;
    }
    this.staged.delete(id);
    this.emit("change");
    if (staged.sourcePath === null) {
      return result;
    }
    const destination = engine
      .snapshot(null, false)
      .destinations.find((item) => item.id === (options.destinationId ?? "default"));
    if (!(destination?.deleteTorrentFileAfterAdd ?? engine.settings.deleteTorrentFileAfterAdd)) {
      return result;
    }
    try {
      await unlink(staged.sourcePath);
    } catch {
      return problem(500, {
        detail: "Torrent added, but the original .torrent file could not be deleted",
      });
    }
    return result;
  }

  dismiss(id: string) {
    if (!this.staged.delete(id)) {
      return problem(404, { detail: "This torrent is no longer waiting to be added" });
    }
    this.emit("change");
    return { ok: true };
  }
}

/** A magnet link or .torrent file opened from the system, waiting for the user to add it. */
export interface OpenedTorrent {
  /** Thread whose folder contains the opened file, suggested as its destination. */
  destinationId: string | null;
  /** Set when the torrent is already in the library; it is shown instead of added again. */
  existing: { destinationId: string } | null;
  fileCount: number | null;
  id: string;
  infoHash: string;
  length: number | null;
  name: string;
}
