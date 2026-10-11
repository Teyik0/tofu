import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";
import { discoverySchema } from "./model";

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
  );
