import { on } from "node:events";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, HTTPError, problem, sse } from "elysia";
import { sync } from "../../../sync";
import type { TorrentDetail } from "../../../types";
import { recordLog } from "../../lib/diagnostics";
import {
  addPeerSchema,
  bulkActionSchema,
  createTorrentSchema,
  filePrioritySchema,
  liveQuerySchema,
  locateTorrentSchema,
  removeTorrentSchema,
  trackersSchema,
  uploadTorrentSchema,
} from "./model";
import { torrentServicePlugin } from "./plugin";

const byteRange = /^bytes=(\d*)-(\d*)$/;

export const torrentPlugin = new Elysia({ name: "tofu-torrent-api" })
  .use(torrentServicePlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get(
    "/torrents/:id",
    { sync: { id: "tofu.torrent", scope: ({ params }) => ({ id: params.id }) } },
    ({ torrents, params }) => torrents.detail(params.id)
  )
  .get("/live", { query: liveQuerySchema }, async function* ({ torrents, request, query }) {
    // Register before observing so no change between the first snapshot and the loop is lost.
    const changes = on(torrents, "change", { signal: request.signal });
    try {
      await torrents.setObserved(true);
      // The first snapshot is fresh; each change then publishes the engine's latest snapshot.
      for (
        let state = await torrents.refreshSnapshot(0);
        ;
        state = torrents.snapshot(null, false)
      ) {
        let detail: TorrentDetail | null = null;
        if (query.selected && state.torrents.some((torrent) => torrent.id === query.selected)) {
          try {
            // biome-ignore lint/performance/noAwaitInLoops: Each snapshot carries the detail read after it.
            detail = await torrents.detail(query.selected);
          } catch (error) {
            // The torrent can be removed between the snapshot and this read.
            if (!(error instanceof HTTPError && error.status === 404)) {
              throw error;
            }
          }
        }
        yield sse({ data: { ...state, detail }, event: "snapshot" });
        const { done } = await changes.next();
        if (done) {
          return;
        }
      }
    } catch (error) {
      // A disconnected browser aborts the pending change iterator.
      if (!request.signal.aborted) {
        throw error;
      }
    } finally {
      // The change iterator is read manually, so it must be closed explicitly.
      await changes.return?.();
      if (torrents.listenerCount("change") === 0) {
        await torrents.setObserved(false);
      }
    }
  })
  .post(
    "/torrents",
    {
      body: createTorrentSchema,
    },
    ({ torrents, body }) => torrents.add(body.source, body)
  )
  .post(
    "/torrents/file",
    {
      body: uploadTorrentSchema,
    },
    async ({ torrents, body }) =>
      torrents.add(new Uint8Array(await body.file.arrayBuffer()), {
        destinationId: body.destinationId,
        downloadPath: body.downloadPath,
        paused: body.paused === "true",
        trackers: body.trackers?.split("\n"),
      })
  )
  .post("/torrents/:id/pause", ({ torrents, params }) => torrents.pause(params.id))
  .post("/torrents/:id/resume", ({ torrents, params }) => torrents.resume(params.id))
  .post("/torrents/:id/announce", ({ torrents, params }) => torrents.reannounce(params.id))
  .post("/torrents/:id/verify", ({ torrents, params }) => torrents.verify(params.id))
  .post("/torrents/:id/repair", ({ torrents, params }) => torrents.repair(params.id))
  .post("/torrents/:id/locate", { body: locateTorrentSchema }, ({ torrents, params, body }) =>
    torrents.locate(params.id, body.downloadPath)
  )
  .put("/torrents/:id/trackers", { body: trackersSchema }, ({ torrents, params, body }) =>
    torrents.replaceTrackers(params.id, body.urls)
  )
  .delete("/torrents/:id", { body: removeTorrentSchema }, ({ torrents, params, body }) =>
    torrents.remove(params.id, body.deleteFiles)
  )
  .put(
    "/torrents/:id/files/:index",
    {
      body: filePrioritySchema,
    },
    ({ torrents, params, body }) =>
      torrents.priority(params.id, Number(params.index), body.priority)
  )
  .post("/torrents/:id/peers", { body: addPeerSchema }, ({ torrents, params, body }) =>
    torrents.addPeer(params.id, body.peer)
  )
  .post(
    "/bulk",
    {
      body: bulkActionSchema,
    },
    async ({ torrents, body }) => {
      const ids = body.ids ?? torrents.snapshot(null, false).torrents.map((torrent) => torrent.id);
      await Promise.all(
        ids.map((id) => (body.action === "pause" ? torrents.pause(id) : torrents.resume(id)))
      );
      return { ok: true };
    }
  )
  .get("/torrents/:id/files/:index/availability", async ({ torrents, params }) => {
    await torrents.file(params.id, Number(params.index));
    return { ok: true };
  })
  // The player reads media through ranged requests; the trailing name gives VLC the extension.
  .head("/torrents/:id/files/:index/stream/:name", async ({ torrents, params }) => {
    // The size comes from torrent metadata, so this answers before any piece arrives.
    const file = (await torrents.detail(params.id)).files[Number(params.index)];
    if (!file) {
      return problem(404, { detail: "File not found" });
    }
    return new Response(null, {
      headers: {
        "accept-ranges": "bytes",
        "content-length": String(file.length),
        "content-type": Bun.file(file.name).type,
      },
    });
  })
  .get("/torrents/:id/files/:index/stream/:name", async ({ torrents, params, request, set }) => {
    const index = Number(params.index);
    const file = (await torrents.detail(params.id)).files[index];
    if (!file) {
      return problem(404, { detail: "File not found" });
    }
    const size = file.length;
    const complete = file.progress === 1;
    const headers = { "accept-ranges": "bytes", "content-type": Bun.file(file.name).type };
    const range = request.headers.get("range");
    if (!range && complete) {
      const content = Bun.file((await torrents.file(params.id, index)).path);
      return new Response(content, { headers: { ...headers, "content-length": String(size) } });
    }
    const [, first = "", last = ""] = byteRange.exec(range ?? "bytes=0-") ?? [];
    // A suffix range ("bytes=-500") requests the last bytes of the file.
    const start = first === "" ? Math.max(size - Number(last), 0) : Number(first);
    const requestedEnd = first === "" || last === "" ? size - 1 : Math.min(Number(last), size - 1);
    if (
      !((first || last) && Number.isSafeInteger(start) && Number.isSafeInteger(requestedEnd)) ||
      start > requestedEnd ||
      start >= size
    ) {
      set.headers["content-range"] = `bytes */${size}`;
      return problem(416, { detail: "The requested range is outside the file" });
    }
    // Bound every range, including completed files, so materializing it cannot load a whole movie.
    const end = Math.min(requestedEnd, start + 4 * 1024 * 1024 - 1);
    let path: string;
    if (complete) {
      ({ path } = await torrents.file(params.id, index));
    } else {
      const key = crypto.randomUUID();
      // Send the wait first so cancellation cannot overtake its registration in the worker.
      const waiting = torrents.waitForRange(key, params.id, index, start, end);
      const cancel = async () => {
        try {
          await torrents.cancelRange(key);
        } catch (error) {
          recordLog({ component: "torrent-stream", error, level: "error", operation: "cancel" });
        }
      };
      request.signal.addEventListener("abort", cancel, { once: true });
      if (request.signal.aborted) {
        void cancel();
      }
      try {
        ({ path } = await waiting);
      } finally {
        request.signal.removeEventListener("abort", cancel);
      }
    }
    // The desktop runtime's Bun version loses file slice bounds when middleware reads
    // Response.body. Materialize only the bounded range before it reaches middleware.
    return new Response(
      await Bun.file(path)
        .slice(start, end + 1)
        .arrayBuffer(),
      {
        headers: {
          ...headers,
          "content-length": String(end - start + 1),
          "content-range": `bytes ${start}-${end}/${size}`,
        },
        status: 206,
      }
    );
  })
  .get("/torrents/:id/files/:index/content", async ({ torrents, params }) => {
    const file = await torrents.file(params.id, Number(params.index));
    return new Response(Bun.file(file.path), {
      headers: {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      },
    });
  });
