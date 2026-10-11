import { useField, useForm } from "@formisch/react";
import { useMutation } from "@teyik0/furin/client";
import type {
  AniListEditor,
  AniListEntry,
  AniListMedia,
  AniListReleases,
  AutomationDraft,
  AutomationState,
  DashboardState,
  FeedRelease,
} from "@tofu/plugins/domain";
import { ActionTooltip } from "@tofu/ui/action-tooltip";
import { Alert, AlertDescription } from "@tofu/ui/alert";
import { RuleFields } from "@tofu/ui/automation-fields";
import { Badge } from "@tofu/ui/badge";
import { Button, buttonVariants } from "@tofu/ui/button";
import { Checkbox } from "@tofu/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@tofu/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@tofu/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@tofu/ui/field";
import { bytes } from "@tofu/ui/format";
import { OptionSelect } from "@tofu/ui/option-select";
import { Skeleton } from "@tofu/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@tofu/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@tofu/ui/tooltip";
import { cn } from "cn";
import {
  BookOpenIcon,
  DownloadIcon,
  ExternalLinkIcon,
  HeartIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
  SettingsIcon,
  ZapIcon,
} from "lucide-react";
import { type CSSProperties, useEffect, useState } from "react";
import { object, string } from "valibot";
import { api, coreClient } from "../client-api";
import { useAutomationDraftForm } from "../hooks/use-automation-draft-form";
import { useRefresh, useSoundCue } from "../host";
import { request } from "../request";
import { AniListCover } from "./cover";
import { AniListEditorUnavailable, AniListListEditor } from "./list-editor";

type Action = (task: () => Promise<void>) => void;
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

