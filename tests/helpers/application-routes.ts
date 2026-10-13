import { apiPlugin } from "../../src/api";
import { sync } from "../../src/sync";
import { integrationPlugin } from "./plugin-integration-routes";

export const fixtureRoutes = apiPlugin.use(integrationPlugin);
export const fixtureSync = sync;
