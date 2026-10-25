import { Effect } from "effect";
import "@teyik0/furin/server-only";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, ElysiaStatus } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { anilistServicePlugin } from "../anilist/plugin";
import { torrentServicePlugin } from "../torrents/plugin";
import { findEpisodeSources } from "./availability";
import {
  availabilityBatchSchema,
  linkedAvailabilitySchema,
  linkedPlaybackRevokeSchema,
  linkedPlaySchema,
  linkServerSchema,
} from "./model";
import { linkedLibrariesServicePlugin } from "./plugin";

/** This server answering linked servers: which of its files match their episodes. */
export const libraryAvailabilityPlugin = new Elysia({ name: "tofu-library-availability" })
  .use(torrentServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .post(
    "/library/availability",
    { body: availabilityBatchSchema, idempotent: false, personal: true },
    async ({ body, torrents }) => {
      const results = await findEpisodeSources(torrents, body.queries);
      if (results instanceof ElysiaStatus) {
        return results;
      }
      return { results };
    }
  );

/** This server using other servers as playback sources for its own AniList. */
export const linkedLibrariesPlugin = new Elysia({ name: "tofu-linked-libraries" })
  .use(anilistServicePlugin)
  .use(linkedLibrariesServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ administration: true, idempotent: false })
  .get("/linked-libraries", ({ linkedLibraries }) => linkedLibraries.list())
  .post("/linked-libraries", { body: linkServerSchema }, ({ body, linkedLibraries }) =>
    Effect.runPromise(linkedLibraries.link(body))
  )
  .delete("/linked-libraries/:id", ({ linkedLibraries, params }) =>
    Effect.runPromise(linkedLibraries.unlink(params.id))
  )
  .post(
    "/linked-libraries/availability",
    { body: linkedAvailabilitySchema },
    ({ anilist, body, linkedLibraries }) => {
      const { mediaId, ...query } = body;
      return mediaId === undefined
        ? Effect.runPromise(linkedLibraries.availability(query))
        : Effect.runPromise(
            linkedLibraries.availabilityForAnime(query, mediaId, anilist.snapshot().entries)
          );
    }
  )
  .post(
    "/linked-libraries/:id/revoke-playback",
    { body: linkedPlaybackRevokeSchema },
    ({ body, linkedLibraries, params }) =>
      Effect.runPromise(linkedLibraries.revokePlayback(params.id, body.playbackId))
  )
  .post(
    "/linked-libraries/:id/play",
    { body: linkedPlaySchema },
    ({ body, linkedLibraries, params }) =>
      Effect.runPromise(linkedLibraries.play(params.id, body.torrentId, body.fileIndex))
  );