function EpisodeRow({
  torrents,
  episode,
  releases,
  entry,
  destinationId,
  busy,
  releaseStatus,
  action,
}: EpisodeRowProps) {
  const refresh = useRefresh();
  const playSoundCue = useSoundCue();
  const addRelease = useMutation(coreClient.discover.add.post);
  const completeEpisode = useMutation((episodeNumber: number, isCompleted: boolean) =>
    api.anilist
      .entries({ mediaId: entry.mediaId })
      .episodes({ episode: episodeNumber })
      .put({ completed: isCompleted })
  );
  const [chosen, setChosen] = useState<string | null>(null);
  const release =
    releases.find((item) => `${item.sourceId}:${item.id}` === chosen) ??
    releases.find((item) => torrents.some((download) => download.id === item.infoHash)) ??
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
        {!(torrent || releases.length) && releaseStatus === "searching" ? (
          <Skeleton aria-hidden="true" className="h-3 w-32" />
        ) : (
          <span>
            {torrent
              ? torrent.progress === 1
                ? "Downloaded"
                : `${torrent.status} · ${(torrent.progress * 100).toFixed(1)}%`
              : releases.length
                ? `${releases.length} release${releases.length === 1 ? "" : "s"} available`
                : releaseStatus === "failed"
                  ? "Release search unavailable"
                  : "No release found"}
          </span>
        )}
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

export function AniListEpisodeModal({
  authenticated,
  dashboard,
  entry,
  automation,
  close,
}: {
  authenticated: boolean;
  dashboard: DashboardState;
  entry: AniListMedia | AniListEntry;
  automation: AutomationState;
  close: () => void;
}) {
  const refresh = useRefresh();
  const saveAutomation = useMutation((body: AutomationDraft) =>
    api.anilist.entries({ mediaId: entry.mediaId }).automation.put(body)
  );
  const runAutomation = useMutation((id: string) => coreClient.automations({ id }).run.post());
  const openAnime = useMutation(api.anilist.open.post);
  const setFavourite = useMutation((enabled: boolean) =>
    api.anilist.entries({ mediaId: entry.mediaId }).favourite.put({ enabled })
  );
  const [editor, setEditor] = useState<AniListEditor | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorLoading, setEditorLoading] = useState(authenticated);
  const [editorVersion, setEditorVersion] = useState(0);
  const listed = "progress" in entry;
  const rule = listed
    ? automation.automations.find((item) => item.id === entry.automationId)
    : undefined;
  const destinationForm = useForm({
    initialInput: { destinationId: rule?.destinationId ?? "default" },
    schema: object({ destinationId: string() }),
  });
  const destinationField = useField(destinationForm, { path: ["destinationId"] });
  const destinationId = destinationField.input ?? "default";
  const setDestinationId = destinationField.onChange;
  const destinationOptions = dashboard.destinations.map((destination) => ({
    label: destination.name,
    value: destination.id,
  }));
  const [result, setResult] = useState<AniListReleases | null>(null);
  const {
    draft,
    setDraft,
    validatedDraft,
    error: draftError,
  } = useAutomationDraftForm(rule ?? null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [searchVersion, setSearchVersion] = useState(0);
  const [releaseError, setReleaseError] = useState<string | null>(null);
  const [serverError, setError] = useState<string | null>(null);
  const error = draftError ?? serverError;
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
  const reload = () => {
    setLoading(true);
    setReleaseError(null);
    setSearchVersion((value) => value + 1);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads the editor.
  useEffect(() => {
    if (!authenticated) {
      setEditor(null);
      setEditorLoading(false);
      return;
    }
    const controller = new AbortController();
    setEditorLoading(true);
    setEditorError(null);
    void request<AniListEditor>(
      `/anilist/entries/${entry.mediaId}/editor`,
      "GET",
      undefined,
      controller.signal
    )
      .then(setEditor)
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setEditorError(
            cause instanceof Error ? cause.message : "Unable to load your AniList entry"
          );
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setEditorLoading(false);
        }
      });
    return () => controller.abort();
  }, [authenticated, entry.mediaId, editorVersion]);
  const reloadEditor = async () => {
    const updated = await request<AniListEditor>(
      `/anilist/entries/${entry.mediaId}/editor`,
      "GET",
      undefined
    );
    setEditor(updated);
    await refresh();
    return updated;
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: refreshing explicitly starts a new release search.
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
          setReleaseError(cause instanceof Error ? cause.message : "Unable to find releases");
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
  }, [entry.mediaId, searchVersion]);
  const releaseStatus: ReleaseStatus = loading ? "searching" : releaseError ? "failed" : "ready";
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
      ...(listed ? entry.completedEpisodes : []),
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
        {/* Without a banner, AniList-style blurred cover art keeps the header from looking empty. */}
        <div
          className="anime-modal-banner"
          data-source={entry.bannerImage ? "banner" : entry.coverImage ? "cover" : "none"}
          style={
            entry.bannerImage || entry.coverImage
              ? ({
                  "--anime-banner": `url(${JSON.stringify(entry.bannerImage ?? entry.coverImage)})`,
                } as CSSProperties)
              : undefined
          }
        />
        <div className="anime-modal-heading">
          <div className="anime-modal-cover">
            <AniListCover src={entry.coverImage} />
          </div>
          <div className="anime-modal-title">
            <span className="anilist-eyebrow">
              {entry.format?.replaceAll("_", " ") ?? "ANIME"} · {entry.seasonYear ?? "—"}
            </span>
            <DialogTitle>{entry.title}</DialogTitle>
            <DialogDescription>
              {listed ? entry.progress : "—"} / {entry.episodes ?? "—"} episodes watched ·{" "}
              {result ? available : "—"} with releases
            </DialogDescription>
          </div>
          <div className="anime-modal-actions">
            <Button
              aria-label={editor?.isFavourite ? "Remove from favourites" : "Add to favourites"}
              aria-pressed={editor?.isFavourite ?? false}
              className="anime-favourite-button"
              disabled={
                busy ||
                editorLoading ||
                !authenticated ||
                !editor ||
                editor.isFavourite === null ||
                editor.isFavouriteBlocked === true
              }
              onClick={() =>
                action(async () => {
                  const favouriteResult = await setFavourite.mutateAsync(!editor?.isFavourite);
                  if (favouriteResult && "isFavourite" in favouriteResult) {
                    setEditor((current) =>
                      current ? { ...current, isFavourite: favouriteResult.isFavourite } : current
                    );
                    setNotice(
                      favouriteResult.isFavourite
                        ? "Added to AniList favourites."
                        : "Removed from AniList favourites."
                    );
                  }
                })
              }
              size="icon-lg"
              title={
                authenticated ? "AniList favourite" : "Connect AniList to favourite this anime"
              }
              variant={editor?.isFavourite ? "secondary" : "outline"}
            >
              <HeartIcon fill={editor?.isFavourite ? "currentColor" : "none"} />
            </Button>
            {entry.siteUrl ? (
              <ActionTooltip>
                <a
                  aria-label={`Open ${entry.title} on AniList`}
                  className={cn(
                    buttonVariants({ size: "icon-lg", variant: "outline" }),
                    "anime-external-link"
                  )}
                  href={entry.siteUrl}
                  onClick={(event) => {
                    if (dashboard.session.mode !== "desktop") {
                      return;
                    }
                    event.preventDefault();
                    const url = event.currentTarget.href;
                    action(async () => {
                      await openAnime.mutateAsync({ url });
                    });
                  }}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  <ExternalLinkIcon />
                </a>
              </ActionTooltip>
            ) : null}
          </div>
        </div>
        <div className="anime-modal-body">
          {error || releaseError ? (
            <Alert>
              <AlertDescription>{error ?? releaseError}</AlertDescription>
            </Alert>
          ) : null}
          {notice ? (
            <p className="anime-modal-notice" role="status">
              {notice}
            </p>
          ) : null}
          <Tabs defaultValue="list">
            <TabsList variant="line">
              <TabsTrigger value="list">
                <ListChecksIcon />
                My list
              </TabsTrigger>
              <TabsTrigger value="episodes">
                <BookOpenIcon />
                Episodes
              </TabsTrigger>
              <TabsTrigger disabled={!listed} value="automation">
                <ZapIcon />
                Automation
              </TabsTrigger>
            </TabsList>
            <TabsContent keepMounted value="list">
              {editorLoading ? (
                <>
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                </>
              ) : editor && authenticated ? (
                <AniListListEditor
                  action={action}
                  busy={busy}
                  editor={editor}
                  media={entry}
                  removed={async () => {
                    await reloadEditor();
                    close();
                  }}
                  saved={reloadEditor}
                />
              ) : (
                <AniListEditorUnavailable
                  authenticated={authenticated}
                  error={editorError}
                  retry={() => setEditorVersion((value) => value + 1)}
                />
              )}
            </TabsContent>
            <TabsContent value="episodes">
              <div className="anime-episodes-toolbar">
                <Field className="anilist-filter">
                  <FieldLabel htmlFor="anime-download-destination">Download to</FieldLabel>
                  <OptionSelect
                    className="anilist-filter-trigger"
                    contentClassName="anilist-select-menu"
                    disabled={busy}
                    id="anime-download-destination"
                    onValueChange={setDestinationId}
                    options={destinationOptions}
                    value={destinationId}
                  />
                </Field>
                <Button disabled={busy || loading} onClick={reload} size="sm" variant="outline">
                  <RefreshCwIcon
                    className={loading ? "motion-safe:animate-spin" : undefined}
                    data-icon="inline-start"
                  />
                  Find releases
                </Button>
              </div>
              <p className="anime-sync-note">
                {listed
                  ? "Mark episodes Completed to sync consecutive progress to AniList. Skipped episodes stay marked in Tofu until you catch up. An authenticated account is required."
                  : "Use My list to add this anime to AniList and sync watched episodes or customize its automation. You can download releases here without adding it to a list."}
              </p>
              {loading ? (
                <p className="anime-sync-note" role="status">
                  Finding releases…
                </p>
              ) : null}
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
              {result?.search?.warning ? (
                <Alert>
                  <AlertDescription>{result.search.warning}</AlertDescription>
                </Alert>
              ) : null}
              {episodes.length || packs.length ? (
                <div className="anime-episode-list">
                  {episodes.map((episode) => (
                    <EpisodeRow
                      action={action}
                      busy={busy}
                      destinationId={destinationId}
                      entry={entry}
                      episode={episode}
                      key={episode}
                      releaseStatus={releaseStatus}
                      releases={numbered.get(episode) ?? []}
                      torrents={dashboard.torrents}
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
                      releaseStatus={releaseStatus}
                      releases={[release]}
                      torrents={dashboard.torrents}
                    />
                  ))}
                </div>
              ) : loading ? (
                <div aria-hidden="true" className="anime-episode-list">
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
                  <Skeleton className="h-20" />
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
                          const validated = await validatedDraft();
                          if (!validated) {
                            return;
                          }
                          const saved = await saveAutomation.mutateAsync(validated);
                          if (!(saved && "id" in saved)) {
                            return;
                          }
                          setDraft(saved);
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
                            await runAutomation.mutateAsync(rule.id);
                            await refresh();
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
                  disabled={busy || !listed}
                  onClick={() =>
                    action(async () => {
                      if (!listed) {
                        return;
                      }
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
