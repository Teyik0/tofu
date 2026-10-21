import {
  CheckIcon,
  InboxIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RefreshCwIcon,
  Trash2Icon,
  type ZapIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { createAutomationMutations } from "../lib/automation-mutations";
import { api } from "../lib/client";
import type {
  AutomationDraft,
  AutomationRule,
  AutomationSection,
  AutomationState,
  DiscoveryResult,
  FeedRelease,
  LiveState,
} from "../types";
import { ActionTooltip } from "./action-tooltip";
import { sourceNames } from "./automation-fields";
import { relative } from "./format";
import { OptionSelect } from "./option-select";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";
import { Field, FieldLabel } from "./ui/field";
import { TabsContent } from "./ui/tabs";
export const mutations = createAutomationMutations(api);
const ruleStatuses: Record<AutomationRule["status"], string> = {
  active: "Active",
  error: "Needs attention",
  paused: "Paused",
  running: "Checking…",
  "source-disabled": "Plugin disabled",
};
export type Preview = DiscoveryResult & {
  candidates: {
    release: FeedRelease;
    reason: string | null;
    probability: number | null;
    uncertain: boolean;
  }[];
};

export function QuietEmpty({
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

export function SectionHeading({
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

export function ruleDraft(rule: AutomationRule): AutomationDraft {
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

export function RuleCard({
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
        <li>{rule.includeExisting ? "Includes existing releases" : "New releases only"}</li>
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

export interface AutomationPanelProps {
  dashboard: LiveState;
  onTarget: (value: string) => void;
  setTab: (value: AutomationSection) => void;
  state: AutomationState;
  target: string;
}

export async function reloadAutomations() {
  const { error } = await api.automation.get();
  if (error) {
    throw new Error("Unable to load automations");
  }
}

export function AutomationThread({
  dashboard,
  target,
  disabled,
  onChange,
}: {
  dashboard: LiveState;
  target: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) {
  const destination = (dashboard.host?.destinations ?? []).find((item) => item.id === target);
  return (
    <div className="automation-thread">
      <Field className="automation-target" orientation="horizontal">
        <FieldLabel htmlFor="automation-destination">Thread</FieldLabel>
        <OptionSelect
          disabled={disabled}
          id="automation-destination"
          onValueChange={onChange}
          options={(dashboard.host?.destinations ?? []).map((item) => ({
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
  );
}

export function AutomationSectionPanel({
  value,
  thread,
  error,
  notice,
  children,
}: {
  value: AutomationSection;
  thread?: ReactNode;
  error?: string | null;
  notice?: string | null;
  children: ReactNode;
}) {
  return (
    <TabsContent className="min-h-0 flex-1 flex-col [&:not([hidden])]:flex" value={value}>
      {thread}
      <div className="automation-scroll">
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {notice ? (
          <Alert>
            <CheckIcon />
            <AlertDescription>{notice}</AlertDescription>
          </Alert>
        ) : null}
        {children}
      </div>
    </TabsContent>
  );
}
