import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/plugins/sources")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "Torrent source plugins — Tofu" }] }))
  .page(() => null);
