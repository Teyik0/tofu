import "@teyik0/furin/server-only";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../sync";
import { contextPlugin } from "./lib/context";
import { anilistPlugin } from "./modules/anilist";
import { anilistOpeningPlugin } from "./modules/anilist/opening";
import { automationPlugin } from "./modules/automation";
import { dashboardPlugin } from "./modules/dashboard";
import { desktopPlugin } from "./modules/desktop";
import { destinationsPlugin } from "./modules/destinations";
import { discoveryPlugin } from "./modules/discovery";
import { jevPlugin } from "./modules/jev";
import { pluginsPlugin } from "./modules/plugins";
import { settingsPlugin } from "./modules/settings";
import { torrentPlugin } from "./modules/torrents";
import { updatesPlugin } from "./modules/updates";

export const apiPlugin = new Elysia({ name: "tofu-api", prefix: "/api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .get("/health", () => ({ ready: true }))
  .use(settingsPlugin)
  .use(dashboardPlugin)
  .use(torrentPlugin)
  .use(destinationsPlugin)
  .use(anilistPlugin)
  .use(anilistOpeningPlugin)
  .use(automationPlugin)
  .use(discoveryPlugin)
  .use(pluginsPlugin)
  .use(jevPlugin)
  .use(desktopPlugin)
  .use(updatesPlugin);

export type Api = typeof apiPlugin;
