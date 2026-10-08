import { defineRoute } from "@teyik0/furin";
import { App } from "../../../components/app";
import { loadTorrentPage } from "../../../server/page-data";
import { route as app } from "../_route";

export const route = defineRoute()
  .config({ layout: app, mode: "ssr" })
  .loader(({ dashboard, request }) => loadTorrentPage(dashboard, request, null))
  .head(() => ({ meta: [{ title: "All torrents — Tofu" }] }))
  .page(App);
