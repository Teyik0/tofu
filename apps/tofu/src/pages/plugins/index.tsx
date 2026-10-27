import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/plugins")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "Installed plugins — Tofu" }] }))
  .page(() => null);
