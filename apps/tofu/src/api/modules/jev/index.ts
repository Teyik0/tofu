import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { automationPlugin } from "../automation/index";
import { interpretationSchema } from "./model";

export const jevManagementPlugin = new Elysia({ name: "tofu-jev-api" })
  .use(automationPlugin)
  .use(furinSync(sync))
  .guard({ sync: false })
  .post(
    "/automations/interpret",
    {
      body: interpretationSchema,
    },
    ({ automation, body }) => automation.interpret(body.query, body.destinationId)
  );
