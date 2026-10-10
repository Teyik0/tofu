import { notFound } from "@teyik0/furin";
import { defer } from "@teyik0/furin/client";
import { createTofuClient } from "../client";
import type { DashboardState, TorrentDetail } from "../types";

export async function loadTorrentPage(
  dashboard: Promise<DashboardState>,
  request: Request,
  destinationId: string | null
) {
  const state = await dashboard;
  if (
    destinationId !== null &&
    !state.destinations.some((destination) => destination.id === destinationId)
  ) {
    notFound({ message: "This tab does not exist" });
  }
  const initialTorrentId =
    state.torrents.find(
      (torrent) => destinationId === null || torrent.destinationId === destinationId
    )?.id ?? null;
  const initialDetail: Promise<TorrentDetail | null> = initialTorrentId
    ? (async () => {
        const { data, error } = await createTofuClient(new URL(request.url).origin, request)
          .api.torrents({ id: initialTorrentId })
          .get();
        if (error || !data || !("id" in data)) {
          throw new Error("Unable to load the torrent");
        }
        return data;
      })()
    : Promise.resolve(null);
  return defer({ initialDetail, initialTorrentId });
}
