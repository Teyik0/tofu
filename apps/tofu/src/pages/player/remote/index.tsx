import { defineRoute } from "@teyik0/furin";
import { t } from "elysia";
import { useEffect, useState } from "react";
import { Button } from "../../../../../../package/ui/src/ui/button";
import { MediaPlayer } from "../../../components/media-player";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";

type Source = NonNullable<
  Awaited<ReturnType<ReturnType<(typeof api)["linked-libraries"]>["play"]["post"]>>["data"]
>;

function RemotePlayer({
  link,
  torrent,
  file,
  media,
  episode,
}: {
  link: string;
  torrent: string;
  file: string;
  media: string;
  episode: string;
}) {
  const [source, setSource] = useState<Source | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const { data, error: failure } = await api["linked-libraries"]({ id: link }).play.post({
        fileIndex: Number(file),
        torrentId: torrent,
      });
      if (disposed) {
        return;
      }
      if (failure) {
        setError(errorMessage(failure, "This remote file is no longer available"));
        return;
      }
      setSource(data);
    };
    void load();
    return () => {
      disposed = true;
    };
  }, [link, torrent, file]);
  if (!source) {
    return (
      <main className="grid min-h-screen place-content-center gap-4 p-8">
        <p role="status">{error ?? "Opening remote source…"}</p>
        <Button onClick={() => window.location.assign("/anilist")}>Back to AniList</Button>
      </main>
    );
  }
  return (
    <MediaPlayer
      back="/anilist"
      complete={source.file.complete}
      index={source.file.index}
      initialGrant={source}
      mediaKey={`remote:${source.server.id}:${torrent}:${source.file.index}:${source.file.length}`}
      name={source.file.name}
      remoteEpisode={{ episode: Number(episode), mediaId: Number(media) }}
      retrySource={async () => {
        const { data, error: failure } = await api["linked-libraries"]({ id: link }).play.post({
          fileIndex: Number(file),
          torrentId: torrent,
        });
        if (failure) {
          throw failure;
        }
        return data;
      }}
      serverName={source.server.name}
      source={source.url}
      torrentId={torrent}
      unavailable={null}
    />
  );
}

export const route = defineRoute("/player/remote")
  .config({
    mode: "ssr",
    query: t.Object({
      episode: t.String(),
      file: t.String(),
      link: t.String(),
      media: t.String(),
      torrent: t.String(),
    }),
  })
  .loader(({ query, set }) => {
    set.headers["cross-origin-embedder-policy"] = "require-corp";
    set.headers["cross-origin-opener-policy"] = "same-origin";
    return query;
  })
  .head(() => ({ meta: [{ title: "Remote player — Tofu" }] }))
  .page((query) => <RemotePlayer {...query} />);
