import { defineRoute, notFound } from "@teyik0/furin";
import { t } from "elysia";
import { App } from "../components/app";
import { api } from "../lib/client";
import { selectedTorrentId } from "../lib/navigation";

export const route = defineRoute("/")
  .config({ mode: "ssr", query: t.Object({ torrent: t.Optional(t.String()) }) })
  .loader(async ({ dashboard, query }) => {
    const state = await dashboard;
    if (!state) {
      notFound({ message: "The library is not available on this page" });
    }
    const selectedId = selectedTorrentId(state.torrents, null, query.torrent);
    if (!selectedId) {
      return { detail: null };
    }
    const { data, error } = await api.torrents({ id: selectedId }).get();
    if (error) {
      if (error.status === 404) {
        return { detail: null };
      }
      throw error;
    }
    return { detail: data };
  })
  .head(() => ({ meta: [{ title: "All torrents — Tofu" }] }))
  .page(({ dashboard, detail, query }) =>
    dashboard ? (
      <App
        activeDestination={null}
        dashboard={dashboard}
        detail={detail}
        requested={query.torrent}
      />
    ) : null
  );
