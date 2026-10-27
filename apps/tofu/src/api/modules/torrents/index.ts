import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import type { Caller } from "../access/service";
import { hostDetail, libraryDetail } from "../dashboard/projection";
import { mediaReaders, streamTorrentFile } from "./media";
import {
  addPeerSchema,
  bulkActionSchema,
  createTorrentSchema,
  filePrioritySchema,
  locateTorrentSchema,
  removeTorrentSchema,
  trackersSchema,
  uploadTorrentSchema,
} from "./model";
import { torrentServicePlugin } from "./plugin";

function mediaKey(caller: Caller) {
  return caller.kind === "device" ? caller.device.id : "owner";
}

export const torrentPlugin = new Elysia({ name: "tofu-torrent-api" })
  .use(torrentServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ idempotent: false })
  .get(
    "/torrents/:id",
    {
      playback: true,
    },
    async ({ torrents, params }) => {
      const detail = await torrents.call("detail", [params.id]);
      if (detail instanceof ElysiaStatus) {
        return detail;
      }
      return libraryDetail(detail);
    }
  )
  .get("/torrents/:id/host", { administration: true }, async ({ torrents, params }) => {
    const detail = await torrents.call("detail", [params.id]);
    if (detail instanceof ElysiaStatus) {
      return detail;
    }
    return hostDetail(detail);
  })
  .post(
    "/torrents",
    { body: createTorrentSchema, management: true },
    ({ torrents, body, caller, request }) => {
      if (body.downloadPath !== undefined && caller.kind !== "owner") {
        return problem(403, { detail: "Choose one of the server's threads" });
      }
      const key = request.headers.get("idempotency-key");
      const operationKey = key
        ? new Bun.CryptoHasher("sha256").update(`${caller.principal}:add:${key}`).digest("hex")
        : undefined;
      return torrents.call("add", [body.source, { ...body, operationKey }]);
    }
  )
  .post(
    "/torrents/file",
    { body: uploadTorrentSchema, management: true },
    async ({ torrents, body, caller, request }) => {
      if (body.downloadPath !== undefined && caller.kind !== "owner") {
        return problem(403, { detail: "Choose one of the server's threads" });
      }
      return torrents.call("add", [
        new Uint8Array(await body.file.arrayBuffer()),
        {
          destinationId: body.destinationId,
          downloadPath: body.downloadPath,
          operationKey: request.headers.has("idempotency-key")
            ? new Bun.CryptoHasher("sha256")
                .update(`${caller.principal}:add:${request.headers.get("idempotency-key")}`)
                .digest("hex")
            : undefined,
          paused: body.paused === "true",
          trackers: body.trackers?.split("\n"),
        },
      ]);
    }
  )
  .post("/torrents/:id/pause", { management: true }, ({ torrents, params }) =>
    torrents.call("pause", [params.id])
  )
  .post("/torrents/:id/resume", { management: true }, ({ torrents, params }) =>
    torrents.call("resume", [params.id])
  )
  .post("/torrents/:id/announce", { management: true }, ({ torrents, params }) =>
    torrents.call("reannounce", [params.id])
  )
  .post("/torrents/:id/verify", { management: true }, ({ torrents, params }) =>
    torrents.call("verify", [params.id])
  )
  .post("/torrents/:id/repair", { management: true }, ({ torrents, params }) =>
    torrents.call("repair", [params.id])
  )
  .post(
    "/torrents/:id/locate",
    { body: locateTorrentSchema, owner: true },
    ({ torrents, params, body }) => torrents.call("locate", [params.id, body.downloadPath])
  )
  .put(
    "/torrents/:id/trackers",
    { administration: true, body: trackersSchema },
    ({ torrents, params, body }) => torrents.call("replaceTrackers", [params.id, body.urls])
  )
  .delete(
    "/torrents/:id",
    { body: removeTorrentSchema, management: true },
    ({ torrents, params, body, caller, request }) => {
      if (body.deleteFiles && !(caller.kind === "owner" || caller.device.canDeleteFiles)) {
        return problem(403, { detail: "Deleting downloaded files is not allowed for this device" });
      }
      return torrents.call("remove", [
        params.id,
        body.deleteFiles,
        request.headers.has("idempotency-key")
          ? new Bun.CryptoHasher("sha256")
              .update(`${caller.principal}:remove:${request.headers.get("idempotency-key")}`)
              .digest("hex")
          : undefined,
      ]);
    }
  )
  .put(
    "/torrents/:id/files/:index",
    { body: filePrioritySchema, management: true },
    ({ torrents, params, body }) =>
      torrents.call("priority", [params.id, Number(params.index), body.priority])
  )
  .post(
    "/torrents/:id/peers",
    { administration: true, body: addPeerSchema },
    ({ torrents, params, body }) => torrents.call("addPeer", [params.id, body.peer])
  )
  .post("/bulk", { body: bulkActionSchema, management: true }, async ({ torrents, body }) => {
    const ids = body.ids ?? torrents.snapshot(null, false).torrents.map((torrent) => torrent.id);
    const results = await Promise.all(
      ids.map((id) =>
        body.action === "pause" ? torrents.call("pause", [id]) : torrents.call("resume", [id])
      )
    );
    const failed = results.find((result) => result instanceof ElysiaStatus);
    if (failed) {
      return failed;
    }
    return { ok: true };
  })
  .get(
    "/torrents/:id/files/:index/availability",
    { personal: true },
    async ({ torrents, params }) => {
      const result = await torrents.call("file", [params.id, Number(params.index)]);
      if (result instanceof ElysiaStatus) {
        return result;
      }
      return { ok: true };
    }
  )
  // The player reads media through ranged requests; the trailing name gives VLC the extension.
  .head(
    "/torrents/:id/files/:index/stream/:name",
    { personal: true },
    async ({ torrents, params }) => {
      // The size comes from torrent metadata, so this answers before any piece arrives.
      const detail = await torrents.call("detail", [params.id]);
      if (detail instanceof ElysiaStatus) {
        return detail;
      }
      const file = detail.files[Number(params.index)];
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
    }
  )
  .get(
    "/torrents/:id/files/:index/stream/:name",
    { personal: true },
    ({ access, caller, torrents, params, request, set }) => {
      // Reserve before the first await so concurrent requests cannot exceed the budget.
      const reserved = mediaReaders.reserve(mediaKey(caller));
      if (!reserved) {
        set.headers["retry-after"] = "2";
        return problem(429, { detail: "Too many simultaneous media reads. Try again shortly" });
      }
      const reading = access.callerReader(caller, request);
      const release = () => {
        reading.release();
        reserved();
      };
      return streamTorrentFile({
        engine: torrents,
        headers: {},
        id: params.id,
        index: Number(params.index),
        range: request.headers.get("range"),
        release,
        set,
        signal: reading.signal,
      });
    }
  )
  .get(
    "/torrents/:id/files/:index/content",
    { personal: true },
    async ({ access, caller, torrents, params, request, set }) => {
      const reserved = mediaReaders.reserve(mediaKey(caller));
      if (!reserved) {
        set.headers["retry-after"] = "2";
        return problem(429, { detail: "Too many simultaneous media reads. Try again shortly" });
      }
      const reading = access.callerReader(caller, request);
      const release = () => {
        reading.release();
        reserved();
      };
      // Saving requires the complete file; the read itself is the same bounded stream as playback.
      const file = await torrents.call("file", [params.id, Number(params.index)]);
      if (file instanceof ElysiaStatus) {
        release();
        return file;
      }
      return streamTorrentFile({
        engine: torrents,
        headers: {
          "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        },
        id: params.id,
        index: Number(params.index),
        range: null,
        release,
        set,
        signal: reading.signal,
      });
    }
  );
