import { defineRoute } from "@teyik0/furin";
import { SettingsPage } from "../../components/settings-page";
import { route as app } from "./_route";

export const route = defineRoute()
  .config({ layout: app, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Settings — Tofu" }] }))
  .page(SettingsPage);
