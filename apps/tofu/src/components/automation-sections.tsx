import { useMutation } from "@teyik0/furin/client";
import { HistoryIcon, RefreshCwIcon } from "lucide-react";
import { QueriedAniListPanel } from "../../../../package/anilist/src/components/panel";
import type { AutomationDecision } from "../../../../package/plugins/src/automation-model";
import { relative } from "../../../../package/ui/src/format";
import { Badge } from "../../../../package/ui/src/ui/badge";
import { Button } from "../../../../package/ui/src/ui/button";
import { useAsyncAction } from "../../../../package/ui/src/use-async-action";
import { useNow } from "../../../../package/ui/src/use-now";
import { api } from "../lib/client";
import { useRefresh } from "../lib/navigation";
import { AutomationInbox, isPending, ReleaseLine } from "./automation-inbox";
import {
  type AutomationPanelProps,
  AutomationSectionPanel,
  AutomationThread,
  mutations,
  QuietEmpty,
  reloadAutomations as reload,
  SectionHeading,
} from "./automation-section";
import { GeneralPreferences } from "./general-preferences";
export function AutomationInboxSection({ state, dashboard, setTab }: AutomationPanelProps) {
  const refresh = useRefresh();
  const ignoreDecision = useMutation(mutations.ignoreDecision);
  const approveDecision = useMutation((id: string) =>
    api["automation-decisions"]({ id }).approve.post()
  );
  const { busy, error, action } = useAsyncAction("An error occurred");
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

  return (
    <AutomationSectionPanel error={error} value="inbox">
      <SectionHeading
        description="Every release Tofu is holding back, across all threads."
        title="Inbox"
      />
      <AutomationInbox
        approve={(decision) => decide(decision, "approve")}
        busy={busy}
        destinations={dashboard.host?.destinations ?? []}
        ignore={(decision) => decide(decision, "ignore")}
        openRules={() => setTab("rules")}
        state={state}
      />
    </AutomationSectionPanel>
  );
}

export function AutomationAniListSection({
  state,
  dashboard,
  target,
  onTarget,
  setTab,
}: AutomationPanelProps) {
  const { busy, error, action } = useAsyncAction("Unable to update AniList");
  return (
    <AutomationSectionPanel
      error={error}
      thread={
        <AutomationThread
          dashboard={dashboard}
          disabled={busy}
          onChange={onTarget}
          target={target}
        />
      }
      value="anilist"
    >
      <QueriedAniListPanel
        action={action}
        automations={state.automations}
        busy={busy}
        destinations={dashboard.host?.destinations ?? []}
        key={target}
        openPreferences={() => setTab("preferences")}
        plugin={state.plugins.find((plugin) => plugin.id === "anilist")}
        preferences={state.preferences}
        reloadPlugins={reload}
        target={target}
      />
    </AutomationSectionPanel>
  );
}

export function AutomationHistorySection({
  state,
  dashboard,
  target,
  onTarget,
}: AutomationPanelProps) {
  const { busy, error, action } = useAsyncAction("Unable to load automations");
  const now = useNow(30_000);
  const ruleIds = new Set(
    state.automations.filter((rule) => rule.destinationId === target).map((rule) => rule.id)
  );
  const history = state.decisions.filter(
    (decision) => !isPending(decision) && ruleIds.has(decision.automationId)
  );
  const decisionStatuses: Record<AutomationDecision["status"], string> = {
    added: "Added",
    adding: "Adding",
    error: "Could not be added",
    ignored: "Skipped",
    review: "Needs confirmation",
    waiting: "Waiting for a better version",
  };
  return (
    <AutomationSectionPanel
      error={error}
      thread={
        <AutomationThread
          dashboard={dashboard}
          disabled={busy}
          onChange={onTarget}
          target={target}
        />
      }
      value="history"
    >
      <div className="automation-section">
        <SectionHeading
          description="What the rules of this thread downloaded or skipped. Pending releases live in the Inbox."
          title="History"
        >
          <Button disabled={busy} onClick={() => action(reload)} size="sm" variant="ghost">
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        </SectionHeading>
        {history.length ? (
          <div className="release-list">
            {history.map((decision) => (
              <div className="history-row" data-decision={decision.status} key={decision.id}>
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
    </AutomationSectionPanel>
  );
}

export function AutomationPreferencesSection({ state }: AutomationPanelProps) {
  return (
    <AutomationSectionPanel value="preferences">
      <GeneralPreferences initialPreferences={state.preferences} />
    </AutomationSectionPanel>
  );
}
