import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";
import { addReleaseSchema, discoverySchema } from "./model";

export const discoveryPlugin = new Elysia({ name: "tofu-discovery-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .post(
    "/discover",
    {
      body: discoverySchema,
    },
    ({ application, body }) => application.automation.discover(body.query, body.sources)
  )
  .post(
    "/discover/add",
    {
      body: addReleaseSchema,
    },
    ({ application, body }) =>
      application.automation.addRelease(body.sourceId, body.id, body.destinationId, body.paused)
  );
