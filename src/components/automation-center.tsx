import { useMutation, useQuery } from "@teyik0/furin/client";
import {
  CheckIcon,
  HistoryIcon,
  InboxIcon,
  ListChecksIcon,
  LoaderCircleIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { createAutomationMutations } from "../lib/automation-mutations";
import { api } from "../lib/client";
import { useRefresh } from "../lib/navigation";
import type {
  AutomationDecision,
  AutomationDraft,
  AutomationRule,
  DashboardState,
  DiscoveryResult,
  FeedRelease,
  PluginState,
  SourcePluginId,
} from "../types";
import { ActionTooltip } from "./action-tooltip";
import { AniListIcon } from "./anilist-icon";
import { QueriedAniListPanel } from "./anilist-panel";
import { request } from "./api";
import { RuleFields, sourceNames } from "./automation-fields";
import { AutomationInbox, isPending, ReleaseLine, useNow } from "./automation-inbox";
import { relative } from "./format";
import { GeneralPreferences } from "./general-preferences";
import { OptionSelect } from "./option-select";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Field, FieldLabel } from "./ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import { Skeleton } from "./ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { Textarea } from "./ui/textarea";

export type AutomationSection =
  | "inbox"
  | "rules"
  | "anilist"
  | "discover"
  | "history"
  | "preferences";
const mutations = createAutomationMutations(api);
const ruleStatuses: Record<AutomationRule["status"], string> = {
  active: "Active",
  error: "Needs attention",
  paused: "Paused",
  running: "Checking…",
  "source-disabled": "Plugin disabled",
};
const decisionStatuses: Record<AutomationDecision["status"], string> = {
  added: "Added",
  adding: "Adding",
  error: "Could not be added",
  ignored: "Skipped",
  review: "Needs confirmation",
  waiting: "Waiting for a better version",
};
type Action = (task: () => Promise<void>) => void;
type Preview = DiscoveryResult & {
  candidates: {
    release: FeedRelease;
    reason: string | null;
    probability: number | null;
    uncertain: boolean;
  }[];
};

