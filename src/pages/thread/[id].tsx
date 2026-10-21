import { defineRoute, notFound } from "@teyik0/furin";
import { t } from "elysia";
import { App } from "../../components/app";
import { api } from "../../lib/client";
import { selectedTorrentId } from "../../lib/navigation";

export const route = defineRoute("/thread/[id]")
  .config({
    mode: "ssr",
    params: t.Object({ id: t.String() }),
    query: t.Object({ torrent: t.Optional(t.String()) }),
  })
  .loader(async ({ dashboard, params, query }) => {
    const state = await dashboard;
    if (!state.destinations.some((destination) => destination.id === params.id)) {
      notFound({ message: "This tab does not exist" });
    }
    const selectedId = selectedTorrentId(state.torrents, params.id, query.torrent);
    if (!selectedId) {
      return { detail: null };
    }
    const { data, error } = await api.torrents({ id: selectedId }).get();
    if (error) {
      // The torrent can be removed after the dashboard snapshot; the live stream catches up.
      if (error.status === 404) {
        return { detail: null };
      }
      throw error;
    }
    return { detail: data };
  })
  .head(() => ({ meta: [{ title: "Your downloads — Tofu" }] }))
  .page(({ dashboard, params, detail, query }) => (
    <App
      activeDestination={params.id}
      dashboard={dashboard}
      detail={detail}
      requested={query.torrent}
    />
  ));
