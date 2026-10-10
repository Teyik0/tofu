import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";

export const healthPlugin = new Elysia({ name: "tofu-health-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .get("/health", { sync: false }, ({ application }) => ({ ready: Boolean(application) }));
