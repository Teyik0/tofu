import { defineRoute, notFound } from "@teyik0/furin";
import { defer } from "@teyik0/furin/client";
import { t } from "elysia";
import { App } from "../../components/app";
import { api } from "../../lib/client";
import { route as root } from "../root";

export const route = defineRoute()
  .config({ layout: root, mode: "ssr", params: t.Object({ id: t.String() }) })
  .loader(async ({ dashboard, params }) => {
    const state = await dashboard;
    if (!state.destinations.some((destination) => destination.id === params.id)) {
      notFound({ message: "This tab does not exist" });
    }
    const initialTorrentId =
      state.torrents.find((torrent) => torrent.destinationId === params.id)?.id ?? null;
    const initialDetail = initialTorrentId
      ? api
          .torrents({ id: initialTorrentId })
          .get()
          .then(({ data, error }) => {
            if (error || !data || !("id" in data)) {
              throw new Error("Unable to load the torrent");
            }
            return data;
          })
      : Promise.resolve(null);
    return defer({ initialDetail, initialTorrentId });
  })
  .head(() => ({ meta: [{ title: "Your downloads — Tofu" }] }))
  .page(({ dashboard, params, initialDetail, initialTorrentId }) => (
    <App
      activeDestination={params.id}
      dashboard={dashboard}
      initialDetail={initialDetail}
      initialTorrentId={initialTorrentId}
    />
  ));
