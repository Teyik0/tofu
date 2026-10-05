import { useQuery } from "@teyik0/furin/client";
import { CheckIcon, ExternalLinkIcon, RefreshCwIcon, TrashIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";
import { api } from "../client";
import type {
  AniListState,
  AniListStatus,
  AniListSubscription,
  AniListThreadProposal,
  AutomationDraft,
  AutomationRule,
  Destination,
  PluginState,
} from "../types";
import { ActionTooltip } from "./action-tooltip";
import { aniListStatusLabel } from "./anilist-status";
import { AniListThreads } from "./anilist-threads";
import { request } from "./api";
import { OptionSelect } from "./option-select";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button, buttonVariants } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

type Action = (task: () => Promise<void>) => void;
function AniListConnection({
  state,
  action,
  reload,
  busy,
}: {
  state: AniListState;
  action: Action;
  reload: () => Promise<void>;
  busy: boolean;
}) {
  const [userName, setUserName] = useState(state.userName);
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
    <section aria-label="AniList account connection" className="automation-editor">
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
              const { url } = await request<{ url: string }>("/anilist/connect", "POST", {});
              setAuthorizationUrl(url);
              await reload();
              const result = await request<{ url: string; opened: boolean }>(
                "/anilist/open",
                "POST",
                { url }
              );
              setAuthorizationUrl(result.url);
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
                await request("/anilist/connect", "DELETE", undefined);
                setAuthorizationUrl(null);
                await reload();
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
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="anilist-username">Public AniList account name</FieldLabel>
              <Input
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
            <Button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await request("/anilist", "PUT", { userName });
                  await request("/plugins/anilist", "PUT", { enabled: true });
                  await request("/anilist/list", "POST", {});
                  await reload();
                })
              }
              variant="outline"
            >
              Load public list
            </Button>
          </FieldGroup>
        </details>
      )}
    </section>
  );
}

const organizationOptions = [
  { label: "One thread per anime", value: "per-anime" },
  { label: "All anime in the selected thread", value: "shared" },
] satisfies { label: string; value: "per-anime" | "shared" }[];

