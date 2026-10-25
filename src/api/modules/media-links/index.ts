import { Effect } from "effect";
import "@teyik0/furin/server-only";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { mediaReaders, streamTorrentFile } from "../torrents/media";
import { torrentServicePlugin } from "../torrents/plugin";
import { mediaLinkRevokeSchema, mediaLinkSchema } from "./model";
import { mediaLinksServicePlugin } from "./plugin";

/** Lets an isolated player on another origin read the file without credentials. */
const crossOrigin = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers": "accept-ranges, content-length, content-range",
  "cross-origin-resource-policy": "cross-origin",
  "referrer-policy": "no-referrer",
};

export const mediaLinksApiPlugin = new Elysia({ name: "tofu-media-links-api" })
  .use(torrentServicePlugin)
  .use(mediaLinksServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ idempotent: false })
  .post(
    "/media-links",
    {
      body: mediaLinkSchema,
      personal: true,
    },
    async ({ body, caller, mediaLinks, torrents }) => {
      const link = await Effect.runPromise(
        mediaLinks.issueForFile(torrents, {
          deviceId: caller.kind === "device" ? caller.device.id : null,
          fileIndex: body.fileIndex,
          torrentId: body.torrentId,
        })
      );
      if (link instanceof ElysiaStatus) {
        return link;
      }
      return {
        expiresAt: link.expiresAt,
        file: link.file,
        id: link.id,
        url: `${caller.origin}${link.path}`,
      };
    }
  )
  // Linked servers may call exact paths only, so they revoke through this static route.
  .post(
    "/media-links/revoke",
    { body: mediaLinkRevokeSchema, personal: true },
    ({ body, caller, mediaLinks }) =>
      mediaLinks.revoke(caller.kind === "device" ? caller.device.id : null, body.id)
  )
  .delete("/media-links/:id", { personal: true }, ({ caller, mediaLinks, params }) =>
    mediaLinks.revoke(caller.kind === "device" ? caller.device.id : null, params.id)
  );

/** Public capability URLs: the path token is the only credential. */
export const mediaLinksPlugin = new Elysia({ name: "tofu-media-links" })
  .use(torrentServicePlugin)
  .use(mediaLinksServicePlugin)
  .use(accessPlugin)
  .options(
    "/media/x/:token/:name",
    { public: true },
    () =>
      new Response(null, {
        headers: {
          ...crossOrigin,
          "access-control-allow-headers": "range",
          "access-control-allow-methods": "GET, HEAD",
          "access-control-max-age": "600",
        },
        status: 204,
      })
  )
  .head("/media/x/:token/:name", { public: true }, async ({ mediaLinks, params, torrents }) => {
    const file = await Effect.runPromise(mediaLinks.describe(torrents, params.token));
    if (file instanceof ElysiaStatus) {
      return file;
    }
    return new Response(null, {
      headers: {
        ...crossOrigin,
        "accept-ranges": "bytes",
        "content-length": String(file.length),
        "content-type": Bun.file(file.name).type,
      },
    });
  })
  .get(
    "/media/x/:token/:name",
    { public: true },
    ({ access, mediaLinks, params, request, set, torrents }) => {
      const link = mediaLinks.resolve(params.token);
      if (!link) {
        return problem(404, { detail: "This playback link expired or was revoked" });
      }
      const release = mediaReaders.reserve(link.deviceId ?? `link:${link.id}`);
      if (!release) {
        set.headers["retry-after"] = "2";
        return problem(429, { detail: "Too many simultaneous media reads. Try again shortly" });
      }
      // Revoking the issuing device ends reads through its links too.
      const reading = mediaLinks.read(link.id, link.expiresAt);
      const signal = AbortSignal.any([
        request.signal,
        reading.signal,
        access.deviceSignal(link.deviceId ?? "owner-media-links"),
      ]);
      Object.assign(set.headers, crossOrigin);
      return streamTorrentFile({
        engine: torrents,
        headers: crossOrigin,
        id: link.torrentId,
        index: link.fileIndex,
        range: request.headers.get("range"),
        release: () => {
          reading.release();
          release();
        },
        set,
        signal,
      });
    }
  );
