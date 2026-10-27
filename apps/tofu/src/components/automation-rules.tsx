import { useMutation } from "@teyik0/furin/client";
import { PlusIcon, RefreshCwIcon, ZapIcon } from "lucide-react";
import { useState } from "react";
import type {
  AutomationDraft,
  AutomationRule,
} from "../../../../package/plugins/src/automation-model";
import { interpretLocally } from "../../../../package/plugins/src/automation-rules";
import { Button } from "../../../../package/ui/src/ui/button";
import { useAsyncAction } from "../../../../package/ui/src/use-async-action";
import { useNow } from "../../../../package/ui/src/use-now";
import { api } from "../lib/client";
import { useRefresh } from "../lib/navigation";
import { AutomationEditor } from "./automation-editor";
import { isPending } from "./automation-inbox";
import {
  type AutomationPanelProps,
  AutomationSectionPanel,
  AutomationThread,
  mutations,
  QuietEmpty,
  RuleCard,
  reloadAutomations as reload,
  ruleDraft,
} from "./automation-section";

export function AutomationRules({
  state,
  dashboard,
  target,
  onTarget,
  setTab,
}: AutomationPanelProps) {
  const refresh = useRefresh();
  const updateRule = useMutation(mutations.updateRule);
  const deleteRule = useMutation(mutations.deleteRule);
  const runRule = useMutation((id: string) => api.automations({ id }).run.post());
  const [editor, setEditor] = useState<{ draft: AutomationDraft; rule?: AutomationRule } | null>(
    null
  );
  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error, action } = useAsyncAction("Unable to update automation");
  const now = useNow(30_000);
  const destination = (dashboard.host?.destinations ?? []).find((item) => item.id === target);
  const rules = state.automations.filter((rule) => rule.destinationId === target);
  const pending = state.decisions.filter(isPending);
  const reset = () => {
    setEditor(null);
    setNotice(null);
  };
  return (
    <AutomationSectionPanel
      error={error}
      notice={notice}
      thread={
        <AutomationThread
          dashboard={dashboard}
          disabled={busy}
          onChange={(value) => {
            reset();
            onTarget(value);
          }}
          target={target}
        />
      }
      value="rules"
    >
      <div className="automation-section">
        <div className="automation-section-title">
          <div>
            <h3>Automate anything</h3>
            <p>Follow a title or release pattern with your preferred sources.</p>
          </div>
          <Button
            disabled={busy}
            onClick={() => {
              setNotice(null);
              setEditor({
                draft: {
                  ...interpretLocally("", target, state.preferences),
                  includeExisting: true,
                },
              });
            }}
          >
            <PlusIcon data-icon="inline-start" />
            New automation
          </Button>
        </div>
        {editor ? (
          <AutomationEditor
            close={reset}
            destinations={dashboard.host?.destinations ?? []}
            initialDraft={editor.draft}
            key={editor.rule?.id ?? `new:${target}`}
            onSaved={(rule) => {
              setEditor(null);
              onTarget(rule.destinationId);
              setNotice(
                rule.enabled ? "Automation saved and checked once." : "Automation saved and paused."
              );
            }}
            rule={editor.rule}
            state={state}
          />
        ) : null}
        <div className="automation-list-heading">
          <h3>
            Rules in {destination?.name ?? "this thread"} <span>{rules.length}</span>
          </h3>
          <Button disabled={busy} onClick={() => action(reload)} size="sm" variant="ghost">
            <RefreshCwIcon data-icon="inline-start" />
            Refresh
          </Button>
        </div>
        {rules.map((rule) => (
          <RuleCard
            busy={busy || rule.id.startsWith("pending:")}
            edit={() => {
              setEditor({ draft: ruleDraft(rule), rule });
            }}
            key={rule.id}
            now={now}
            openInbox={() => setTab("inbox")}
            pending={pending.filter((decision) => decision.automationId === rule.id).length}
            remove={() =>
              action(async () => {
                await deleteRule.mutateAsync(rule.id);
                if (editor?.rule?.id === rule.id) {
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
        {!(rules.length || editor) && (
          <QuietEmpty
            description="Create an automation to follow matching releases from your sources."
            icon={ZapIcon}
            title="No rules in this thread yet"
          />
        )}
      </div>
    </AutomationSectionPanel>
  );
}
