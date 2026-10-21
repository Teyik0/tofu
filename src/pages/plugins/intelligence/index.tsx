import { defineRoute } from "@teyik0/furin";

export const route = defineRoute("/plugins/intelligence")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "Intelligence plugins — Tofu" }] }))
  .page(() => null);
