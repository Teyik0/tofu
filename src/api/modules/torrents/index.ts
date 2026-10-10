import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { services } from "../../lib/services";
import {
  addPeerSchema,
  bulkActionSchema,
  createTorrentSchema,
  filePrioritySchema,
  removeTorrentSchema,
  trackersSchema,
  uploadTorrentSchema,
} from "./model";

export const torrents = new Elysia({ name: "tofu-torrent-api" })
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("/torrents/:id", { sync: { id: "tofu.torrent", scope: {} } }, ({ params }) =>
    services.engine.detail(params.id)
  )
  .post(
    "/torrents",
    {
      body: createTorrentSchema,
    },
    ({ body }) => services.engine.add(body.source, body)
  )
  .post(
    "/torrents/file",
    {
      body: uploadTorrentSchema,
    },
    async ({ body }) =>
      services.engine.add(new Uint8Array(await body.file.arrayBuffer()), {
        destinationId: body.destinationId,
        downloadPath: body.downloadPath,
        paused: body.paused === "true",
        trackers: body.trackers?.split("\n"),
      })
  )
  .post("/torrents/:id/pause", ({ params }) => services.engine.pause(params.id))
  .post("/torrents/:id/resume", ({ params }) => services.engine.resume(params.id))
  .post("/torrents/:id/announce", ({ params }) => services.engine.reannounce(params.id))
  .post("/torrents/:id/verify", ({ params }) => services.engine.verify(params.id))
  .put("/torrents/:id/trackers", { body: trackersSchema }, ({ params, body }) =>
    services.engine.replaceTrackers(params.id, body.urls)
  )
  .delete("/torrents/:id", { body: removeTorrentSchema }, ({ params, body }) =>
    services.engine.remove(params.id, body.deleteFiles)
  )
  .put(
    "/torrents/:id/files/:index",
    {
      body: filePrioritySchema,
    },
    ({ params, body }) => services.engine.priority(params.id, Number(params.index), body.priority)
  )
  .post("/torrents/:id/peers", { body: addPeerSchema }, ({ params, body }) =>
    services.engine.addPeer(params.id, body.peer)
  )
  .post(
    "/bulk",
    {
      body: bulkActionSchema,
    },
    async ({ body }) => {
      const ids =
        body.ids ?? services.engine.snapshot(null, false).torrents.map((torrent) => torrent.id);
      await Promise.all(
        ids.map((id) =>
          body.action === "pause" ? services.engine.pause(id) : services.engine.resume(id)
        )
      );
      return { ok: true };
    }
  )
  .get("/torrents/:id/files/:index/availability", async ({ params }) => {
    await services.engine.file(params.id, Number(params.index));
    return { ok: true };
  })
  .get("/torrents/:id/files/:index/content", async ({ params }) => {
    const file = await services.engine.file(params.id, Number(params.index));
    return new Response(Bun.file(file.path), {
      headers: {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      },
    });
  });
