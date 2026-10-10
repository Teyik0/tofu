import { defineRoute } from "@teyik0/furin";
import { route as plugins } from "./_route";

export const route = defineRoute()
  .config({ layout: plugins, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Integration plugins — Tofu" }] }))
  .page(() => null);
