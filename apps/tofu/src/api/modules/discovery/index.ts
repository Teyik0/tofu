import { furinSync } from "@teyik0/furin/sync";
import { Effect } from "effect";
import { Elysia } from "elysia";
import {
  addReleaseSchema,
  discoverySchema,
} from "../../../../../../package/plugins/src/discovery-model";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { discoveryServicePlugin } from "./plugin";

export const discoveryPlugin = new Elysia({ name: "tofu-discovery-api" })
  .use(discoveryServicePlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ idempotent: false, management: true })
  .post(
    "/discover",
    {
      body: discoverySchema,
    },
    ({ discovery, body }) => Effect.runPromise(discovery.discover(body.query, body.sources))
  )
  .post(
    "/discover/add",
    {
      body: addReleaseSchema,
    },
    ({ discovery, body }) =>
      Effect.runPromise(
        discovery.addRelease(body.sourceId, body.id, body.destinationId, body.paused)
      )
  );
