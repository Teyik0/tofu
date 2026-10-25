import { furinSync } from "@teyik0/furin/sync";
import { Effect } from "effect";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { automationPlugin } from "../automation";
import { interpretationSchema } from "./model";

export const jevManagementPlugin = new Elysia({ name: "tofu-jev-api" })
  .use(automationPlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ administration: true, idempotent: false })
  .post(
    "/automations/interpret",
    {
      body: interpretationSchema,
    },
    ({ automation, body }) =>
      Effect.runPromise(automation.interpret(body.query, body.destinationId))
  );
