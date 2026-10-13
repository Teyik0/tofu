type Action = (task: () => Promise<unknown>) => void;

import { useMutation } from "@teyik0/furin/client";
import { usePluginHost } from "@tofu/plugins/client";
import type { AniListEntry, AniListMedia, DashboardState, FeedRelease } from "@tofu/plugins/domain";
import { Badge } from "@tofu/ui/badge";
import { Button } from "@tofu/ui/button";
import { Checkbox } from "@tofu/ui/checkbox";
import { Field, FieldLabel } from "@tofu/ui/field";
import { bytes } from "@tofu/ui/format";
import { OptionSelect } from "@tofu/ui/option-select";
import { Skeleton } from "@tofu/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tofu/ui/tooltip";
import { DownloadIcon } from "lucide-react";
import { useState } from "react";
import { api, coreClient } from "../client-api";

type ReleaseStatus = "searching" | "ready" | "failed";

interface EpisodeRowProps {
  action: Action;
  busy: boolean;
  destinationId: string;
  entry: AniListMedia | AniListEntry;
  episode: number | null;
  releaseStatus: ReleaseStatus;
  releases: FeedRelease[];
  torrents: DashboardState["torrents"];
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
}: EpisodeRowProps) {
  const { refresh, playSound } = usePluginHost();
  const addRelease = useMutation(coreClient.discover.add.post);
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
        <EpisodeStatus
          releaseCount={releases.length}
          releaseStatus={releaseStatus}
          torrent={torrent}
        />
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
                  playSound?.("added");
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
  torrent: DashboardState["torrents"][number] | undefined;
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
