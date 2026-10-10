import "@teyik0/furin/server-only";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../sync";
import { anilist } from "./modules/anilist";
import { anilistOpening } from "./modules/anilist/opening";
import { automation } from "./modules/automation";
import { dashboard } from "./modules/dashboard";
import { desktop } from "./modules/desktop";
import { destinations } from "./modules/destinations";
import { discovery } from "./modules/discovery";
import { jev } from "./modules/jev";
import { plugins } from "./modules/plugins";
import { settings } from "./modules/settings";
import { torrents } from "./modules/torrents";
import { updates } from "./modules/updates";

export const apiPlugin = new Elysia({ name: "tofu-api", prefix: "/api" })
  .use(furinSync(sync))
  .error(({ error, set }) => {
    set.status =
      error instanceof Error && "status" in error && typeof error.status === "number"
        ? error.status
        : 500;
    return { error: error instanceof Error ? error.message : "Unexpected error" };
  })
  .get("/health", () => ({ ready: true }))
  .use(settings)
  .use(dashboard)
  .use(torrents)
  .use(destinations)
  .use(anilist)
  .use(anilistOpening)
  .use(automation)
  .use(discovery)
  .use(plugins)
  .use(jev)
  .use(desktop)
  .use(updates);

export type Api = typeof apiPlugin;
