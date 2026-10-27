import { useMutation } from "@teyik0/furin/client";
import type { LinkedAvailability } from "@tofu/plugins/availability";
import { usePluginHost } from "@tofu/plugins/client";
import type { LiveState } from "@tofu/plugins/library-state";
import { DownloadIcon, PlayIcon, SearchIcon } from "lucide-react";
import { useState } from "react";
import type { EpisodeSource } from "../../../plugins/src/availability";
import type { FeedRelease } from "../../../plugins/src/discovery-model";
import { bytes } from "../../../ui/src/format";
import { OptionSelect } from "../../../ui/src/option-select";
import { Badge } from "../../../ui/src/ui/badge";
import { Button } from "../../../ui/src/ui/button";
import { Checkbox } from "../../../ui/src/ui/checkbox";
import { Field, FieldLabel } from "../../../ui/src/ui/field";
import { Skeleton } from "../../../ui/src/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../ui/src/ui/tooltip";
import type { AsyncAction as Action } from "../../../ui/src/use-async-action";
import { api } from "../client-api";
import type { AniListEntry, AniListMedia } from "../server/types";

type ReleaseStatus = "searching" | "ready" | "failed";

interface EpisodeRowProps {
  action: Action;
  busy: boolean;
  destinationId: string;
  entry: AniListMedia | AniListEntry;
  episode: number | null;
  localSources?: EpisodeSource[];
  releaseStatus: ReleaseStatus;
  releases: FeedRelease[];
  remote: LinkedAvailability;
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
  localSources,
}: EpisodeRowProps) {
  const { refresh, playSound: playSoundCue } = usePluginHost();
  const { openSearch } = usePluginHost();
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
  const local = localSources?.find(
    (source) => source.episode === episode && torrents.some((item) => item.id === source.torrentId)
  );
  const torrent = torrents.find((item) => item.id === (local?.torrentId ?? release?.infoHash));
  const downloaded =
    torrent &&
    !torrent.storageIssue &&
    torrent.status !== "error" &&
    torrent.status !== "checking" &&
    (local?.progress === 1 || torrent.progress === 1);
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
            downloaded={Boolean(downloaded)}
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
            <Badge variant="secondary">{downloaded ? "Downloaded" : torrent.status}</Badge>
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
          {!(release || torrent) && sources.length === 0 && releaseStatus !== "searching" ? (
            <Button
              aria-label={`Search manually for ${entry.title}, ${label.toLowerCase()}`}
              onClick={() =>
                openSearch({
                  destinationId,
                  query: `${entry.title}${episode === null ? "" : ` ${String(episode).padStart(2, "0")}`}`,
                })
              }
              size="sm"
              variant="outline"
            >
              <SearchIcon data-icon="inline-start" />
              Search manually
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
  downloaded,
  torrent,
  releaseCount,
  releaseStatus,
}: {
  downloaded: boolean;
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
    text = downloaded ? "Downloaded" : `${torrent.status} · ${progress}`;
  } else if (releaseCount) {
    text = `${releaseCount} release${releaseCount === 1 ? "" : "s"} available`;
  } else if (releaseStatus === "failed") {
    text = "Release search unavailable";
  }
  return <span>{text}</span>;
}
