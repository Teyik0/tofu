import {
  BookOpenIcon,
  DownloadIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SettingsIcon,
  ZapIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AniListEntry,
  AniListReleases,
  AniListState,
  AutomationDraft,
  AutomationRule,
  AutomationState,
  FeedRelease,
} from "../types";
import { AniListCover } from "./anilist-cover";
import { request } from "./api";
import { useDashboard } from "./app-shell";
import { RuleFields } from "./automation-center";
import { bytes } from "./format";
import { OptionSelect } from "./option-select";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

type Action = (task: () => Promise<void>) => void;

function EpisodeRow({
  episode,
  releases,
  entry,
  destinationId,
  busy,
  action,
  reload,
  onState,
}: {
  episode: number | null;
  releases: FeedRelease[];
  entry: AniListEntry;
  destinationId: string;
  busy: boolean;
  action: Action;
  reload: () => Promise<void>;
  onState: (state: AniListState) => void;
}) {
  const { data: dashboard, refresh } = useDashboard();
  const [chosen, setChosen] = useState<string | null>(null);
  const release =
    releases.find((item) => `${item.sourceId}:${item.id}` === chosen) ??
    releases.find((item) => dashboard.torrents.some((download) => download.id === item.infoHash)) ??
    releases[0];
  const torrent = dashboard.torrents.find((item) => item.id === release?.infoHash);
  const completed = episode !== null && entry.completedEpisodes.includes(episode);
  const label =
    episode === null ? "Pack / unnumbered release" : `Episode ${String(episode).padStart(2, "0")}`;
  return (
    <article className="anime-episode-row">
      <div className="anime-episode-number">
        {episode === null ? "—" : String(episode).padStart(2, "0")}
      </div>
      <div className="anime-episode-info">
        <strong>{label}</strong>
        <span>
          {torrent
            ? torrent.progress === 1
              ? "Downloaded"
              : `${torrent.status} · ${(torrent.progress * 100).toFixed(1)}%`
            : releases.length
              ? `${releases.length} release${releases.length === 1 ? "" : "s"} available`
              : "No release found"}
        </span>
        {release ? (
          <span className="anime-release-name" title={release.title}>
            {release.title}
          </span>
        ) : null}
      </div>
      <div className="anime-episode-controls">
        {releases.length > 1 ? (
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
        ) : null}
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
                  await request("/discover/add", "POST", {
                    destinationId,
                    id: release.id,
                    paused: false,
                    sourceId: release.sourceId,
                  });
                  await refresh();
                  await reload();
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
                disabled={busy}
                id={`anime-episode-${episode}`}
                onCheckedChange={(checked) =>
                  action(async () => {
                    onState(
                      await request<AniListState>(
                        `/anilist/entries/${entry.mediaId}/episodes/${episode}`,
                        "PUT",
                        { completed: checked === true }
                      )
                    );
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

export function AniListEpisodeModal({
  entry,
  automation,
  onState,
  reloadAutomation,
  close,
}: {
  entry: AniListEntry;
  automation: AutomationState;
  onState: (state: AniListState) => void;
  reloadAutomation: () => Promise<void>;
  close: () => void;
}) {
  const { data: dashboard, refresh } = useDashboard();
  const rule = automation.automations.find((item) => item.id === entry.automationId);
  const [destinationId, setDestinationId] = useState(rule?.destinationId ?? "default");
  const destinationOptions = dashboard.destinations.map((destination) => ({
    label: destination.name,
    value: destination.id,
  }));
  const [result, setResult] = useState<AniListReleases | null>(null);
  const [draft, setDraft] = useState<AutomationDraft | null>(rule ?? null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const action: Action = (task) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    void task()
      .catch((cause) =>
        setError(cause instanceof Error ? cause.message : "Unable to update this anime")
      )
      .finally(() => setBusy(false));
  };
  const reload = async () => {
    setResult(
      await request<AniListReleases>(`/anilist/entries/${entry.mediaId}/releases`, "POST", {})
    );
  };
  useEffect(() => {
    let active = true;
    void request<AniListReleases>(`/anilist/entries/${entry.mediaId}/releases`, "POST", {})
      .then((value) => {
        if (active) {
          setResult(value);
        }
      })
      .catch((cause) => {
        if (active) {
          setError(cause instanceof Error ? cause.message : "Unable to find episodes");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [entry.mediaId]);
  const numbered = new Map<number, FeedRelease[]>();
  const packs: FeedRelease[] = [];
  for (const release of result?.releases ?? []) {
    if (release.pack || release.episode === null) {
      packs.push(release);
    } else {
      const group = numbered.get(release.episode) ?? [];
      group.push(release);
      numbered.set(release.episode, group);
    }
  }
  const episodes = [
    ...new Set([
      ...numbered.keys(),
      ...entry.completedEpisodes,
      ...Array.from({ length: entry.episodes ?? 0 }, (_, index) => index + 1),
    ]),
  ].sort((a, b) => a - b);
  const available = numbered.size;
  const hasSources = automation.plugins.some(
    (plugin) => plugin.enabled && ["nyaa", "tsundere", "c411"].includes(plugin.id)
  );
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
    >
      <DialogContent className="anime-modal">
        <div
          className="anime-modal-banner"
          style={
            entry.bannerImage
              ? {
                  backgroundImage: `linear-gradient(0deg, var(--card), transparent), url(${JSON.stringify(entry.bannerImage)})`,
                }
              : undefined
          }
        />
        <div className="anime-modal-heading">
          <div className="anime-modal-cover">
            <AniListCover src={entry.coverImage} />
          </div>
          <div>
            <span className="anilist-eyebrow">
              {entry.format?.replaceAll("_", " ") ?? "ANIME"} · {entry.seasonYear ?? "—"}
            </span>
            <DialogTitle>{entry.title}</DialogTitle>
            <DialogDescription>
              {entry.progress} / {entry.episodes ?? "—"} episodes watched ·{" "}
              {result ? available : "—"} with releases
            </DialogDescription>
          </div>
          {entry.siteUrl ? (
            <a
              aria-label={`Open ${entry.title} on AniList`}
              className="anime-external-link"
              href={entry.siteUrl}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon />
            </a>
          ) : null}
        </div>
        <div className="anime-modal-body">
          {error ? (
            <Alert>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          {notice ? <p role="status">{notice}</p> : null}
          <Tabs defaultValue="episodes">
            <TabsList variant="line">
              <TabsTrigger value="episodes">
                <BookOpenIcon />
                Episodes
              </TabsTrigger>
              <TabsTrigger value="automation">
                <ZapIcon />
                Automation
              </TabsTrigger>
            </TabsList>
            <TabsContent value="episodes">
              <div className="anime-episodes-toolbar">
                <Field>
                  <FieldLabel htmlFor="anime-download-destination">Download to</FieldLabel>
                  <OptionSelect
                    disabled={busy}
                    id="anime-download-destination"
                    onValueChange={setDestinationId}
                    options={destinationOptions}
                    value={destinationId}
                  />
                </Field>
                <Button
                  disabled={busy || loading}
                  onClick={() => action(reload)}
                  size="sm"
                  variant="outline"
                >
                  <RefreshCwIcon data-icon="inline-start" />
                  Find releases
                </Button>
              </div>
              <p className="anime-sync-note">
                Mark episodes Completed to sync consecutive progress to AniList. Skipped episodes
                stay marked in Tofu until you catch up. An authenticated account is required.
              </p>
              {hasSources ? null : (
                <Alert>
                  <AlertDescription>
                    Enable Nyaa, Tsundere or C411 in Plugins to find downloads.
                  </AlertDescription>
                </Alert>
              )}
              {result?.errors.map((item) => (
                <Alert key={item.sourceId}>
                  <AlertDescription>
                    {item.sourceId}: {item.message}
                  </AlertDescription>
                </Alert>
              ))}
              {loading ? (
                <div aria-label="Finding episodes" className="anime-episode-list" role="status">
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                </div>
              ) : episodes.length || packs.length ? (
                <div className="anime-episode-list">
                  {episodes.map((episode) => (
                    <EpisodeRow
                      action={action}
                      busy={busy}
                      destinationId={destinationId}
                      entry={entry}
                      episode={episode}
                      key={episode}
                      onState={onState}
                      releases={numbered.get(episode) ?? []}
                      reload={reload}
                    />
                  ))}
                  {packs.map((release) => (
                    <EpisodeRow
                      action={action}
                      busy={busy}
                      destinationId={destinationId}
                      entry={entry}
                      episode={null}
                      key={`${release.sourceId}:${release.id}`}
                      onState={onState}
                      releases={[release]}
                      reload={reload}
                    />
                  ))}
                </div>
              ) : (
                <Empty>
                  <EmptyHeader>
                    <EmptyTitle>No episodes found yet</EmptyTitle>
                    <EmptyDescription>
                      Episode counts and releases appear when AniList and your enabled sources
                      provide them.
                    </EmptyDescription>
                  </EmptyHeader>
                </Empty>
              )}
            </TabsContent>
            <TabsContent value="automation">
              <div className="anime-automation-intro">
                <SettingsIcon />
                <div>
                  <strong>Preferences for this anime</strong>
                  <p>
                    {rule
                      ? "Edit this anime’s rule. Its preferences take precedence over the default tracking template."
                      : "Create a rule just for this anime, with your own sources, quality and replacement preferences."}
                  </p>
                </div>
              </div>
              {draft ? (
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="anime-rule-destination">Automation destination</FieldLabel>
                    <OptionSelect
                      disabled={busy}
                      id="anime-rule-destination"
                      onValueChange={(value) => {
                        setDestinationId(value);
                        setDraft({ ...draft, destinationId: value });
                      }}
                      options={destinationOptions}
                      value={draft.destinationId}
                    />
                    <FieldDescription>
                      The rule downloads into this thread’s folder.
                    </FieldDescription>
                  </Field>
                  <RuleFields
                    draft={draft}
                    identity={
                      <FieldDescription>
                        The anime title and aliases come from AniList. Watched episodes are excluded
                        automatically.
                      </FieldDescription>
                    }
                    onChange={setDraft}
                  />
                  <div className="automation-form-actions">
                    <Button
                      disabled={busy || !draft.sources.length}
                      onClick={() =>
                        action(async () => {
                          const saved = await request<AutomationRule>(
                            `/anilist/entries/${entry.mediaId}/automation`,
                            "PUT",
                            draft
                          );
                          setDraft(saved);
                          onState(await request<AniListState>("/anilist", "GET", undefined));
                          await reloadAutomation();
                          setNotice("Automation saved for this anime.");
                        })
                      }
                    >
                      {busy ? (
                        <LoaderCircleIcon data-icon="inline-start" />
                      ) : (
                        <ZapIcon data-icon="inline-start" />
                      )}
                      Save anime automation
                    </Button>
                    {rule ? (
                      <Button
                        disabled={busy || !rule.enabled}
                        onClick={() =>
                          action(async () => {
                            await request(`/automations/${rule.id}/run`, "POST", {});
                            await refresh();
                            await reloadAutomation();
                            await reload();
                            setNotice("Automation checked for new releases.");
                          })
                        }
                        variant="outline"
                      >
                        Run now
                      </Button>
                    ) : null}
                  </div>
                </FieldGroup>
              ) : (
                <Button
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      const template = await request<AutomationDraft>(
                        "/automations/interpret",
                        "POST",
                        {
                          destinationId,
                          query: `Download "${entry.title}". Prefer 1080p then 720p.`,
                        }
                      );
                      setDraft({
                        ...template,
                        afterEpisode: entry.progress,
                        aliases: entry.aliases,
                        includeExisting: true,
                        title: entry.title,
                      });
                    })
                  }
                >
                  <ZapIcon data-icon="inline-start" />
                  Customize automation
                </Button>
              )}
            </TabsContent>
          </Tabs>
        </div>
      </DialogContent>
    </Dialog>
  );
}
