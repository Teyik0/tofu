import { useMutation } from "@teyik0/furin/client";
import { DownloadIcon, PlayIcon } from "lucide-react";
import { useState } from "react";
import type { AniListEntry, AniListMedia } from "../../api/modules/anilist/types";
import type { LiveState } from "../../api/modules/dashboard/projection";
import type { FeedRelease } from "../../api/modules/discovery/model";
import { bytes } from "../../components/format";
import { OptionSelect } from "../../components/option-select";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Field, FieldLabel } from "../../components/ui/field";
import { Skeleton } from "../../components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import type { AsyncAction as Action } from "../../hooks/use-async-action";
import { api } from "../../lib/client";
import { useRefresh } from "../../lib/navigation";
import { playSoundCue } from "../../lib/sound-cues";

type ReleaseStatus = "searching" | "ready" | "failed";

interface EpisodeRowProps {
  action: Action;
  busy: boolean;
  destinationId: string;
  entry: AniListMedia | AniListEntry;
  episode: number | null;
  releaseStatus: ReleaseStatus;
  releases: FeedRelease[];
  remote: NonNullable<
    Awaited<ReturnType<(typeof api)["linked-libraries"]["availability"]["post"]>>["data"]
  >;
  torrents: LiveState["torrents"];
}

export function EpisodeRow({
  torrents,
  episode,
  releases,
  entry,
  destinationId,
  busy,
  releaseStatus,
  action,
  remote,
}: EpisodeRowProps) {
  const refresh = useRefresh();
  const addRelease = useMutation(api.discover.add.post);
  const completeEpisode = useMutation((episodeNumber: number, isCompleted: boolean) =>
    api.anilist
      .entries({ mediaId: entry.mediaId })
      .episodes({ episode: episodeNumber })
      .put({ completed: isCompleted })
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const torrentIds = new Set(torrents.map((download) => download.id));
  const release =
    releases.find((item) => `${item.sourceId}:${item.id}` === chosen) ??
    releases.find((item) => item.infoHash !== null && torrentIds.has(item.infoHash)) ??
    releases[0];
  const torrent = torrents.find((item) => item.id === release?.infoHash);
  const remoteMatches = remote.flatMap((item) =>
    item.sources
      .filter((source) => source.episode === episode)
      .map((source) => ({ ...source, connectionState: item.state, link: item.link }))
  );
  const sources = remoteMatches.filter(
    (source) =>
      source.connectionState === "available" &&
      (source.status === "playable" || source.status === "downloading")
  );
  const listed = "progress" in entry;
  const completed = listed && episode !== null && entry.completedEpisodes.includes(episode);
  const label =
    episode === null ? "Pack / unnumbered release" : `Episode ${String(episode).padStart(2, "0")}`;
  return (
    <article className="anime-episode-row">
      <div className="anime-episode-number">
        {episode === null ? "—" : String(episode).padStart(2, "0")}
      </div>
      <div className="anime-episode-info">
        <strong>{label}</strong>
        {sources.length ? (
          <span>
            Available on{" "}
            {sources
              .map((source) => source.link.name)
              .filter((name, index, all) => all.indexOf(name) === index)
              .join(", ")}
          </span>
        ) : null}
        {remoteMatches.length > 0 && sources.length === 0 ? (
          <span>
            {remoteMatches
              .map(
                (source) =>
                  `${source.link.name}: ${source.connectionState === "offline" ? "offline (last known file)" : source.status}`
              )
              .join(", ")}
          </span>
        ) : null}
        {torrent || remoteMatches.length === 0 ? (
          <EpisodeStatus
            releaseCount={releases.length}
            releaseStatus={releaseStatus}
            torrent={torrent}
          />
        ) : null}
        {release ? (
          <Tooltip>
            <TooltipTrigger className="anime-release-name" render={<span />} tabIndex={0}>
              {release.title}
            </TooltipTrigger>
            <TooltipContent>{release.title}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      <div className="anime-episode-controls">
        <EpisodeReleasePicker
          label={label}
          release={release}
          releases={releases}
          setChosen={setChosen}
        />
        <div className="anime-episode-actions">
          {sources.map((source) => (
            <Button
              aria-label={`Watch ${source.fileName} on ${source.link.name}`}
              key={`${source.link.id}:${source.torrentId}:${source.fileIndex}`}
              onClick={() => {
                const query = new URLSearchParams({
                  episode: String(episode),
                  file: String(source.fileIndex),
                  link: source.link.id,
                  media: String(entry.mediaId),
                  torrent: source.torrentId,
                });
                window.location.assign(`/player/remote?${query}`);
              }}
              size="sm"
              title={`${source.fileName} · ${source.resolution ?? "Unknown quality"} · ${source.match === "title" ? "Matched by title" : "Exact release"}`}
              variant="secondary"
            >
              <PlayIcon data-icon="inline-start" />
              Watch on {source.link.name}
              {sources.length > 1 && source.resolution ? ` · ${source.resolution}` : ""}
            </Button>
          ))}
          {torrent ? (
            <Badge variant="secondary">
              {torrent.progress === 1 ? "Downloaded" : torrent.status}
            </Badge>
          ) : release ? (
            <Button
              disabled={busy || !destinationId}
              onClick={() =>
                action(async () => {
                  await addRelease.mutateAsync({
                    destinationId,
                    id: release.id,
                    paused: false,
                    sourceId: release.sourceId,
                  });
                  playSoundCue("added");
                  await refresh();
                })
              }
              size="sm"
            >
              <DownloadIcon data-icon="inline-start" />
              Download
            </Button>
          ) : null}
          {episode === null ? null : (
            <Field orientation="horizontal">
              <Checkbox
                aria-label={`Mark ${label} completed`}
                checked={completed}
                disabled={busy || !listed}
                id={`anime-episode-${episode}`}
                onCheckedChange={(checked) =>
                  action(async () => {
                    await completeEpisode.mutateAsync(episode, checked === true);
                    await refresh();
                  })
                }
              />
              <FieldLabel htmlFor={`anime-episode-${episode}`}>Completed</FieldLabel>
            </Field>
          )}
        </div>
      </div>
    </article>
  );
}

function EpisodeReleasePicker({
  label,
  release,
  releases,
  setChosen,
}: {
  label: string;
  release: FeedRelease | undefined;
  releases: FeedRelease[];
  setChosen: (value: string) => void;
}) {
  return releases.length > 1 ? (
    <OptionSelect
      ariaLabel={`Release for ${label}`}
      className="anime-release-select"
      contentClassName="anime-release-options"
      disabled={false}
      onValueChange={setChosen}
      options={releases.map((item) => ({
        label: `${item.sourceId} · ${item.resolution ?? "—"} · ${item.language ?? "—"} · ${item.title}`,
        value: `${item.sourceId}:${item.id}`,
      }))}
      value={release ? `${release.sourceId}:${release.id}` : ""}
    />
  ) : release ? (
    <div className="anime-release-meta">
      <Badge variant="outline">{release.sourceId}</Badge>
      <span>
        {release.resolution ?? "—"} · {release.language ?? "—"} · {bytes(release.size)} ·{" "}
        {release.seeders ?? "—"} seeds
      </span>
    </div>
  ) : null;
}

function EpisodeStatus({
  torrent,
  releaseCount,
  releaseStatus,
}: {
  torrent: LiveState["torrents"][number] | undefined;
  releaseCount: number;
  releaseStatus: ReleaseStatus;
}) {
  if (!(torrent || releaseCount) && releaseStatus === "searching") {
    return <Skeleton aria-hidden="true" className="h-3 w-32" />;
  }
  let text = "No release found";
  if (torrent) {
    const progress = torrent.progress === null ? "—" : `${(torrent.progress * 100).toFixed(1)}%`;
    text = torrent.progress === 1 ? "Downloaded" : `${torrent.status} · ${progress}`;
  } else if (releaseCount) {
    text = `${releaseCount} release${releaseCount === 1 ? "" : "s"} available`;
  } else if (releaseStatus === "failed") {
    text = "Release search unavailable";
  }
  return <span>{text}</span>;
}
