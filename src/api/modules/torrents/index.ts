import { on } from "node:events";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, HTTPError, sse } from "elysia";
import { sync } from "../../../sync";
import type { TorrentDetail } from "../../../types";
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
  .get("/torrents/:id/files/:index/content", async ({ torrents, params }) => {
    const file = await torrents.file(params.id, Number(params.index));
    return new Response(Bun.file(file.path), {
      headers: {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      },
    });
  });
