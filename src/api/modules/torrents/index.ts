import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";
import {
  addPeerSchema,
  bulkActionSchema,
  createTorrentSchema,
  filePrioritySchema,
  removeTorrentSchema,
  trackersSchema,
  uploadTorrentSchema,
} from "./model";

export const torrentPlugin = new Elysia({ name: "tofu-torrent-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("/torrents/:id", { sync: { id: "tofu.torrent", scope: {} } }, ({ application, params }) =>
    application.engine.detail(params.id)
  )
  .post(
    "/torrents",
    {
      body: createTorrentSchema,
    },
    ({ application, body }) => application.engine.add(body.source, body)
  )
  .post(
    "/torrents/file",
    {
      body: uploadTorrentSchema,
    },
    async ({ application, body }) =>
      application.engine.add(new Uint8Array(await body.file.arrayBuffer()), {
        destinationId: body.destinationId,
        downloadPath: body.downloadPath,
        paused: body.paused === "true",
        trackers: body.trackers?.split("\n"),
      })
  )
  .post("/torrents/:id/pause", ({ application, params }) => application.engine.pause(params.id))
  .post("/torrents/:id/resume", ({ application, params }) => application.engine.resume(params.id))
  .post("/torrents/:id/announce", ({ application, params }) =>
    application.engine.reannounce(params.id)
  )
  .post("/torrents/:id/verify", ({ application, params }) => application.engine.verify(params.id))
  .put("/torrents/:id/trackers", { body: trackersSchema }, ({ application, params, body }) =>
    application.engine.replaceTrackers(params.id, body.urls)
  )
  .delete("/torrents/:id", { body: removeTorrentSchema }, ({ application, params, body }) =>
    application.engine.remove(params.id, body.deleteFiles)
  )
  .put(
    "/torrents/:id/files/:index",
    {
      body: filePrioritySchema,
    },
    ({ application, params, body }) =>
      application.engine.priority(params.id, Number(params.index), body.priority)
  )
  .post("/torrents/:id/peers", { body: addPeerSchema }, ({ application, params, body }) =>
    application.engine.addPeer(params.id, body.peer)
  )
  .post(
    "/bulk",
    {
      body: bulkActionSchema,
    },
    async ({ application, body }) => {
      const ids =
        body.ids ?? application.engine.snapshot(null, false).torrents.map((torrent) => torrent.id);
      await Promise.all(
        ids.map((id) =>
          body.action === "pause" ? application.engine.pause(id) : application.engine.resume(id)
        )
      );
      return { ok: true };
    }
  )
  .get("/torrents/:id/files/:index/availability", async ({ application, params }) => {
    await application.engine.file(params.id, Number(params.index));
    return { ok: true };
  })
  .get("/torrents/:id/files/:index/content", async ({ application, params }) => {
    const file = await application.engine.file(params.id, Number(params.index));
    return new Response(Bun.file(file.path), {
      headers: {
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      },
    });
  });
