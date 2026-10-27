import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/plugins/integrations")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "Integration plugins — Tofu" }] }))
  .page(() => null);
