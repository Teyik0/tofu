import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { addReleaseSchema, discoverySchema } from "./model";
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
    ({ discovery, body }) => discovery.discover(body.query, body.sources)
  )
  .post(
    "/discover/add",
    {
      body: addReleaseSchema,
    },
    ({ discovery, body }) =>
      discovery.addRelease(body.sourceId, body.id, body.destinationId, body.paused)
  );
