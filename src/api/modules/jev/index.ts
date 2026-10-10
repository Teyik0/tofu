import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { services } from "../../lib/services";
import { interpretationSchema } from "./model";

export const jev = new Elysia({ name: "tofu-jev-api" })
  .use(furinSync(sync))
  .guard({ sync: false })
  .post(
    "/automations/interpret",
    {
      body: interpretationSchema,
    },
    ({ body }) => services.automation.interpret(body.query, body.destinationId)
  );
