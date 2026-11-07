import { Effect } from "effect";
import { Elysia, problem } from "elysia";
import { accessPlugin } from "../access/plugin";
import {
  transmissionActionSchema,
  transmissionAddSchema,
  transmissionFilesSchema,
  transmissionLimitsSchema,
  transmissionRemoveSchema,
  transmissionServerSchema,
} from "./model";
import { transmissionServicePlugin } from "./plugin";

const DECIMAL_ID = /^\d+$/;

function torrentId(value: string) {
  if (!DECIMAL_ID.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/**
 * Transmission RPC control. Server configuration needs administration; reading and controlling
 * torrents needs management. Nothing here touches the local WebTorrent engine.
 */
export const transmissionPlugin = new Elysia({ name: "tofu-transmission-api" })
  .use(transmissionServicePlugin)
  .use(accessPlugin)
  .get("/transmission/servers", { management: true }, ({ transmission }) =>
    Effect.runPromise(transmission.servers())
  )
  .post(
    "/transmission/servers",
    { administration: true, body: transmissionServerSchema },
    ({ transmission, body }) => Effect.runPromise(transmission.saveServer(null, body))
  )
  .put(
    "/transmission/servers/:id",
    { administration: true, body: transmissionServerSchema },
    ({ transmission, params, body }) => Effect.runPromise(transmission.saveServer(params.id, body))
  )
  .delete("/transmission/servers/:id", { administration: true }, ({ transmission, params }) =>
    Effect.runPromise(transmission.removeServer(params.id))
  )
  .get("/transmission/servers/:id/state", { management: true }, ({ transmission, params }) =>
    Effect.runPromise(transmission.state(params.id))
  )
  .get(
    "/transmission/servers/:id/torrents/:torrentId",
    { management: true },
    ({ transmission, params }) => {
      const id = torrentId(params.torrentId);
      if (id === null) {
        return problem(400, { detail: "Invalid Transmission torrent id" });
      }
      return Effect.runPromise(transmission.detail(params.id, id));
    }
  )
  .post(
    "/transmission/servers/:id/action",
    { body: transmissionActionSchema, management: true },
    ({ transmission, params, body }) => Effect.runPromise(transmission.control(params.id, body))
  )
  .post(
    "/transmission/servers/:id/torrents",
    { body: transmissionAddSchema, management: true },
    ({ transmission, params, body }) => Effect.runPromise(transmission.add(params.id, body))
  )
  .delete(
    "/transmission/servers/:id/torrents",
    { body: transmissionRemoveSchema, management: true },
    ({ transmission, params, body }) => Effect.runPromise(transmission.remove(params.id, body))
  )
  .put(
    "/transmission/servers/:id/limits",
    { body: transmissionLimitsSchema, management: true },
    ({ transmission, params, body }) => Effect.runPromise(transmission.setLimits(params.id, body))
  )
  .put(
    "/transmission/servers/:id/torrents/:torrentId/files",
    { body: transmissionFilesSchema, management: true },
    ({ transmission, params, body }) => {
      const id = torrentId(params.torrentId);
      if (id === null) {
        return problem(400, { detail: "Invalid Transmission torrent id" });
      }
      return Effect.runPromise(transmission.setFiles(params.id, id, body));
    }
  );
