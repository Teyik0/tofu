import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { services } from "../../lib/services";
import { addReleaseSchema, discoverySchema } from "./model";

export const discovery = new Elysia({ name: "tofu-discovery-api" })
  .use(furinSync(sync))
  .guard({ sync: false })
  .post(
    "/discover",
    {
      body: discoverySchema,
    },
    ({ body }) => services.automation.discover(body.query, body.sources)
  )
  .post(
    "/discover/add",
    {
      body: addReleaseSchema,
    },
    ({ body }) =>
      services.automation.addRelease(body.sourceId, body.id, body.destinationId, body.paused)
  );
