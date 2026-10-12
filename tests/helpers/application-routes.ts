import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia } from "elysia";
import { apiPlugin } from "../../src/api";
import { sync } from "../../src/sync";
import { integrationPlugin } from "./plugin-integration-routes";

export const fixtureRoutes = new Elysia({ name: "tofu-test-server" })
  .use(desktopApp({ restrictWebToLoopback: true }))
  .use(apiPlugin)
  .use(integrationPlugin);
export const fixtureSync = sync;
