import { defineRoute } from "@teyik0/furin";
import { App } from "../../components/app";
import { loadTorrentPage } from "../../server/page-data";
import { route as library } from "./_route";

export const route = defineRoute()
  .config({ layout: library, mode: "ssr" })
  .loader(({ dashboard, request }) =>
    loadTorrentPage(dashboard, new URL(request.url).origin, "default")
  )
  .head(() => ({ meta: [{ title: "Tofu — Vos téléchargements, simplement." }] }))
  .page(({ initialDetail, initialTorrentId }) => (
    <App initialDetail={initialDetail} initialTorrentId={initialTorrentId} />
  ));
