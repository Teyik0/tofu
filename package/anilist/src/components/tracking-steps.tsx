import { validate } from "@formisch/react";
import type { AniListThreadProposal } from "@tofu/plugins/domain";
import { PreferenceFields, preferenceSummary } from "@tofu/ui/automation-fields";
import { Button } from "@tofu/ui/button";
import { Checkbox } from "@tofu/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@tofu/ui/field";
import { Input } from "@tofu/ui/input";
import { OptionSelect } from "@tofu/ui/option-select";
import { CheckIcon, RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";
import { request } from "../request";
import { AniListCover } from "./cover";
import { aniListStatusLabel } from "./status";
import { AniListThreads } from "./threads";
import type { AniListTrackingProps, useAniListTracking } from "./use-tracking";

const organizationOptions = [
  { label: "One thread per anime", value: "per-anime" },
  { label: "All anime in the selected thread", value: "shared" },
] satisfies { label: string; value: "per-anime" | "shared" }[];
const trackedStatuses = ["CURRENT", "PLANNING"] as const;
function Step({
  number,
  title,
  description,
  children,
}: {
  number: number;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <li className="setup-step">
      <header>
        <b aria-hidden="true">{number}</b>
        <div>
          <h4>{title}</h4>
          <p>{description}</p>
        </div>
      </header>
      <div className="setup-step-body">{children}</div>
    </li>
  );
}

export function TrackingTitles({
  model,
  busy,
  action,
  reload,
  afterMutation,
  state,
}: Pick<AniListTrackingProps, "busy" | "action" | "reload" | "afterMutation" | "state"> & {
  model: ReturnType<typeof useAniListTracking>;
}) {
  const {
    selectEntry,
    loadList,
    statuses,
    setStatuses,
    pluginEnabled,
    unprepare,
    visible,
    approved,
    selectedCount,
  } = model;
  return (
    <Step
      description="Your choices stay in Tofu; your AniList list is never modified."
      number={1}
      title="Choose lists and titles"
    >
      <div className="setup-inline">
        {trackedStatuses.map((status) => (
          <Field key={status} orientation="horizontal">
            <Checkbox
              checked={statuses.includes(status)}
              id={`anilist-${status}`}
              onCheckedChange={(checked) => {
                unprepare();
                setStatuses(
                  checked === true
                    ? [...statuses, status]
                    : statuses.filter((value) => value !== status)
                );
              }}
            />
            <FieldLabel htmlFor={`anilist-${status}`}>{aniListStatusLabel(status)}</FieldLabel>
          </Field>
        ))}
        <Button
          disabled={busy || !pluginEnabled}
          onClick={() =>
            action(async () => {
              await loadList.mutateAsync();
              await (afterMutation ?? reload)();
              unprepare();
            })
          }
          size="sm"
          variant="outline"
        >
          <RefreshCwIcon data-icon="inline-start" />
          {state.entries.length ? "Reload lists" : "Load my lists"}
        </Button>
      </div>
      {visible.length ? (
        <>
          <p className="automation-muted">
            {selectedCount} of {visible.length} titles approved. New titles on your lists wait for
            your approval here.
          </p>
          <div className="title-grid">
            {visible.map((entry) => (
              <div
                className="title-card"
                data-selected={approved(entry.mediaId)}
                key={entry.mediaId}
              >
                <label className="title-card-label" htmlFor={`anilist-title-${entry.mediaId}`}>
                  <span className="title-card-cover">
                    <AniListCover src={entry.coverImage} />
                  </span>
                  <span className="title-card-copy">
                    <strong title={entry.title}>{entry.title}</strong>
                    <small>
                      {aniListStatusLabel(entry.status)} · {entry.progress}/{entry.episodes ?? "?"}{" "}
                      watched
                    </small>
                  </span>
                </label>
                <Checkbox
                  checked={approved(entry.mediaId)}
                  disabled={busy}
                  id={`anilist-title-${entry.mediaId}`}
                  onCheckedChange={(checked) =>
                    action(async () => {
                      unprepare();
                      await selectEntry.mutateAsync(entry.mediaId, checked === true);
                      await (afterMutation ?? reload)();
                    })
                  }
                />
              </div>
            ))}
          </div>
        </>
      ) : (
        <p className="automation-muted">
          {state.entries.length
            ? "No titles in the selected lists."
            : "Load your lists to choose which anime Tofu should follow."}
        </p>
      )}
    </Step>
  );
}

export function TrackingDestination({
  model,
  destinationField,
  busy,
}: Pick<AniListTrackingProps, "destinationField" | "busy"> & {
  model: ReturnType<typeof useAniListTracking>;
}) {
  const { basePathField, mode, setMode, basePath, setBasePath, unprepare } = model;
  return (
    <Step
      description="Each anime can get its own thread, or share the selected one."
      number={2}
      title="Where to download"
    >
      <div className="fields-grid">
        {destinationField}
        <Field>
          <FieldLabel htmlFor="anilist-organization">Organization</FieldLabel>
          <OptionSelect
            disabled={busy}
            id="anilist-organization"
            onValueChange={(value) => {
              unprepare();
              setMode(value);
            }}
            options={organizationOptions}
            value={mode}
          />
        </Field>
        {mode === "per-anime" && (
          <Field>
            <FieldLabel htmlFor="anilist-base-path">Root folder</FieldLabel>
            <Input
              disabled={busy}
              {...basePathField.props}
              aria-invalid={Boolean(basePathField.errors)}
              id="anilist-base-path"
              onChange={(event) => {
                setBasePath(event.target.value);
                unprepare();
              }}
              placeholder="/video"
              value={basePath}
            />
            <FieldDescription>
              /video → One Piece goes to /video/one-piece. You can rename each one in step 4.
            </FieldDescription>
          </Field>
        )}
      </div>
    </Step>
  );
}

export function TrackingPreferences({
  model,
  preferences,
  openPreferences,
}: Pick<AniListTrackingProps, "preferences" | "openPreferences"> & {
  model: ReturnType<typeof useAniListTracking>;
}) {
  const { custom, setCustom, formats } = model;
  return (
    <Step
      description="Tracked titles use your general preferences unless you customize them here."
      number={3}
      title="Download preferences"
    >
      <div className="preference-summary">
        <ul>
          {preferenceSummary(formats).map((item) => (
            <li key={item}>{item}</li>
          ))}
          <li>{formats.automatic ? "Downloads automatically" : "Asks before downloading"}</li>
        </ul>
        {openPreferences && custom === null ? (
          <button className="link-button" onClick={openPreferences} type="button">
            Edit general preferences
          </button>
        ) : null}
      </div>
      <Field orientation="horizontal">
        <Checkbox
          checked={custom !== null}
          id="anilist-customize"
          onCheckedChange={(checked) => setCustom(checked === true ? { ...preferences } : null)}
        />
        <FieldLabel htmlFor="anilist-customize">Customize for AniList tracking</FieldLabel>
      </Field>
      {custom !== null && (
        <div className="rule-fields">
          <PreferenceFields idPrefix="automation" onChange={setCustom} value={custom} />
        </div>
      )}
    </Step>
  );
}

export function TrackingStart({
  model,
  busy,
  action,
  reload,
  afterMutation,
  plugin,
  destinations,
  state,
}: Pick<
  AniListTrackingProps,
  "busy" | "action" | "reload" | "afterMutation" | "plugin" | "destinations" | "state"
> & { model: ReturnType<typeof useAniListTracking> }) {
  const {
    createSubscription,
    syncSubscription,
    trackingForm,
    statuses,
    mode,
    basePath,
    proposals,
    setProposals,
    prepared,
    setPrepared,
    unprepare,
    selectedCount,
    template,
  } = model;
  return (
    <Step
      description="Check the threads, then create the tracking. Nothing is created before this step."
      number={4}
      title="Review and create"
    >
      <div className="setup-inline">
        <Button
          disabled={busy || !statuses.length || (mode === "per-anime" && !basePath.trim())}
          onClick={() =>
            action(async () => {
              if (!(await validate(trackingForm, { shouldFocus: true })).success) {
                return;
              }
              setProposals(
                mode === "per-anime"
                  ? await request<AniListThreadProposal[]>("/anilist/threads/preview", "POST", {
                      basePath,
                      statuses,
                    })
                  : null
              );
              setPrepared(true);
            })
          }
          variant="outline"
        >
          Prepare tracking
        </Button>
        {prepared ? (
          <Button
            disabled={
              busy ||
              !statuses.length ||
              !selectedCount ||
              !plugin?.enabled ||
              !template.sources.length ||
              (mode === "per-anime" &&
                (proposals === null ||
                  proposals.length !== selectedCount ||
                  proposals.some(
                    (proposal) => !(proposal.name.trim() && proposal.downloadPath.trim())
                  )))
            }
            onClick={() =>
              action(async () => {
                if (!(await validate(trackingForm, { shouldFocus: true })).success) {
                  return;
                }
                const subscription = await createSubscription.mutateAsync({
                  enabled: true,
                  intervalMinutes: Math.max(5, template.intervalMinutes),
                  organization:
                    mode === "per-anime"
                      ? { basePath, mode, overrides: proposals ?? [] }
                      : { mode },
                  statuses,
                  template,
                });
                if (!(subscription && "id" in subscription)) {
                  return;
                }
                await syncSubscription.mutateAsync(subscription.id);
                unprepare();
                await (afterMutation ?? reload)();
              })
            }
          >
            <CheckIcon data-icon="inline-start" />
            Create AniList tracking
          </Button>
        ) : null}
      </div>
      {prepared && !selectedCount ? (
        <p className="automation-muted">Approve at least one title in step 1.</p>
      ) : null}
      {prepared && mode === "per-anime" && proposals !== null && (
        <AniListThreads
          busy={busy}
          destinations={destinations}
          entries={state.entries}
          onChange={setProposals}
          proposals={proposals}
        />
      )}
    </Step>
  );
}
