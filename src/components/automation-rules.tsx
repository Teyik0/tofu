import { Form, getDeepError, useField, useForm } from "@formisch/react";
import { useMutation } from "@teyik0/furin/client";
import { CheckIcon, LoaderCircleIcon, RefreshCwIcon, SearchIcon, ZapIcon } from "lucide-react";
import { useState } from "react";
import { pick } from "valibot";
import { interpretationSchema } from "../api/modules/jev/model";
import { useAsyncAction } from "../hooks/use-async-action";
import { useAutomationDraftForm } from "../hooks/use-automation-draft-form";
import { useNow } from "../hooks/use-now";
import { api } from "../lib/client";
import { useRefresh } from "../lib/navigation";
import type { AsyncAction, AutomationDraft } from "../types";
import { request } from "./api";
import { RuleFields, sourceNames } from "./automation-fields";
import { isPending, ReleaseLine } from "./automation-inbox";
import {
  type AutomationPanelProps,
  AutomationSectionPanel,
  AutomationThread,
  mutations,
  type Preview,
  QuietEmpty,
  RuleCard,
  reloadAutomations as reload,
  ruleDraft,
} from "./automation-section";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
export function AutomationRules({
  state,
  dashboard,
  target,
  onTarget,
  setTab,
}: AutomationPanelProps) {
  const refresh = useRefresh();
  const createRule = useMutation(mutations.createRule);
  const updateRule = useMutation(mutations.updateRule);
  const deleteRule = useMutation(mutations.deleteRule);
  const runRule = useMutation((id: string) => api.automations({ id }).run.post());
  const queryForm = useForm({
    initialInput: { query: "" },
    schema: pick(interpretationSchema, ["query"]),
  });
  const queryField = useField(queryForm, { path: ["query"] });
  const query = queryField.input ?? "";
  const setQuery = queryField.onChange;
  const { draft, setDraft, validatedDraft, error: draftError } = useAutomationDraftForm(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const [notice, setNotice] = useState<string | null>(null);
  const { busy, error: serverError, action: run } = useAsyncAction("An error occurred");
  const error = serverError ?? getDeepError(queryForm) ?? draftError;
  const action: AsyncAction = (task) => {
    setNotice(null);
    run(task);
  };
  const now = useNow(30_000);
  const destination = dashboard.destinations.find((item) => item.id === target);
  const jev = state.plugins.find((item) => item.id === "jev");
  const rules = state.automations.filter((rule) => rule.destinationId === target);
  const pending = state.decisions.filter(isPending);
  const reset = () => {
    setDraft(null);
    setEditId(null);
    setQuery("");
    setPreview(null);
  };
  const interpret = () => {
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
      const validated = await validatedDraft();
      if (!validated) {
        return;
      }
      const body = { ...validated, destinationId: target };
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
        <Form className="rule-composer" of={queryForm} onSubmit={interpret}>
          <label htmlFor="automation-query">
            {editId ? "Edit this rule" : "Follow something new"}
          </label>
          <Textarea
            {...queryField.props}
            aria-invalid={Boolean(queryField.errors)}
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
              <button className="link-button" onClick={() => setTab("preferences")} type="button">
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
                  <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
                ) : (
                  <ZapIcon data-icon="inline-start" />
                )}
                Prepare rule
              </Button>
            </div>
          </div>
        </Form>
        {draft !== null && (
          <section aria-label="Rule settings" className="rule-editor">
            <header>
              <h3>{editId ? "Edit rule" : "Review the new rule"}</h3>
              <p>
                Downloads into <strong>{destination?.name}</strong> · {destination?.downloadPath}
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
                  action(async () => {
                    const validated = await validatedDraft();
                    if (validated) {
                      setPreview(await request<Preview>("/automations/preview", "POST", validated));
                    }
                  })
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
          <Button disabled={busy} onClick={() => action(reload)} size="sm" variant="ghost">
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
            pending={pending.filter((decision) => decision.automationId === rule.id).length}
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
    </AutomationSectionPanel>
  );
}
