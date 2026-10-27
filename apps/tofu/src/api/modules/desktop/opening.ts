import { EventEmitter } from "node:events";
import { unlink } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Context, Effect, Layer, Result } from "effect";
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
const make = Effect.gen(function* () {
  const events = yield* Effect.acquireRelease(
    Effect.sync(() => new EventEmitter<{ change: [] }>()),
    (emitter) =>
      Effect.sync(() => {
        emitter.removeAllListeners();
      })
  );

  const serviceStaged = new Map<string, StagedTorrent>();
  function serviceList() {
    return [...serviceStaged.values()].map((item) => item.opened);
  }
  const serviceStage = Effect.fn("Openings.stage")(function* (input: string, engine: EnginePort) {
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
      source = new Uint8Array(yield* Effect.promise(() => file.arrayBuffer()));
      sourcePath = path;
    } else {
      return problem(400, { detail: "Only magnet links and .torrent files can be opened" });
    }
    const parsedResult = yield* Effect.result(Effect.tryPromise(() => parseTorrent(source)));
    if (Result.isFailure(parsedResult)) {
      return problem(400, {
        detail: "Invalid magnet link or .torrent file (BitTorrent v1 required)",
      });
    }
    const parsed = parsedResult.success;
    const waiting = [...serviceStaged.values()].find(
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
    serviceStaged.set(opened.id, { opened, source, sourcePath });
    events.emit("change");
    return opened;
  });
  const serviceAccept = Effect.fn("Openings.accept")(function* (
    id: string,
    options: TorrentAddOptions,
    engine: EnginePort
  ) {
    const staged = serviceStaged.get(id);
    if (!staged) {
      return problem(404, { detail: "This torrent is no longer waiting to be added" });
    }
    const result = yield* Effect.promise(() => engine.call("add", [staged.source, options]));
    if (result instanceof ElysiaStatus) {
      return result;
    }
    serviceStaged.delete(id);
    events.emit("change");
    const { sourcePath } = staged;
    if (sourcePath === null) {
      return result;
    }
    const destination = engine
      .snapshot(null, false)
      .destinations.find((item) => item.id === (options.destinationId ?? "default"));
    if (!(destination?.deleteTorrentFileAfterAdd ?? engine.settings().deleteTorrentFileAfterAdd)) {
      return result;
    }
    const removed = yield* Effect.result(Effect.tryPromise(() => unlink(sourcePath)));
    if (Result.isFailure(removed)) {
      return problem(500, {
        detail: "Torrent added, but the original .torrent file could not be deleted",
      });
    }
    return result;
  });
  function serviceDismiss(id: string) {
    if (!serviceStaged.delete(id)) {
      return problem(404, { detail: "This torrent is no longer waiting to be added" });
    }
    events.emit("change");
    return { ok: true };
  }
  events.setMaxListeners(0);

  return {
    accept: serviceAccept,
    dismiss: serviceDismiss,
    events,
    list: serviceList,
    stage: serviceStage,
  };
});

export type TorrentOpenings = Openings["Service"];
export class Openings extends Context.Service<
  Openings,
  {
    readonly list: () => OpenedTorrent[];
    readonly stage: (
      input: string,
      engine: EnginePort
    ) => Effect.Effect<
      | OpenedTorrent
      | ReturnType<typeof problem<400, { readonly detail: "Only .torrent files can be opened" }>>
      | ReturnType<typeof problem<400, { readonly detail: "The torrent file is too large" }>>
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Only magnet links and .torrent files can be opened" }
          >
        >
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Invalid magnet link or .torrent file (BitTorrent v1 required)" }
          >
        >
    >;
    readonly accept: (
      id: string,
      options: TorrentAddOptions,
      engine: EnginePort
    ) => Effect.Effect<
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: `The torrent file is inaccessible (HTTP ${number})` }
          >
        >
      | ReturnType<typeof problem<400, { readonly detail: "The torrent file is too large" }>>
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Invalid magnet link or .torrent file (BitTorrent v1 required)" }
          >
        >
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "Trackers must use valid HTTP, HTTPS, UDP, or WebSocket URLs" }
          >
        >
      | ReturnType<typeof problem<404, { readonly detail: "Tab not found" }>>
      | ReturnType<
          typeof problem<400, { readonly detail: "The download folder must be an absolute path" }>
        >
      | ReturnType<typeof problem<409, { readonly detail: string }>>
      | ReturnType<
          typeof problem<
            400,
            { readonly detail: "The torrent contains an unsafe or inaccessible file path" }
          >
        >
      | ReturnType<
          typeof problem<400, { readonly detail: "File path outside the download folder" }>
        >
      | { id: string }
      | ReturnType<typeof problem<503, { readonly detail: "The worker is unavailable" }>>
      | ReturnType<typeof problem<503, { detail: string }>>
      | ReturnType<
          typeof problem<404, { readonly detail: "This torrent is no longer waiting to be added" }>
        >
      | ReturnType<
          typeof problem<
            500,
            {
              readonly detail: "Torrent added, but the original .torrent file could not be deleted";
            }
          >
        >
    >;
    readonly dismiss: (
      id: string
    ) =>
      | ReturnType<
          typeof problem<404, { readonly detail: "This torrent is no longer waiting to be added" }>
        >
      | { ok: boolean };
    readonly events: EventEmitter<{ change: [] }>;
  }
>()("tofu/desktop-openings") {}
export const openingsLayer = Layer.effect(Openings, make);

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
