import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { App } from "../../../components/app";
import { loadTorrentPage } from "../../../server/page-data";
import { route as library } from "../_route";

export const route = defineRoute()
  .config({ layout: library, mode: "ssr", params: t.Object({ id: t.String() }) })
  .loader(({ dashboard, request, params }) =>
    loadTorrentPage(dashboard, new URL(request.url).origin, params.id)
  )
  .head(() => ({ meta: [{ title: "Vos téléchargements — Tofu" }] }))
  .page(({ initialDetail, initialTorrentId }) => (
    <App initialDetail={initialDetail} initialTorrentId={initialTorrentId} />
  ));