export function AniListPanel({
  target,
  destinationField,
  busy,
  action,
  reloadPlugins,
  renderTemplate,
  plugin,
  destinations,
  automations,
  onRefresh,
}: {
  target: string;
  destinationField: ReactNode;
  busy: boolean;
  action: Action;
  reloadPlugins: () => Promise<void>;
  renderTemplate: (draft: AutomationDraft, onChange: (draft: AutomationDraft) => void) => ReactNode;
  plugin: PluginState | undefined;
  destinations: Destination[];
  automations: AutomationRule[];
  onRefresh?: (state: AniListState) => void;
}) {
  const { data: live } = useQuery(api.api.anilist.get);
  const [saved, setSaved] = useState<AniListState | null>(null);
  const state = saved ?? (live && "subscriptions" in live ? live : null);
  const [query, setQuery] = useState("On Nyaa, with VOSTFR, prefer 1080p then 720p.");
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const [statuses, setStatuses] = useState<AniListStatus[]>(["CURRENT", "PLANNING"]);
  const [mode, setMode] = useState<"per-anime" | "shared">("per-anime");
  const [basePath, setBasePath] = useState(
    () => destinations.find((destination) => destination.id === target)?.downloadPath ?? ""
  );
  const [proposals, setProposals] = useState<AniListThreadProposal[] | null>(null);
  const reload = async () => {
    const refreshed = await request<AniListState>("/anilist", "GET", undefined);
    setSaved(refreshed);
    onRefresh?.(refreshed);
    await reloadPlugins();
  };
  if (!state) {
    return <p>Loading AniList connection…</p>;
  }
  const selectedCount = state.entries.filter(
    (entry) =>
      statuses.includes(entry.status) &&
      state.selections.some((selection) => selection.mediaId === entry.mediaId && selection.enabled)
  ).length;
  return (
    <>
      <div className="automation-section-heading">
        <span className="automation-caption">ANILIST · WATCHING & PLAN TO WATCH</span>
        <Button disabled={busy} onClick={() => action(reload)} size="sm" variant="ghost">
          <RefreshCwIcon data-icon="inline-start" />
          Refresh
        </Button>
      </div>
      <AniListConnection action={action} busy={busy} reload={reload} state={state} />
      {!plugin?.enabled && (
        <Alert>
          <AlertDescription>
            Enable the AniList plugin to read your lists and sync tracking. The OAuth connection
            enables it after authorization.
          </AlertDescription>
        </Alert>
      )}
      <div className="automation-form-actions">
        <Button
          disabled={busy || !plugin?.enabled}
          onClick={() =>
            action(async () => {
              setSaved(await request<AniListState>("/anilist/list", "POST", {}));
              setProposals(null);
            })
          }
          variant="outline"
        >
          Load Watching and Plan to Watch
        </Button>
      </div>
      {state.entries.length > 0 && (
        <div className="automation-preview">
          <div className="automation-row-heading">
            <strong>Choose anime to download</strong>
            <Badge variant="outline">
              {state.selections.filter((selection) => selection.enabled).length} approved
            </Badge>
          </div>
          <p className="automation-caption">
            Your choices stay in Tofu. Your AniList list remains unchanged. Each new title waits for
            your approval.
          </p>
          {state.entries.map((entry) => (
            <div className="automation-history-item" key={entry.mediaId}>
              <Field orientation="horizontal">
                <Checkbox
                  checked={state.selections.some(
                    (selection) => selection.mediaId === entry.mediaId && selection.enabled
                  )}
                  disabled={busy}
                  id={`anilist-title-${entry.mediaId}`}
                  onCheckedChange={(checked) =>
                    action(async () => {
                      setProposals(null);
                      setSaved(
                        await request<AniListState>(`/anilist/entries/${entry.mediaId}`, "PUT", {
                          enabled: checked === true,
                        })
                      );
                      await reloadPlugins();
                    })
                  }
                />
                <FieldLabel htmlFor={`anilist-title-${entry.mediaId}`}>{entry.title}</FieldLabel>
              </Field>
              <div className="feed-release-meta">
                <Badge variant="outline">{aniListStatusLabel(entry.status)}</Badge>
                <span>{entry.progress} episodes watched</span>
              </div>
            </div>
          ))}
        </div>
      )}
      <section className="automation-editor">
        <strong>Automatically follow these lists</strong>
        {destinationField}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="anilist-organization">Thread organization</FieldLabel>
            <OptionSelect
              disabled={busy}
              id="anilist-organization"
              onValueChange={setMode}
              options={organizationOptions}
              value={mode}
            />
            <FieldDescription>
              Each approved anime has an automation linked to AniList.
            </FieldDescription>
          </Field>
          {mode === "per-anime" && (
            <Field>
              <FieldLabel htmlFor="anilist-base-path">Root folder</FieldLabel>
              <Input
                disabled={busy}
                id="anilist-base-path"
                onChange={(event) => {
                  setBasePath(event.target.value);
                  setProposals(null);
                }}
                placeholder="/video"
                value={basePath}
              />
              <FieldDescription>
                Example: /video → One Piece in /video/one-piece. You can edit each proposal.
              </FieldDescription>
            </Field>
          )}
        </FieldGroup>
        <Field>
          <FieldLabel htmlFor="anilist-preferences">Your preferences for list titles</FieldLabel>
          <Textarea
            id="anilist-preferences"
            onChange={(event) => {
              setQuery(event.target.value);
              setDraft(null);
            }}
            rows={2}
            value={query}
          />
          <FieldDescription>
            Names and aliases come from AniList. Watched episodes are excluded. Tracking creates one
            rule per approved title in the thread selected for that anime.
          </FieldDescription>
        </Field>
        <div className="automation-checks">
          {(["CURRENT", "PLANNING"] as const).map((status) => (
            <Field key={status} orientation="horizontal">
              <Checkbox
                checked={statuses.includes(status)}
                id={`anilist-${status}`}
                onCheckedChange={(checked) => {
                  setProposals(null);
                  setStatuses(
                    checked === true
                      ? [...statuses, status]
                      : statuses.filter((value) => value !== status)
                  );
                }}
              />
              <FieldLabel htmlFor={`anilist-${status}`}>
                {status === "CURRENT" ? "Watching" : "Plan to Watch"}
              </FieldLabel>
            </Field>
          ))}
        </div>
        <div className="automation-form-actions">
          <Button
            disabled={
              busy ||
              !query.trim() ||
              !statuses.length ||
              (mode === "per-anime" && !basePath.trim())
            }
            onClick={() =>
              action(async () => {
                const [value, threads] = await Promise.all([
                  request<AutomationDraft>("/automations/interpret", "POST", {
                    destinationId: target,
                    query,
                  }),
                  mode === "per-anime"
                    ? request<AniListThreadProposal[]>("/anilist/threads/preview", "POST", {
                        basePath,
                        statuses,
                      })
                    : Promise.resolve(null),
                ]);
                setProposals(threads);
                setDraft({
                  ...value,
                  includeExisting: true,
                  title: "Titles from my AniList lists",
                });
              })
            }
            variant="outline"
          >
            Prepare tracking
          </Button>
        </div>
        {draft !== null && (
          <>
            {mode === "per-anime" && proposals !== null && (
              <AniListThreads
                busy={busy}
                destinations={destinations}
                entries={state.entries}
                onChange={setProposals}
                proposals={proposals}
              />
            )}
            {renderTemplate({ ...draft, destinationId: target }, setDraft)}
            <FieldDescription>
              The Name field is replaced with each AniList title. A title removed from the tracked
              lists is paused; existing downloads are preserved.
            </FieldDescription>
            <div className="automation-form-actions">
              <Button
                disabled={
                  busy ||
                  !statuses.length ||
                  !selectedCount ||
                  !plugin?.enabled ||
                  !draft.sources.length ||
                  (mode === "per-anime" &&
                    (proposals === null ||
                      proposals.length !== selectedCount ||
                      proposals.some(
                        (proposal) => !(proposal.name.trim() && proposal.downloadPath.trim())
                      )))
                }
                onClick={() =>
                  action(async () => {
                    const subscription = await request<AniListSubscription>(
                      "/anilist/subscriptions",
                      "POST",
                      {
                        enabled: true,
                        intervalMinutes: Math.max(5, draft.intervalMinutes),
                        organization:
                          mode === "per-anime"
                            ? { basePath, mode, overrides: proposals ?? [] }
                            : { mode },
                        statuses,
                        template: { ...draft, destinationId: target },
                      }
                    );
                    await request(`/anilist/subscriptions/${subscription.id}/sync`, "POST", {});
                    setDraft(null);
                    await reload();
                  })
                }
              >
                <CheckIcon data-icon="inline-start" />
                Create AniList tracking
              </Button>
            </div>
          </>
        )}
      </section>
      {state.subscriptions
        .filter((subscription) => subscription.template.destinationId === target)
        .map((subscription) => (
          <article className="automation-rule" key={subscription.id}>
            <div className="automation-row-heading">
              <strong>{subscription.statuses.map(aniListStatusLabel).join(" + ")}</strong>
              <Badge variant="outline">
                {subscription.enabled
                  ? `${subscription.bindings.filter((binding) => binding.active).length} tracked titles`
                  : "Paused"}
              </Badge>
            </div>
            <p>{subscription.template.query}</p>
            <p className="automation-caption">
              {subscription.organization?.mode === "per-anime"
                ? `One thread per anime · ${subscription.organization.basePath}`
                : "All anime in this thread"}
            </p>
            {subscription.bindings.map((binding) => {
              const rule = automations.find((item) => item.id === binding.ruleId);
              const destination = destinations.find((item) => item.id === rule?.destinationId);
              return (
                <div className="feed-release-meta" key={binding.mediaId}>
                  <a
                    href={`https://anilist.co/anime/${binding.mediaId}`}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {rule?.title ?? `Anime ${binding.mediaId}`} ↗
                  </a>
                  <span>
                    → {destination?.name ?? "—"} · {destination?.downloadPath ?? "—"}
                  </span>
                </div>
              );
            })}
            <span className="automation-caption">
              Sync every {subscription.intervalMinutes} min ·{" "}
              {subscription.lastSyncAt === null
                ? "Never synced"
                : new Date(subscription.lastSyncAt).toLocaleString("en-US")}
            </span>
            {subscription.error !== null && (
              <Alert>
                <AlertDescription>{subscription.error}</AlertDescription>
              </Alert>
            )}
            <div className="automation-rule-actions">
              <Button
                disabled={busy || !plugin?.enabled || !subscription.enabled}
                onClick={() =>
                  action(async () => {
                    await request(`/anilist/subscriptions/${subscription.id}/sync`, "POST", {});
                    await reload();
                  })
                }
                size="sm"
                variant="outline"
              >
                Sync
              </Button>
              <Button
                disabled={busy}
                onClick={() =>
                  action(async () => {
                    await request(`/anilist/subscriptions/${subscription.id}`, "PUT", {
                      enabled: !subscription.enabled,
                    });
                    await reload();
                  })
                }
                size="sm"
                variant="ghost"
              >
                {subscription.enabled ? "Pause" : "Enable"}
              </Button>
              <ActionTooltip>
                <Button
                  aria-label="Remove AniList tracking"
                  disabled={busy}
                  onClick={() =>
                    action(async () => {
                      await request(
                        `/anilist/subscriptions/${subscription.id}`,
                        "DELETE",
                        undefined
                      );
                      await reload();
                    })
                  }
                  size="icon-sm"
                  variant="ghost"
                >
                  <TrashIcon />
                </Button>
              </ActionTooltip>
            </div>
          </article>
        ))}
    </>
  );
}
