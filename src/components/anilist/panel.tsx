import { Form, getDeepError, useField, useForm } from "@formisch/react";
import { useMutation, useQuery } from "@teyik0/furin/client";
import { useAtomValue } from "jotai";
import { ExternalLinkIcon, PauseIcon, PlayIcon, RefreshCwIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { pick } from "valibot";
import { aniListConfigurationSchema } from "../../api/modules/anilist/model";
import { useAuthorizationPolling } from "../../hooks/use-authorization-polling";
import { api } from "../../lib/client";
import { sessionAtom } from "../../state/workspace";
import type {
  AniListState,
  AutomationPreferences,
  AutomationRule,
  Destination,
  PluginState,
} from "../../types";
import { ActionTooltip } from "../action-tooltip";
import { request } from "../api";
import { relative } from "../format";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button, buttonVariants } from "../ui/button";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { aniListStatusLabel } from "./status";
import {
  TrackingDestination,
  TrackingPreferences,
  TrackingStart,
  TrackingTitles,
} from "./tracking-steps";
import { useAniListTracking } from "./use-tracking";

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
  const session = useAtomValue(sessionAtom);
  const canAuthorize =
    session?.capabilities.hostNative === true || session?.caller.deviceKind === "desktop";
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
  const pollError = useAuthorizationPolling(state.authorizationPending, reload);
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
        {canAuthorize
          ? "Sign in to AniList in your browser and authorize Tofu. Your account and lists will connect automatically."
          : "Connect AniList from this server's own Tofu desktop window or a paired Tofu desktop app. In this browser, you can use an existing connection or follow a public account name."}
      </p>
      <div className="automation-form-actions">
        <Button
          disabled={busy || state.authorizationPending || !canAuthorize}
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
              if (session?.capabilities.hostNative) {
                const result = await openAuthorization.mutateAsync({ url });
                if (result && "url" in result) {
                  setAuthorizationUrl(result.url);
                }
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

export interface AniListPanelProps {
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
  const model = useAniListTracking({ destinations, plugin, preferences, state, target });
  const {
    syncSubscription,
    toggleSubscription,
    removeSubscription,
    trackingError,
    now,
    subscriptions,
  } = model;
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
      {Boolean(trackingError) && (
        <Alert variant="destructive">
          <AlertDescription>{trackingError}</AlertDescription>
        </Alert>
      )}
      <ol className="setup-steps">
        <TrackingTitles
          action={action}
          afterMutation={afterMutation}
          busy={busy}
          model={model}
          reload={reload}
          state={state}
        />
        <TrackingDestination busy={busy} destinationField={destinationField} model={model} />
        <TrackingPreferences
          model={model}
          openPreferences={openPreferences}
          preferences={preferences}
        />
        <TrackingStart
          action={action}
          afterMutation={afterMutation}
          busy={busy}
          destinations={destinations}
          model={model}
          plugin={plugin}
          reload={reload}
          state={state}
        />
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
  const { data: live } = useQuery(api.anilist.get.live());
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
