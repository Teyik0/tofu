import { defineRoute } from "@teyik0/furin";
import { PluginsPage } from "../../components/plugins-page";
import { route as app } from "./_route";

export const route = defineRoute()
  .config({ layout: app, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Plugins — Tofu" }] }))
  .page(PluginsPage);
