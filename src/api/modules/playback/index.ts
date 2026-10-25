import "@teyik0/furin/server-only";
import { furinSync } from "@teyik0/furin/sync";
import { Context, Effect } from "effect";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { services } from "../../lib/services-runtime";
import { accessPlugin } from "../access/plugin";
import { mediaKeyParamsSchema, positionSchema } from "./model";
import { Playback } from "./service";

/** Playback progress belongs to the caller's profile: the owner's, or the paired device's. */
export const playbackPlugin = new Elysia({ name: "tofu-playback-api" })
  .decorate("playback", Context.get(services, Playback))
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ idempotent: false, personal: true })
  .get(
    "/playback/positions/:mediaKey",
    { params: mediaKeyParamsSchema },
    ({ caller, playback, params }) =>
      Effect.runPromise(
        playback.readPosition(
          caller.kind === "owner" ? "owner" : caller.device.profileId,
          params.mediaKey
        )
      )
  )
  .put(
    "/playback/positions/:mediaKey",
    { body: positionSchema, params: mediaKeyParamsSchema },
    ({ body, caller, playback, params }) =>
      Effect.runPromise(
        playback.recordPosition(
          caller.kind === "owner" ? "owner" : caller.device.profileId,
          params.mediaKey,
          body
        )
      )
  );
