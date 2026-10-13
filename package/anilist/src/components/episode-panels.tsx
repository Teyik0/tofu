type Action = (task: () => Promise<unknown>) => void;

import { useMutation } from "@teyik0/furin/client";
import { usePluginHost } from "@tofu/plugins/client";
import type {
  AniListEntry,
  AniListMedia,
  AutomationDraft,
  AutomationRule,
  AutomationState,
  DashboardState,
} from "@tofu/plugins/domain";
import { Alert, AlertDescription } from "@tofu/ui/alert";
import { RuleFields } from "@tofu/ui/automation-fields";
import { Button } from "@tofu/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@tofu/ui/empty";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@tofu/ui/field";
import { OptionSelect } from "@tofu/ui/option-select";
import { Skeleton } from "@tofu/ui/skeleton";
import { TabsContent } from "@tofu/ui/tabs";
import { useAsyncAction } from "@tofu/ui/use-async-action";
import { LoaderCircleIcon, RefreshCwIcon, SettingsIcon, ZapIcon } from "lucide-react";
import { useState } from "react";
import { api, coreClient } from "../client-api";
import type { useAniListEditor } from "../hooks/use-anilist-editor";
import type { useAniListReleases } from "../hooks/use-anilist-releases";
import { useAutomationDraftForm } from "../hooks/use-automation-draft-form";
import { request } from "../request";
import { EpisodeRow } from "./episode-row";
import { AniListEditorUnavailable, AniListListEditor } from "./list-editor";

type EditorModel = ReturnType<typeof useAniListEditor>;
type ReleasesModel = ReturnType<typeof useAniListReleases>;

export function EpisodeListPanel({
  authenticated,
  entry,
  model,
  close,
}: {
  authenticated: boolean;
  entry: AniListMedia | AniListEntry;
  model: EditorModel;
  close: () => void;
}) {
  const { busy, error, action } = useAsyncAction("Unable to update this anime");
  const { editor, error: editorError, loading: editorLoading, reload: reloadEditor } = model;
  return (
    <TabsContent keepMounted value="list">
      {error ? (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
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
          retry={() => model.retry()}
        />
      )}
    </TabsContent>
  );
}

export function EpisodeDownloadsPanel({
  entry,
  dashboard,
  automation,
  destinationId,
  setDestinationId,
  model,
}: {
  entry: AniListMedia | AniListEntry;
  dashboard: DashboardState;
  automation: AutomationState;
  destinationId: string;
  setDestinationId: (value: string) => void;
  model: ReleasesModel;
}) {
  const { busy, error, action } = useAsyncAction("Unable to update this anime");
  const { result, loading, reload, releaseStatus, numbered, packs, episodes } = model;
  const listed = "progress" in entry;
  const destinationOptions = dashboard.destinations.map((destination) => ({
    label: destination.name,
    value: destination.id,
  }));
  const hasSources = automation.plugins.some(
    (plugin) => plugin.enabled && ["nyaa", "tsundere", "c411"].includes(plugin.id)
  );
  return (
    <TabsContent value="episodes">
      {error || model.error ? (
        <Alert>
          <AlertDescription>{error ?? model.error}</AlertDescription>
        </Alert>
      ) : null}
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
              Episode counts and releases appear when AniList and your enabled sources provide them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </TabsContent>
  );
}

export function EpisodeAutomationPanel({
  entry,
  dashboard,
  rule,
  destinationId,
  setDestinationId,
  reload,
}: {
  entry: AniListMedia | AniListEntry;
  dashboard: DashboardState;
  rule: AutomationRule | undefined;
  destinationId: string;
  setDestinationId: (value: string) => void;
  reload: () => void;
}) {
  const { refresh } = usePluginHost();
  const saveAutomation = useMutation((body: AutomationDraft) =>
    api.anilist.entries({ mediaId: entry.mediaId }).automation.put(body)
  );
  const runAutomation = useMutation((id: string) => coreClient.automations({ id }).run.post());
  const {
    draft,
    setDraft,
    validatedDraft,
    error: draftError,
  } = useAutomationDraftForm(rule ?? null);
  const { busy, error: serverError, action: run } = useAsyncAction("Unable to update this anime");
  const [notice, setNotice] = useState<string | null>(null);
  const error = draftError ?? serverError;
  const action: Action = (task) => {
    setNotice(null);
    run(task);
  };
  const listed = "progress" in entry;
  const destinationOptions = dashboard.destinations.map((destination) => ({
    label: destination.name,
    value: destination.id,
  }));
  return (
    <TabsContent value="automation">
      {error ? (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <p className="anime-modal-notice" role="status">
          {notice}
        </p>
      ) : null}
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
            <FieldDescription>The rule downloads into this thread’s folder.</FieldDescription>
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
              const template = await request<AutomationDraft>("/automations/interpret", "POST", {
                destinationId,
                query: `Download "${entry.title}". Prefer 1080p then 720p.`,
              });
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
  );
}
