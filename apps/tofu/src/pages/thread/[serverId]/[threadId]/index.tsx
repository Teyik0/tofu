import { defineRoute, notFound } from "@teyik0/furin";
import { t } from "elysia";
import { App } from "../../../../components/app";
import { api } from "../../../../lib/client";
import { selectedTorrentId } from "../../../../lib/navigation";
import { RemoteThread } from "./_remote-thread";

export const route = defineRoute("/thread/[serverId]/[threadId]")
  .config({
    mode: "ssr",
    params: t.Object({
      serverId: t.String({ format: "uuid" }),
      threadId: t.String(),
    }),
    query: t.Object({ torrent: t.Optional(t.String()) }),
  })
  .loader(async ({ dashboard, params, query }) => {
    const state = await dashboard;
    if (!state) {
      notFound({ message: "The library is not available on this page" });
    }
    if (params.serverId !== state.server.id) {
      return { detail: null };
    }
    if (!state.destinations.some((destination) => destination.id === params.threadId)) {
      notFound({ message: "This tab does not exist" });
    }
    const selectedId = selectedTorrentId(state.torrents, params.threadId, query.torrent);
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
  .head(() => ({ meta: [{ title: "Your downloads — Tofu" }] }))
  .page(({ dashboard, params, detail, query }) => {
    if (!dashboard) {
      return null;
    }
    if (params.serverId !== dashboard.server.id) {
      return (
        <RemoteThread
          requested={query.torrent}
          serverId={params.serverId}
          threadId={params.threadId}
        />
      );
    }
    return (
      <App
        activeDestination={params.threadId}
        dashboard={dashboard}
        detail={detail}
        requested={query.torrent}
      />
    );
  });
