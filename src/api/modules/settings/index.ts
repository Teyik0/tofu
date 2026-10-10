import { furinSync } from "@teyik0/furin/sync";
import { Elysia, t } from "elysia";
import { sync } from "../../../sync";
import { services } from "../../lib/services";
import { settingsSchema } from "./model";

export const settings = new Elysia({ name: "tofu-settings-api" })
  .use(furinSync(sync))
  .guard({ sync: false })
  .get("/settings", () => services.engine.settings)
  .put(
    "/settings",
    {
      body: settingsSchema,
    },
    ({ body }) => services.engine.updateSettings(body)
  )
  .patch("/settings", { body: t.Partial(settingsSchema) }, ({ body }) =>
    services.engine.updateSettings(body)
  );
