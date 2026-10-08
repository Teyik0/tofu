import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { App } from "../../../../components/app";
import { loadTorrentPage } from "../../../../server/page-data";
import { route as app } from "../../_route";

export const route = defineRoute()
  .config({ layout: app, mode: "ssr", params: t.Object({ id: t.String() }) })
  .loader(({ dashboard, request, params }) => loadTorrentPage(dashboard, request, params.id))
  .head(() => ({ meta: [{ title: "Your downloads — Tofu" }] }))
  .page(App);
