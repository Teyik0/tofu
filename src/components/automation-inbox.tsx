import {
  AlertTriangleIcon,
  CheckIcon,
  CircleHelpIcon,
  HourglassIcon,
  InboxIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AutomationDecision,
  AutomationRule,
  AutomationState,
  Destination,
  FeedRelease,
} from "../types";
import { sourceNames } from "./automation-fields";
import { bytes, relative } from "./format";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "./ui/empty";

export type PendingStatus = Extract<AutomationDecision["status"], "review" | "waiting" | "error">;
export const pendingStatuses: PendingStatus[] = ["review", "error", "waiting"];
export const isPending = (
  decision: AutomationDecision
): decision is AutomationDecision & { status: PendingStatus } =>
  (pendingStatuses as string[]).includes(decision.status);

/** Re-renders periodically so countdowns stay accurate while the dialog is open. */
export function useNow(interval: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

export function ReleaseLine({ release }: { release: FeedRelease }) {
  return (
    <div className="release-line">
      <strong title={release.title}>{release.title}</strong>
      <div className="release-meta">
        <Badge variant="outline">{sourceNames[release.sourceId]}</Badge>
        <span>{release.language ?? "—"}</span>
        <span>{release.resolution ?? "—"}</span>
        {release.codec ? <span>{release.codec}</span> : null}
        <span>{bytes(release.size)}</span>
        <span>{release.seeders === null ? "—" : release.seeders} sources</span>
      </div>
    </div>
  );
}

const groups: {
  status: PendingStatus;
  title: string;
  description: string;
  icon: typeof HourglassIcon;
}[] = [
  {
    description: "Nothing downloads until you choose.",
    icon: CircleHelpIcon,
    status: "review",
    title: "Needs your confirmation",
  },
  {
    description: "Tofu could not add these torrents and retries on each check.",
    icon: AlertTriangleIcon,
    status: "error",
    title: "Could not be added",
  },
  {
    description:
      "A fallback version was found. Tofu keeps looking for one that better matches your priorities, then downloads the best version automatically.",
    icon: HourglassIcon,
    status: "waiting",
    title: "Waiting for a better version",
  },
];

function explain(decision: AutomationDecision, rule: AutomationRule | undefined, now: number) {
  if (decision.status === "waiting") {
    return `Not your first choice. Downloads ${relative(decision.deadline, now)} unless a better version appears.`;
  }
  if (decision.status === "error") {
    return decision.reason;
  }
  if (decision.probability !== null && rule?.automatic !== false) {
    return `Jev is ${Math.round(decision.probability * 100)} % sure this release matches “${rule?.title ?? "the rule"}”.`;
  }
  return "This rule asks before downloading.";
}

export function AutomationInbox({
  state,
  destinations,
  busy,
  approve,
  ignore,
  openRules,
}: {
  state: AutomationState;
  destinations: Destination[];
  busy: boolean;
  approve: (decision: AutomationDecision) => void;
  ignore: (decision: AutomationDecision) => void;
  openRules: () => void;
}) {
  const now = useNow(30_000);
  const pending = state.decisions.filter(isPending);
  return (
    <div className="automation-section">
      <ol aria-label="How automations work" className="inbox-flow">
        <li>
          <b>1</b>
          <span>
            <strong>Check</strong>Rules search your sources on a schedule.
          </span>
        </li>
        <li>
          <b>2</b>
          <span>
            <strong>Decide</strong>The ideal match downloads; others wait here.
          </span>
        </li>
        <li>
          <b>3</b>
          <span>
            <strong>Download</strong>Added to the rule’s thread folder.
          </span>
        </li>
        <li>
          <b>4</b>
          <span>
            <strong>Upgrade</strong>A better version later replaces the old one.
          </span>
        </li>
      </ol>
      {pending.length === 0 ? (
        <Empty className="automation-empty">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <InboxIcon />
            </EmptyMedia>
            <EmptyTitle>Nothing is waiting for you</EmptyTitle>
            <EmptyDescription>
              Releases that need a confirmation, failed to add, or wait for a better version appear
              here.
            </EmptyDescription>
          </EmptyHeader>
          <Button onClick={openRules} variant="outline">
            Manage rules
          </Button>
        </Empty>
      ) : (
        groups.map((group) => {
          const items = pending
            .filter((decision) => decision.status === group.status)
            .sort((a, b) => (a.deadline ?? a.createdAt) - (b.deadline ?? b.createdAt));
          if (!items.length) {
            return null;
          }
          const Icon = group.icon;
          return (
            <section
              aria-label={group.title}
              className="inbox-group"
              data-status={group.status}
              key={group.status}
            >
              <header>
                <Icon aria-hidden="true" />
                <div>
                  <h3>
                    {group.title} <span>{items.length}</span>
                  </h3>
                  <p>{group.description}</p>
                </div>
              </header>
              {items.map((decision) => {
                const rule = state.automations.find((item) => item.id === decision.automationId);
                const thread = destinations.find((item) => item.id === rule?.destinationId);
                return (
                  <article className="inbox-item" key={decision.id}>
                    <div className="inbox-item-context">
                      <span>{rule?.title ?? "Deleted rule"}</span>
                      <span>{thread?.name ?? "—"}</span>
                      {decision.supersedes ? <span>Upgrade of an existing download</span> : null}
                    </div>
                    <ReleaseLine release={decision.release} />
                    <p className="inbox-item-reason">{explain(decision, rule, now)}</p>
                    <div className="inbox-item-actions">
                      <Button disabled={busy || !rule} onClick={() => approve(decision)} size="sm">
                        {decision.status === "error" ? (
                          <RefreshCwIcon data-icon="inline-start" />
                        ) : (
                          <CheckIcon data-icon="inline-start" />
                        )}
                        {decision.status === "waiting"
                          ? "Download now"
                          : decision.status === "error"
                            ? "Retry now"
                            : "Download"}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => ignore(decision)}
                        size="sm"
                        variant="ghost"
                      >
                        Skip this release
                      </Button>
                    </div>
                  </article>
                );
              })}
            </section>
          );
        })
      )}
    </div>
  );
}
