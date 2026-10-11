import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";
import { interpretationSchema } from "./model";

export const jevPlugin = new Elysia({ name: "tofu-jev-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .post(
    "/automations/interpret",
    {
      body: interpretationSchema,
    },
    ({ application, body }) => application.automation.interpret(body.query, body.destinationId)
  );