function QuietEmpty({
  title,
  description,
  icon,
}: {
  title: string;
  description: string;
  icon: typeof ZapIcon;
}) {
  const Glyph = icon;
  return (
    <Empty className="automation-empty">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Glyph />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

function SectionHeading({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="automation-section-title">
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {children}
    </div>
  );
}

function ruleDraft(rule: AutomationRule): AutomationDraft {
  return {
    afterEpisode: rule.afterEpisode,
    aliases: rule.aliases,
    automatic: rule.automatic,
    codecs: rule.codecs,
    deleteReplacedFiles: rule.deleteReplacedFiles,
    destinationId: rule.destinationId,
    enabled: rule.enabled,
    excludePacks: rule.excludePacks,
    includeExisting: rule.includeExisting,
    intervalMinutes: rule.intervalMinutes,
    languages: rule.languages,
    matchMode: rule.matchMode,
    paused: rule.paused,
    priority: rule.priority,
    query: rule.query,
    resolutions: rule.resolutions,
    season: rule.season,
    sources: rule.sources,
    title: rule.title,
    waitMinutes: rule.waitMinutes,
  };
}

function RuleCard({
  rule,
  pending,
  busy,
  now,
  run,
  edit,
  toggle,
  remove,
  openInbox,
}: {
  rule: AutomationRule;
  pending: number;
  busy: boolean;
  now: number;
  run: () => void;
  edit: () => void;
  toggle: () => void;
  remove: () => void;
  openInbox: () => void;
}) {
  return (
    <article className="rule-card" data-rule-status={rule.status}>
      <div className="rule-card-heading">
        <span aria-hidden="true" className="rule-card-dot" />
        <div className="rule-card-title">
          <strong title={rule.title}>{rule.title}</strong>
          {rule.query && rule.query !== rule.title ? <p>{rule.query}</p> : null}
        </div>
        <Badge variant="outline">{ruleStatuses[rule.status]}</Badge>
      </div>
      <ul className="rule-card-summary">
        <li>{rule.languages.join(" → ") || "Any language"}</li>
        <li>{rule.resolutions.join(" → ") || "Any resolution"}</li>
        <li>{rule.sources.map((id) => sourceNames[id]).join(" → ")}</li>
        {rule.season === null ? null : <li>Season {rule.season}</li>}
        <li>{rule.automatic ? "Downloads automatically" : "Asks before downloading"}</li>
        {rule.waitMinutes > 0 ? <li>Waits {rule.waitMinutes} min for better</li> : null}
      </ul>
      {pending > 0 ? (
        <button className="rule-card-pending" onClick={openInbox} type="button">
          <InboxIcon aria-hidden="true" />
          {pending} release{pending > 1 ? "s" : ""} waiting in the Inbox
        </button>
      ) : null}
      {rule.error !== null && (
        <Alert>
          <AlertDescription>{rule.error}</AlertDescription>
        </Alert>
      )}
      <footer className="rule-card-footer">
        <span>
          {rule.lastRunAt ? `Checked ${relative(rule.lastRunAt, now)}` : "Not checked yet"}
          {rule.enabled && rule.nextRunAt
            ? ` · next ${relative(Math.max(rule.nextRunAt, now), now)}`
            : ""}
        </span>
        <div className="rule-card-actions">
          <Button disabled={busy || !rule.enabled} onClick={run} size="sm" variant="outline">
            <RefreshCwIcon data-icon="inline-start" />
            Check now
          </Button>
          <ActionTooltip>
            <Button aria-label={`Edit ${rule.title}`} onClick={edit} size="icon-sm" variant="ghost">
              <PencilIcon />
            </Button>
          </ActionTooltip>
          <ActionTooltip>
            <Button
              aria-label={`${rule.enabled ? "Pause" : "Resume"} ${rule.title}`}
              disabled={busy}
              onClick={toggle}
              size="icon-sm"
              variant="ghost"
            >
              {rule.enabled ? <PauseIcon /> : <PlayIcon />}
            </Button>
          </ActionTooltip>
          <ActionTooltip>
            <Button
              aria-label={`Delete the automation ${rule.title}`}
              className="danger-text"
              disabled={busy}
              onClick={remove}
              size="icon-sm"
              variant="ghost"
            >
              <Trash2Icon />
            </Button>
          </ActionTooltip>
        </div>
      </footer>
    </article>
  );
}

export function AutomationCenter({
  dashboard,
  destinationId,
  section,
  close,
}: {
  dashboard: DashboardState;
  destinationId: string;
  section: AutomationSection;
  close: () => void;
}) {
  const refresh = useRefresh();
  const { data: live, error: loadingError } = useQuery(api.automation.get);
  const createRule = useMutation(mutations.createRule);
  const updateRule = useMutation(mutations.updateRule);
  const deleteRule = useMutation(mutations.deleteRule);
  const ignoreDecision = useMutation(mutations.ignoreDecision);
  const runRule = useMutation((id: string) => api.automations({ id }).run.post());
  const approveDecision = useMutation((id: string) =>
    api["automation-decisions"]({ id }).approve.post()
  );
  const addRelease = useMutation(api.discover.add.post);
  const state = live && "plugins" in live ? live : null;
  const [tab, setTab] = useState<AutomationSection>(section);
  const [target, setTarget] = useState(destinationId);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<AutomationDraft | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryResult | null>(null);
  const [search, setSearch] = useState("");
  const [excludedSources, setExcludedSources] = useState<SourcePluginId[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);
  const reload = async () => {
    const { error: failure } = await api.automation.get();
    if (failure) {
      throw new Error("Unable to load automations");
    }
  };
  const action: Action = (task) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    void task()
      .catch((cause) => setError(cause instanceof Error ? cause.message : "An error occurred"))
      .finally(() => setBusy(false));
  };
  const destination = dashboard.destinations.find((item) => item.id === target);
  const activeSources =
    state?.plugins.filter(
      (plugin): plugin is PluginState & { id: SourcePluginId } =>
        plugin.enabled && (plugin.id === "nyaa" || plugin.id === "tsundere" || plugin.id === "c411")
    ) ?? [];
  const selectedSources = activeSources.filter((plugin) => !excludedSources.includes(plugin.id));
  const jev = state?.plugins.find((plugin) => plugin.id === "jev");
  const naturalSearch = jev?.enabled === true && jev.hasApiKey;
  const rules = state?.automations.filter((rule) => rule.destinationId === target) ?? [];
  const pending = state?.decisions.filter(isPending) ?? [];
  const history =
    state?.decisions.filter(
      (decision) => !isPending(decision) && rules.some((rule) => rule.id === decision.automationId)
    ) ?? [];
  const reset = () => {
    setDraft(null);
    setEditId(null);
    setQuery("");
    setPreview(null);
  };
  const changeTarget = (value: string) => {
    setTarget(value);
    reset();
    setDiscovery(null);
  };
  const interpret = (event: FormEvent) => {
    event.preventDefault();
    action(async () => {
      setDraft(
        await request<AutomationDraft>("/automations/interpret", "POST", {
          destinationId: target,
          query,
        })
      );
      setPreview(null);
    });
  };
  const save = () =>
    action(async () => {
      if (!draft) {
        return;
      }
      const body = { ...draft, destinationId: target };
      const rule = editId
        ? await updateRule.mutateAsync(editId, body)
        : await createRule.mutateAsync(body);
      if (!(rule && "id" in rule)) {
        return;
      }
      reset();
      if (rule.enabled) {
        await runRule.mutateAsync(rule.id);
        await reload();
        await refresh();
      }
      setNotice(editId ? "Rule saved." : "Automation created and checked once.");
    });
  const decide = (decision: AutomationDecision, verdict: "approve" | "ignore") =>
    action(async () => {
      if (verdict === "ignore") {
        await ignoreDecision.mutateAsync(decision.id);
      } else {
        await approveDecision.mutateAsync(decision.id);
        await reload();
        await refresh();
      }
    });
  const showThread = tab !== "inbox" && tab !== "preferences";
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
    >
      <DialogContent className="automation-dialog">
        <Tabs
          className="automation-layout"
          onValueChange={(value) => setTab(value as AutomationSection)}
          orientation="vertical"
          value={tab}
        >
          <aside className="automation-nav">
            <DialogHeader className="automation-brand">
              <DialogTitle>
                <ZapIcon aria-hidden="true" />
                Automations
              </DialogTitle>
              <DialogDescription>
                Tofu watches your sources and downloads new releases into your threads.
              </DialogDescription>
            </DialogHeader>
            <TabsList aria-label="Automation sections" variant="line">
              <TabsTrigger value="inbox">
                <InboxIcon />
                Inbox
                {pending.length ? <Badge>{pending.length}</Badge> : null}
              </TabsTrigger>
              <TabsTrigger value="rules">
                <ListChecksIcon />
                Rules
              </TabsTrigger>
              <TabsTrigger value="anilist">
                <AniListIcon />
                AniList tracking
              </TabsTrigger>
              <TabsTrigger value="discover">
                <SearchIcon />
                Discover
              </TabsTrigger>
              <TabsTrigger value="history">
                <HistoryIcon />
                History
              </TabsTrigger>
              <TabsTrigger value="preferences">
                <SlidersHorizontalIcon />
                Preferences
              </TabsTrigger>
            </TabsList>
          </aside>
          <div className="automation-main">
            {showThread ? (
              <div className="automation-thread">
                <Field className="automation-target" orientation="horizontal">
                  <FieldLabel htmlFor="automation-destination">Thread</FieldLabel>
                  <OptionSelect
                    disabled={busy}
                    id="automation-destination"
                    onValueChange={changeTarget}
                    options={dashboard.destinations.map((item) => ({
                      label: item.name,
                      value: item.id,
                    }))}
                    value={target}
                  />
                </Field>
                <span className="automation-destination-path" title={destination?.downloadPath}>
                  {destination?.downloadPath}
                </span>
              </div>
            ) : null}
            <div className="automation-scroll">
              {error || loadingError ? (
                <Alert variant="destructive">
                  <AlertDescription>{error ?? "Unable to load automations"}</AlertDescription>
                </Alert>
              ) : null}
              {notice ? (
                <Alert>
                  <CheckIcon />
                  <AlertDescription>{notice}</AlertDescription>
                </Alert>
              ) : null}
              {state ? (
                <>
                  <TabsContent value="inbox">
                    <SectionHeading
                      description="Every release Tofu is holding back, across all threads."
                      title="Inbox"
                    />
                    <AutomationInbox
                      approve={(decision) => decide(decision, "approve")}
                      busy={busy}
                      destinations={dashboard.destinations}
                      ignore={(decision) => decide(decision, "ignore")}
                      openRules={() => setTab("rules")}
                      state={state}
                    />
                  </TabsContent>
                  <TabsContent value="rules">
                    <div className="automation-section">
                      <form className="rule-composer" onSubmit={interpret}>
                        <label htmlFor="automation-query">
                          {editId ? "Edit this rule" : "Follow something new"}
                        </label>
                        <Textarea
                          id="automation-query"
                          onChange={(event) => {
                            setQuery(event.target.value);
                            setDraft(null);
                            setPreview(null);
                          }}
                          placeholder="New episodes of Ao Ashi season 2 in VF, 1080p then 720p, Tsundere-Raws before Nyaa"
                          required
                          rows={2}
                          value={query}
                        />
                        <div className="rule-composer-footer">
                          <p>
                            {jev?.enabled
                              ? "Jev reads your request."
                              : "Name a title; add a language, resolution or source if needed."}{" "}
                            Anything you leave out comes from your{" "}
                            <button
                              className="link-button"
                              onClick={() => setTab("preferences")}
                              type="button"
                            >
                              general preferences
                            </button>
                            .
                          </p>
                          <div className="rule-composer-actions">
                            {editId !== null && (
                              <Button onClick={reset} type="button" variant="ghost">
                                Cancel editing
                              </Button>
                            )}
                            <Button disabled={busy || !query.trim()} type="submit">
                              {busy ? (
                                <LoaderCircleIcon
                                  className="animate-spin"
                                  data-icon="inline-start"
                                />
                              ) : (
                                <ZapIcon data-icon="inline-start" />
                              )}
                              Prepare rule
                            </Button>
                          </div>
                        </div>
                      </form>
                      {draft !== null && (
                        <section aria-label="Rule settings" className="rule-editor">
                          <header>
                            <h3>{editId ? "Edit rule" : "Review the new rule"}</h3>
                            <p>
                              Downloads into <strong>{destination?.name}</strong> ·{" "}
                              {destination?.downloadPath}
                            </p>
                          </header>
                          <RuleFields
                            draft={draft}
                            onChange={(value) => {
                              setDraft(value);
                              setPreview(null);
                            }}
                          />
                          <footer className="rule-editor-actions">
                            <Button
                              disabled={busy}
                              onClick={() =>
                                action(async () =>
                                  setPreview(
                                    await request<Preview>("/automations/preview", "POST", draft)
                                  )
                                )
                              }
                              variant="outline"
                            >
                              <SearchIcon data-icon="inline-start" />
                              Preview matches
                            </Button>
                            <Button
                              disabled={busy || !draft.title.trim() || !draft.sources.length}
                              onClick={save}
                            >
                              <CheckIcon data-icon="inline-start" />
                              {editId ? "Save changes" : "Create automation"}
                            </Button>
                          </footer>
                          {preview !== null && (
                            <div className="automation-preview">
                              <h4>
                                {preview.candidates.length} release
                                {preview.candidates.length === 1 ? "" : "s"} found right now
                              </h4>
                              {preview.errors.map((item) => (
                                <Alert key={item.sourceId}>
                                  <AlertDescription>
                                    {sourceNames[item.sourceId]}: {item.message}
                                  </AlertDescription>
                                </Alert>
                              ))}
                              {preview.candidates.map((candidate) => (
                                <div
                                  className="preview-row"
                                  data-accepted={!(candidate.reason || candidate.uncertain)}
                                  key={`${candidate.release.sourceId}:${candidate.release.id}`}
                                >
                                  <ReleaseLine release={candidate.release} />
                                  <Badge variant="outline">
                                    {candidate.reason ??
                                      (candidate.uncertain ? "Would ask you" : "Would download")}
                                  </Badge>
                                </div>
                              ))}
                              {!preview.candidates.length && (
                                <p className="automation-muted">
                                  Nothing matches yet. The rule keeps checking for new releases.
                                </p>
                              )}
                            </div>
                          )}
                        </section>
                      )}
                      <div className="automation-list-heading">
                        <h3>
                          Rules in {destination?.name ?? "this thread"} <span>{rules.length}</span>
                        </h3>
                        <Button
                          disabled={busy}
                          onClick={() => action(reload)}
                          size="sm"
                          variant="ghost"
                        >
                          <RefreshCwIcon data-icon="inline-start" />
                          Refresh
                        </Button>
                      </div>
                      {rules.map((rule) => (
                        <RuleCard
                          busy={busy || rule.id.startsWith("pending:")}
                          edit={() => {
                            setEditId(rule.id);
                            setQuery(rule.query);
                            setDraft(ruleDraft(rule));
                            setPreview(null);
                          }}
                          key={rule.id}
                          now={now}
                          openInbox={() => setTab("inbox")}
                          pending={
                            pending.filter((decision) => decision.automationId === rule.id).length
                          }
                          remove={() =>
                            action(async () => {
                              await deleteRule.mutateAsync(rule.id);
                              if (editId === rule.id) {
                                reset();
                              }
                            })
                          }
                          rule={rule}
                          run={() =>
                            action(async () => {
                              await runRule.mutateAsync(rule.id);
                              await reload();
                              await refresh();
                            })
                          }
                          toggle={() =>
                            action(async () => {
                              await updateRule.mutateAsync(rule.id, {
                                ...ruleDraft(rule),
                                enabled: !rule.enabled,
                              });
                            })
                          }
                        />
                      ))}
                      {!(rules.length || draft) && (
                        <QuietEmpty
                          description="Describe what to follow above. Tofu checks your sources and downloads new releases into this thread."
                          icon={ZapIcon}
                          title="No rules in this thread yet"
                        />
                      )}
                    </div>
                  </TabsContent>
                  <TabsContent value="anilist">
                    <QueriedAniListPanel
                      action={action}
                      automations={state.automations}
                      busy={busy}
                      destinations={dashboard.destinations}
                      key={target}
                      openPreferences={() => setTab("preferences")}
                      plugin={state.plugins.find((plugin) => plugin.id === "anilist")}
                      preferences={state.preferences}
                      reloadPlugins={reload}
                      target={target}
                    />
                  </TabsContent>
                  <TabsContent value="discover">
                    <div className="automation-section">
                      <SectionHeading
                        description={`Search once across your sources and add a release to ${destination?.name ?? "this thread"}.`}
                        title="Discover"
                      />
                      <form
                        className="discover-form"
                        onSubmit={(event) => {
                          event.preventDefault();
                          action(async () =>
                            setDiscovery(
                              await request<DiscoveryResult>("/discover", "POST", {
                                query: search,
                                sources: selectedSources.map((plugin) => plugin.id),
                              })
                            )
                          );
                        }}
                      >
                        <Field>
                          <FieldLabel className="sr-only" htmlFor="feed-search">
                            {naturalSearch
                              ? "Natural language search across sources"
                              : "Keyword search across sources"}
                          </FieldLabel>
                          <div className="discover-search">
                            <InputGroup>
                              <InputGroupInput
                                disabled={busy || !activeSources.length}
                                id="feed-search"
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder={
                                  naturalSearch ? "re zero ep9 season4" : "A title, keywords…"
                                }
                                required
                                value={search}
                              />
                              <InputGroupAddon align="inline-start">
                                <SearchIcon />
                              </InputGroupAddon>
                            </InputGroup>
                            <Button
                              disabled={busy || !selectedSources.length || !search.trim()}
                              type="submit"
                            >
                              {busy ? (
                                <LoaderCircleIcon
                                  className="animate-spin"
                                  data-icon="inline-start"
                                />
                              ) : null}
                              {busy ? "Searching…" : "Search"}
                            </Button>
                          </div>
                        </Field>
                        <fieldset className="discover-sources" disabled={busy}>
                          <legend>Sources</legend>
                          {activeSources.length ? (
                            <>
                              <Field orientation="horizontal">
                                <Checkbox
                                  checked={selectedSources.length === activeSources.length}
                                  disabled={busy}
                                  id="discovery-all-sources"
                                  indeterminate={
                                    selectedSources.length > 0 &&
                                    selectedSources.length < activeSources.length
                                  }
                                  onCheckedChange={(checked) => {
                                    setExcludedSources(
                                      checked === true
                                        ? []
                                        : activeSources.map((plugin) => plugin.id)
                                    );
                                    setDiscovery(null);
                                  }}
                                />
                                <FieldLabel htmlFor="discovery-all-sources">All</FieldLabel>
                              </Field>
                              {activeSources.map((plugin) => (
                                <Field key={plugin.id} orientation="horizontal">
                                  <Checkbox
                                    checked={!excludedSources.includes(plugin.id)}
                                    disabled={busy}
                                    id={`discovery-source-${plugin.id}`}
                                    onCheckedChange={(checked) => {
                                      setExcludedSources((previous) =>
                                        checked === true
                                          ? previous.filter((id) => id !== plugin.id)
                                          : [...previous, plugin.id]
                                      );
                                      setDiscovery(null);
                                    }}
                                  />
                                  <FieldLabel htmlFor={`discovery-source-${plugin.id}`}>
                                    {plugin.name}
                                  </FieldLabel>
                                </Field>
                              ))}
                            </>
                          ) : (
                            <span className="automation-muted">
                              Enable a source in Plugins to search.
                            </span>
                          )}
                        </fieldset>
                        <p className="automation-muted">
                          {naturalSearch
                            ? "Title, season and episode in any order. English and Japanese titles are searched automatically."
                            : "Keywords are searched as typed. Enable Jev in Plugins for natural language search."}
                        </p>
                      </form>
                      {discovery?.search?.warning ? (
                        <Alert>
                          <AlertDescription>{discovery.search.warning}</AlertDescription>
                        </Alert>
                      ) : null}
                      {discovery?.search?.title ? (
                        <div aria-live="polite" className="discovery-summary">
                          <strong>{discovery.search.title}</strong>
                          {discovery.search.season === null ? null : (
                            <Badge variant="secondary">Season {discovery.search.season}</Badge>
                          )}
                          {discovery.search.episode === null ? null : (
                            <Badge variant="secondary">Episode {discovery.search.episode}</Badge>
                          )}
                          <span>
                            {discovery.releases.length} result
                            {discovery.releases.length === 1 ? "" : "s"}
                          </span>
                        </div>
                      ) : null}
                      {discovery?.errors.map((item) => (
                        <Alert key={item.sourceId}>
                          <AlertDescription>
                            {sourceNames[item.sourceId]}: {item.message}
                          </AlertDescription>
                        </Alert>
                      ))}
                      {discovery?.releases.length ? (
                        <div className="release-list">
                          {discovery.releases.map((release) => (
                            <div className="preview-row" key={`${release.sourceId}:${release.id}`}>
                              <ReleaseLine release={release} />
                              <Button
                                disabled={busy}
                                onClick={() =>
                                  action(async () => {
                                    await addRelease.mutateAsync({
                                      destinationId: target,
                                      id: release.id,
                                      paused: false,
                                      sourceId: release.sourceId,
                                    });
                                    await refresh();
                                    setNotice(`Added to ${destination?.name ?? "the thread"}.`);
                                  })
                                }
                                size="sm"
                                variant="outline"
                              >
                                <PlusIcon data-icon="inline-start" />
                                Add
                              </Button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <QuietEmpty
                          description={
                            discovery
                              ? "Try another title or season, or select more sources."
                              : "Search for a series, a season, or a single episode."
                          }
                          icon={SearchIcon}
                          title={discovery ? "No releases found" : "One search, every source"}
                        />
                      )}
                    </div>
                  </TabsContent>
                  <TabsContent value="history">
                    <div className="automation-section">
                      <SectionHeading
                        description="What the rules of this thread downloaded or skipped. Pending releases live in the Inbox."
                        title="History"
                      >
                        <Button
                          disabled={busy}
                          onClick={() => action(reload)}
                          size="sm"
                          variant="ghost"
                        >
                          <RefreshCwIcon data-icon="inline-start" />
                          Refresh
                        </Button>
                      </SectionHeading>
                      {history.length ? (
                        <div className="release-list">
                          {history.map((decision) => (
                            <div
                              className="history-row"
                              data-decision={decision.status}
                              key={decision.id}
                            >
                              <ReleaseLine release={decision.release} />
                              <div className="history-row-status">
                                <Badge variant="outline">{decisionStatuses[decision.status]}</Badge>
                                <span>{relative(decision.createdAt, now)}</span>
                              </div>
                              <p>{decision.reason}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <QuietEmpty
                          description="Downloaded and skipped releases will be listed here."
                          icon={HistoryIcon}
                          title="Nothing yet"
                        />
                      )}
                    </div>
                  </TabsContent>
                  <TabsContent value="preferences">
                    <GeneralPreferences initialPreferences={state.preferences} />
                  </TabsContent>
                </>
              ) : (
                <Skeleton className="h-40" />
              )}
            </div>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
