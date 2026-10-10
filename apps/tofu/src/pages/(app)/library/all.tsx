import { defineRoute } from "@teyik0/furin";
import { loadTorrentPage } from "../../../api/page-data";
import { App } from "../../../components/app";
import { route as app } from "../_route";

export const route = defineRoute()
  .config({ layout: app, mode: "ssr" })
  .loader(({ dashboard, request }) => loadTorrentPage(dashboard, request, null))
  .head(() => ({ meta: [{ title: "All torrents — Tofu" }] }))
  .page(App);
