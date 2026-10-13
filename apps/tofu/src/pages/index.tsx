import { defineRoute } from "@teyik0/furin";
import { defer } from "@teyik0/furin/client";
import { App } from "../components/app";
import { api } from "../lib/client";
import { route as root } from "./root";

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .loader(async ({ dashboard }) => {
    const state = await dashboard;
    const initialTorrentId = state.torrents[0]?.id ?? null;
    const initialDetail = (async () => {
      if (!initialTorrentId) {
        return null;
      }
      const { data, error } = await api.torrents({ id: initialTorrentId }).get();
      if (error) {
        throw error;
      }
      return data;
    })();
    return defer({ initialDetail, initialTorrentId });
  })
  .head(() => ({ meta: [{ title: "All torrents — Tofu" }] }))
  .page(({ dashboard, initialDetail, initialTorrentId }) => (
    <App
      activeDestination={null}
      dashboard={dashboard}
      initialDetail={initialDetail}
      initialTorrentId={initialTorrentId}
    />
  ));
