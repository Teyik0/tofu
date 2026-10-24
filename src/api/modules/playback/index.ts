import "@teyik0/furin/server-only";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { databasePlugin } from "../../lib/db";
import { accessPlugin } from "../access/plugin";
import { mediaKeyParamsSchema, positionSchema } from "./model";
import { readPosition, recordPosition } from "./service";

/** Playback progress belongs to the caller's profile: the owner's, or the paired device's. */
export const playbackPlugin = new Elysia({ name: "tofu-playback-api" })
  .use(databasePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ idempotent: false, personal: true })
  .get(
    "/playback/positions/:mediaKey",
    { params: mediaKeyParamsSchema },
    ({ caller, db, params }) =>
      readPosition(db, caller.kind === "owner" ? "owner" : caller.device.profileId, params.mediaKey)
  )
  .put(
    "/playback/positions/:mediaKey",
    { body: positionSchema, params: mediaKeyParamsSchema },
    ({ body, caller, db, params }) =>
      recordPosition(
        db,
        caller.kind === "owner" ? "owner" : caller.device.profileId,
        params.mediaKey,
        body
      )
  );
