import { defineRoute, notFound } from "@teyik0/furin";
import { t } from "elysia";
import { MediaPlayer } from "../../components/media-player";
import { api } from "../../lib/client";

export const route = defineRoute("/player/[id]")
  .config({
    mode: "ssr",
    params: t.Object({ id: t.String() }),
    query: t.Object({ file: t.String() }),
  })
  .loader(async ({ params, query, set }) => {
    set.headers["cross-origin-embedder-policy"] = "require-corp";
    set.headers["cross-origin-opener-policy"] = "same-origin";
    const { data, error } = await api.torrents({ id: params.id }).get();
    if (error) {
      if (error.status === 404) {
        notFound({ message: "This torrent does not exist" });
      }
      throw error;
    }
    const file = data.files[Number(query.file)];
    if (!file) {
      notFound({ message: "This file does not exist" });
    }
    return { file, torrent: data };
  })
  .head(() => ({ meta: [{ title: "Player — Tofu" }] }))
  .page(({ file, torrent }) => (
    <MediaPlayer
      // Leaving the player reloads the library outside the player's cross-origin isolation.
      back={`/thread/${torrent.destinationId}?torrent=${torrent.id}`}
      complete={file.progress === 1}
      index={file.index}
      mediaKey={`${torrent.id}:${file.index}:${file.length}`}
      name={file.name}
      source={`/api/torrents/${torrent.id}/files/${file.index}/stream/${encodeURIComponent(file.name)}`}
      torrentId={torrent.id}
      unavailable={
        torrent.status === "paused" && file.progress !== 1
          ? "Resume this torrent in the library to play it while it downloads."
          : null
      }
    />
  ));
