import { Form, getDeepError, useField, useForm, validate } from "@formisch/react";
import { useMutation, useQuery } from "@teyik0/furin/client";
import {
  CheckIcon,
  ExternalLinkIcon,
  PauseIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";
import { pick } from "valibot";
import { aniListConfigurationSchema, trackingFormSchema } from "../../api/modules/anilist/model";
import { api } from "../../lib/client";
import type {
  AniListState,
  AniListStatus,
  AniListThreadProposal,
  AutomationDraft,
  AutomationPreferences,
  AutomationRule,
  Destination,
  PluginState,
} from "../../types";
import { ActionTooltip } from "../action-tooltip";
import { request } from "../api";
import { PreferenceFields, preferenceSummary } from "../automation-fields";
import { useNow } from "../automation-inbox";
import { relative } from "../format";
import { OptionSelect } from "../option-select";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button, buttonVariants } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { AniListCover } from "./cover";
import { aniListStatusLabel } from "./status";
import { AniListThreads } from "./threads";

type Action = (task: () => Promise<void>) => void;
function AniListConnection({
  state,
  action,
  reload,
  busy,
  afterMutation,
}: {
  state: AniListState;
  action: Action;
  reload: () => Promise<void>;
  busy: boolean;
  afterMutation?: () => Promise<void>;
}) {
  const connect = useMutation(api.anilist.connect.post);
  const openAuthorization = useMutation(api.anilist.open.post);
  const cancelAuthorization = useMutation(api.anilist.connect.delete);
  const configure = useMutation(api.anilist.put);
  const enablePlugin = useMutation(api.plugins({ id: "anilist" }).put);
  const loadList = useMutation(api.anilist.list.post);
  const accountForm = useForm({
    initialInput: { userName: state.userName },
    schema: pick(aniListConfigurationSchema, ["userName"]),
  });
  const userNameField = useField(accountForm, { path: ["userName"] });
  const userName = userNameField.input ?? "";
  const setUserName = userNameField.onChange;
  const accountError = getDeepError(accountForm);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const poll = useEffectEvent(async () => {
    try {
      await reload();
      setPollError(null);
    } catch {
      setPollError("Unable to check the connection. Return to Tofu and try again.");
    }
  });
  useEffect(() => {
    if (!state.authorizationPending) {
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const check = async () => {
      await poll();
      if (active) {
        timer = setTimeout(check, 1000);
      }
    };
    timer = setTimeout(check, 1000);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [state.authorizationPending]);
  return (
    <section aria-label="AniList account connection" className="anilist-account-card">
      <div className="automation-row-heading">
        <strong>Your AniList account</strong>
        <Badge variant="outline">
          {state.authorizationPending
            ? "Waiting for authorization"
            : (state.connectedUser ?? (state.authenticated ? "Connected" : "Not connected"))}
        </Badge>
      </div>
      <p className="automation-caption">
        Sign in to AniList in your browser and authorize Tofu. Your account and lists will connect
        automatically.
      </p>
      <div className="automation-form-actions">
        <Button
          disabled={busy || state.authorizationPending}
          onClick={() =>
            action(async () => {
              setAuthorizationUrl(null);
              const authorization = await connect.mutateAsync();
              if (!(authorization && "url" in authorization)) {
                return;
              }
              const { url } = authorization;
              setAuthorizationUrl(url);
              await (afterMutation ?? reload)();
              const result = await openAuthorization.mutateAsync({ url });
              if (result && "url" in result) {
                setAuthorizationUrl(result.url);
              }
            })
          }
        >
          <ExternalLinkIcon data-icon="inline-start" />
          {state.authenticated ? "Reconnect AniList" : "Connect AniList"}
        </Button>
        {authorizationUrl !== null && state.authorizationPending && (
          <a
            className={buttonVariants({ variant: "outline" })}
            href={authorizationUrl}
            rel="noopener noreferrer"
            target="_blank"
          >
            Authorize in browser
          </a>
        )}
        {state.authorizationPending ? (
          <Button
            disabled={busy}
            onClick={() =>
              action(async () => {
                await cancelAuthorization.mutateAsync();
                setAuthorizationUrl(null);
                await (afterMutation ?? reload)();
              })
            }
            variant="outline"
          >
            Cancel connection
          </Button>
        ) : null}
      </div>
      {state.authorizationPending ? (
        <p aria-live="polite" className="automation-caption">
          Waiting for AniList authorization in your browser…
        </p>
      ) : null}
      {state.authorizationError || pollError ? (
        <Alert>
          <AlertDescription>{state.authorizationError ?? pollError}</AlertDescription>
        </Alert>
      ) : null}
      {state.authenticated ? null : (
        <details>
          <summary>Use a public account name instead</summary>
          <Form
            of={accountForm}
            onSubmit={(configuration) =>
              action(async () => {
                await configure.mutateAsync(configuration);
                await enablePlugin.mutateAsync({ enabled: true });
                await loadList.mutateAsync();
                await (afterMutation ?? reload)();
              })
            }
          >
            <FieldGroup>
              <Field data-invalid={Boolean(userNameField.errors)}>
                <FieldLabel htmlFor="anilist-username">Public AniList account name</FieldLabel>
                <Input
                  {...userNameField.props}
                  aria-invalid={Boolean(userNameField.errors)}
                  id="anilist-username"
                  onChange={(event) => setUserName(event.target.value)}
                  placeholder="Your AniList username"
                  value={userName}
                />
                <FieldDescription>
                  Read a public list without connecting. Updating watched episodes requires account
                  authorization.
                </FieldDescription>
              </Field>
              <Button disabled={busy} type="submit" variant="outline">
                Load public list
              </Button>
            </FieldGroup>
            {accountError && (
              <Alert variant="destructive">
                <AlertDescription>{accountError}</AlertDescription>
              </Alert>
            )}
          </Form>
        </details>
      )}
    </section>
  );
}

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

interface AniListPanelProps {
  action: Action;
  afterMutation?: () => Promise<void>;
  automations: AutomationRule[];
  busy: boolean;
  destinationField?: ReactNode;
  destinations: Destination[];
  openPreferences?: () => void;
  plugin: PluginState | undefined;
  preferences: AutomationPreferences;
  reload: () => Promise<void>;
  state: AniListState;
  target: string;
}

export const AniListPanel = ({
  target,
  destinationField,
  busy,
  action,
  reload,
  afterMutation,
  preferences,
  openPreferences,
  plugin,
  destinations,
  automations,
  state,
}: AniListPanelProps) => {
  const selectEntry = useMutation((mediaId: number, enabled: boolean) =>
    api.anilist.entries({ mediaId }).put({ enabled })
  );
  const createSubscription = useMutation(api.anilist.subscriptions.post);
  const loadList = useMutation(api.anilist.list.post);
  const syncSubscription = useMutation((id: string) =>
    api.anilist.subscriptions({ id }).sync.post()
  );
  const toggleSubscription = useMutation((id: string, enabled: boolean) =>
    api.anilist.subscriptions({ id }).put({ enabled })
  );
  const removeSubscription = useMutation((id: string) =>
    api.anilist.subscriptions({ id }).delete()
  );
  const trackingForm = useForm({
    initialInput: {
      basePath: destinations.find((destination) => destination.id === target)?.downloadPath ?? "",
      custom: null,
      mode: "per-anime",
      proposals: null,
      statuses: ["CURRENT", "PLANNING"],
    },
    schema: trackingFormSchema,
  });
  const statusesField = useField(trackingForm, { path: ["statuses"] });
  const modeField = useField(trackingForm, { path: ["mode"] });
  const basePathField = useField(trackingForm, { path: ["basePath"] });
  const customField = useField(trackingForm, { path: ["custom"] });
  const proposalsField = useField(trackingForm, { path: ["proposals"] });
  const statuses = (statusesField.input ?? []).filter(
    (status): status is AniListStatus => status !== undefined
  );
  const setStatuses = statusesField.onChange;
  const mode = modeField.input ?? "per-anime";
  const setMode = modeField.onChange;
  const basePath = basePathField.input ?? "";
  const setBasePath = basePathField.onChange;
  // Both editors always write complete API-shaped values into these fields.
  const custom = customField.input as AutomationPreferences | null;
  const setCustom = customField.onChange;
  const proposals = proposalsField.input as AniListThreadProposal[] | null;
  const setProposals = proposalsField.onChange;
  const [prepared, setPrepared] = useState(false);
  const trackingError = getDeepError(trackingForm);
  const now = useNow(60_000);
  const pluginEnabled = plugin?.enabled === true;
  const unprepare = () => {
    setPrepared(false);
    setProposals(null);
  };
  const visible = state.entries.filter((entry) => statuses.includes(entry.status));
  const approved = (mediaId: number) =>
    state.selections.some((selection) => selection.mediaId === mediaId && selection.enabled);
  const selectedCount = visible.filter((entry) => approved(entry.mediaId)).length;
  const formats = custom ?? preferences;
  const template: AutomationDraft = {
    ...formats,
    destinationId: target,
    enabled: true,
    includeExisting: true,
    matchMode: "exact",
    query: `AniList: ${statuses.map(aniListStatusLabel).join(" + ") || "lists"}`,
    season: null,
    title: "Titles from my AniList lists",
  };
  const subscriptions = state.subscriptions.filter(
    (subscription) => subscription.template.destinationId === target
  );
  return (
    <div className="automation-section anilist-setup">
      <div className="automation-section-title">
        <div>
          <h3>AniList tracking</h3>
          <p>
            Follow the anime on your AniList lists. Tofu creates one rule per approved title and
            skips episodes you have already watched.
          </p>
        </div>
        <Button disabled={busy} onClick={() => action(reload)} size="sm" variant="ghost">
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </div>
      <AniListConnection
        action={action}
        afterMutation={afterMutation}
        busy={busy}
        reload={reload}
        state={state}
      />
      {!plugin?.enabled && (
        <Alert>
          <AlertDescription>
            Enable the AniList plugin to read your lists. Connecting your account enables it
            automatically.
          </AlertDescription>
        </Alert>
      )}
      {trackingError && (
        <Alert variant="destructive">
          <AlertDescription>{trackingError}</AlertDescription>
        </Alert>
      )}
      <ol className="setup-steps">
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
                {selectedCount} of {visible.length} titles approved. New titles on your lists wait
                for your approval here.
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
                          {aniListStatusLabel(entry.status)} · {entry.progress}/
                          {entry.episodes ?? "?"} watched
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
      </ol>
      <div className="automation-list-heading">
        <h3>
          Active tracking <span>{subscriptions.length}</span>
        </h3>
      </div>
      {subscriptions.length === 0 ? (
        <p className="automation-muted">No AniList tracking starts from this thread yet.</p>
      ) : null}
      {subscriptions.map((subscription) => (
        <article className="rule-card" key={subscription.id}>
          <div className="rule-card-heading">
            <span aria-hidden="true" className="rule-card-dot" data-on={subscription.enabled} />
            <div className="rule-card-title">
              <strong>{subscription.statuses.map(aniListStatusLabel).join(" + ")}</strong>
              <p>
                {subscription.organization?.mode === "per-anime"
                  ? `One thread per anime in ${subscription.organization.basePath}`
                  : "All anime in this thread"}
              </p>
            </div>
            <Badge variant="outline">
              {subscription.enabled
                ? `${subscription.bindings.filter((binding) => binding.active).length} titles`
                : "Paused"}
            </Badge>
          </div>
          <ul className="binding-list">
            {subscription.bindings.map((binding) => {
              const rule = automations.find((item) => item.id === binding.ruleId);
              const destination = destinations.find((item) => item.id === rule?.destinationId);
              return (
                <li data-active={binding.active} key={binding.mediaId}>
                  <a
                    href={`https://anilist.co/anime/${binding.mediaId}`}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {rule?.title ?? `Anime ${binding.mediaId}`}
                  </a>
                  <span title={destination?.downloadPath}>→ {destination?.name ?? "—"}</span>
                </li>
              );
            })}
          </ul>
          {subscription.error !== null && (
            <Alert>
              <AlertDescription>{subscription.error}</AlertDescription>
            </Alert>
          )}
          <footer className="rule-card-footer">
            <span>
              {subscription.lastSyncAt === null
                ? "Never synced"
                : `Synced ${relative(subscription.lastSyncAt, now)}`}{" "}
              · every {subscription.intervalMinutes} min
            </span>
            <div className="rule-card-actions">
              <Button
                disabled={busy || !plugin?.enabled || !subscription.enabled}
                onClick={() =>
                  action(async () => {
                    await syncSubscription.mutateAsync(subscription.id);
                    await (afterMutation ?? reload)();
                  })
                }
                size="sm"
                variant="outline"
              >
                <RefreshCwIcon data-icon="inline-start" />
                Sync now
              </Button>
              <ActionTooltip>
                <Button
                  aria-label={
                    subscription.enabled ? "Pause AniList tracking" : "Resume AniList tracking"
                  }
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await toggleSubscription.mutateAsync(subscription.id, !subscription.enabled);
                      await (afterMutation ?? reload)();
                    })
                  }
                  size="icon-sm"
                  variant="ghost"
                >
                  {subscription.enabled ? <PauseIcon /> : <PlayIcon />}
                </Button>
              </ActionTooltip>
              <ActionTooltip>
                <Button
                  aria-label="Remove AniList tracking"
                  className="danger-text"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await removeSubscription.mutateAsync(subscription.id);
                      await (afterMutation ?? reload)();
                    })
                  }
                  size="icon-sm"
                  variant="ghost"
                >
                  <Trash2Icon />
                </Button>
              </ActionTooltip>
            </div>
          </footer>
        </article>
      ))}
    </div>
  );
};

type QueriedAniListPanelProps = Omit<AniListPanelProps, "state" | "reload" | "afterMutation"> & {
  reloadPlugins: () => Promise<void>;
};

// The automation modal can open on routes whose loaders do not include AniList.
export const QueriedAniListPanel = ({ reloadPlugins, ...props }: QueriedAniListPanelProps) => {
  const { data: live } = useQuery(api.anilist.get);
  const [refreshed, setRefreshed] = useState<{
    source: typeof live;
    state: AniListState;
  } | null>(null);
  const state =
    refreshed && refreshed.source === live
      ? refreshed.state
      : live && "subscriptions" in live
        ? live
        : null;
  const reload = async () => {
    const next = await request<AniListState>("/anilist", "GET", undefined);
    setRefreshed({ source: live, state: next });
    await reloadPlugins();
  };
  if (!state) {
    return <p className="automation-muted">Loading AniList connection…</p>;
  }
  return <AniListPanel {...props} afterMutation={reload} reload={reload} state={state} />;
};
