import { useMutation } from "@teyik0/furin/client";
import { CheckIcon, LoaderCircleIcon, SearchIcon, XIcon, ZapIcon } from "lucide-react";
import { useId, useState } from "react";
import type {
  AutomationDraft,
  AutomationRule,
  AutomationState,
} from "@/api/modules/automation/model";
import type { LiveState } from "@/api/modules/dashboard/projection";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useAutomationDraftForm } from "@/hooks/use-automation-draft-form";
import { api } from "@/lib/client";
import { useRefresh } from "@/lib/navigation";
import { ActionTooltip } from "./action-tooltip";
import { sourceNames } from "./automation-fields";
import { ReleaseLine } from "./automation-inbox";
import { mutations, type Preview } from "./automation-section";
import { CompactAutomationFields } from "./compact-automation-fields";
import { OptionSelect } from "./option-select";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";

export function AutomationEditor({
  initialDraft,
  rule,
  state,
  destinations,
  onSaved,
  close,
}: {
  initialDraft: AutomationDraft;
  rule?: AutomationRule;
  state: AutomationState;
  destinations: NonNullable<LiveState["host"]>["destinations"];
  onSaved: (rule: AutomationRule) => void;
  close: () => void;
}) {
  const prefix = useId();
  const refresh = useRefresh();
  const {
    draft,
    setDraft,
    validatedDraft,
    error: validationError,
  } = useAutomationDraftForm(initialDraft);
  const { busy, error: actionError, action } = useAsyncAction("Unable to save automation");
  const create = useMutation(mutations.createRule);
  const update = useMutation(mutations.updateRule);
  const run = useMutation((id: string) => api.automations({ id }).run.post());
  const previewRule = useMutation(api.automations.preview.post);
  const [savedId, setSavedId] = useState(rule?.id);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [episodeFiltering, setEpisodeFiltering] = useState(
    initialDraft.season !== null || (initialDraft.afterEpisode ?? 0) > 0
  );
  if (!draft) {
    return null;
  }
  const change = (value: AutomationDraft) => {
    setDraft(value);
    setPreview(null);
  };
  const error = actionError ?? validationError;
  const availableSources = state.plugins.some(
    (plugin) => plugin.enabled && draft.sources.includes(plugin.id)
  );
  return (
    <section aria-labelledby={`${prefix}-heading`} className="automation-editor">
      <header className="notification-automation-heading">
        <ZapIcon aria-hidden="true" />
        <h4 id={`${prefix}-heading`}>{savedId ? "Edit automation" : "New automation"}</h4>
        <ActionTooltip>
          <Button
            aria-label="Close automation settings"
            disabled={busy}
            onClick={close}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </ActionTooltip>
      </header>
      <p className="notification-automation-intro">
        Follow matching releases with your preferred formats and sources.
      </p>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {availableSources ? null : (
        <Alert>
          <AlertDescription>
            No selected source is enabled. Choose an enabled source in Advanced preferences or
            enable one in Plugins.
          </AlertDescription>
        </Alert>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action(async () => {
            const validated = await validatedDraft();
            if (!validated) {
              return;
            }
            const saved = savedId
              ? await update.mutateAsync(savedId, validated)
              : await create.mutateAsync(validated);
            if (!(saved && "id" in saved)) {
              return;
            }
            // A failed first check must never turn a retry into a second rule.
            setSavedId(saved.id);
            if (saved.enabled) {
              const checked = await run.mutateAsync(saved.id);
              const checkedRule = checked?.automations.find((item) => item.id === saved.id);
              if (checkedRule?.error) {
                throw new Error(
                  `Automation saved, but the first check failed: ${checkedRule.error}`
                );
              }
            }
            await refresh();
            onSaved(saved);
          });
        }}
      >
        <fieldset className="automation-editor-controls" disabled={busy}>
          <Field className="automation-editor-query">
            <FieldLabel htmlFor={`${prefix}-query`}>Search query</FieldLabel>
            <Input
              id={`${prefix}-query`}
              maxLength={draft.matchMode === "pattern" ? 256 : 500}
              onChange={(event) =>
                change({
                  ...draft,
                  aliases: [],
                  query: event.target.value,
                  title: event.target.value,
                })
              }
              placeholder="A title or release pattern"
              required
              value={draft.title}
            />
            <FieldDescription>
              {draft.matchMode === "pattern"
                ? "Matches the release name using a regular expression."
                : "Matches the extracted title. Adjust matching in Advanced preferences."}
            </FieldDescription>
          </Field>
          <CompactAutomationFields
            advanced={
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor={`${prefix}-matching`}>Matching</FieldLabel>
                  <OptionSelect
                    disabled={busy}
                    id={`${prefix}-matching`}
                    onValueChange={(value) =>
                      change({ ...draft, matchMode: value === "pattern" ? "pattern" : "exact" })
                    }
                    options={[
                      { label: "Exact title", value: "exact" },
                      { label: "Release name pattern", value: "pattern" },
                    ]}
                    value={draft.matchMode}
                  />
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    checked={draft.enabled}
                    id={`${prefix}-enabled`}
                    onCheckedChange={(checked) => change({ ...draft, enabled: checked === true })}
                  />
                  <FieldLabel htmlFor={`${prefix}-enabled`}>Enable this automation</FieldLabel>
                </Field>
              </FieldGroup>
            }
            busy={busy}
            destinations={destinations}
            draft={draft}
            onChange={change}
            prefix={prefix}
          >
            <Field className="notification-automation-catchup" orientation="horizontal">
              <Checkbox
                checked={episodeFiltering}
                id={`${prefix}-episode-filtering`}
                onCheckedChange={(checked) => {
                  setEpisodeFiltering(checked === true);
                  change({ ...draft, afterEpisode: 0, season: null });
                }}
              />
              <div>
                <FieldLabel htmlFor={`${prefix}-episode-filtering`}>Episode filtering</FieldLabel>
                <FieldDescription>
                  Optionally choose a season and the first episode to download.
                </FieldDescription>
              </div>
            </Field>
            {episodeFiltering ? (
              <FieldGroup className="automation-editor-episodes">
                <Field>
                  <FieldLabel htmlFor={`${prefix}-season`}>Season</FieldLabel>
                  <Input
                    id={`${prefix}-season`}
                    max={1000}
                    min={0}
                    onChange={(event) =>
                      change({
                        ...draft,
                        season: event.target.value ? Number(event.target.value) : null,
                      })
                    }
                    placeholder="All seasons"
                    type="number"
                    value={draft.season ?? ""}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor={`${prefix}-episode`}>First episode</FieldLabel>
                  <Input
                    id={`${prefix}-episode`}
                    max={10_001}
                    min={1}
                    onChange={(event) =>
                      change({ ...draft, afterEpisode: Number(event.target.value) - 1 })
                    }
                    required
                    type="number"
                    value={(draft.afterEpisode ?? 0) + 1}
                  />
                </Field>
                <p className="automation-editor-episode-summary">
                  {draft.season === null ? "All seasons" : `Season ${draft.season} only`} · Episode{" "}
                  {(draft.afterEpisode ?? 0) + 1} onwards
                  {draft.season === null ? " in each season" : ""}. Earlier episodes are excluded.
                </p>
              </FieldGroup>
            ) : null}
            <Field className="notification-automation-catchup" orientation="horizontal">
              <Checkbox
                checked={draft.includeExisting}
                disabled={busy || Boolean(savedId)}
                id={`${prefix}-existing`}
                onCheckedChange={(checked) =>
                  change({ ...draft, includeExisting: checked === true })
                }
              />
              <div>
                <FieldLabel htmlFor={`${prefix}-existing`}>Include existing releases</FieldLabel>
                <FieldDescription>
                  {savedId
                    ? "Set when the rule is created. Previously skipped releases stay skipped."
                    : "Include matches already available, then watch for new releases."}
                </FieldDescription>
              </div>
            </Field>
          </CompactAutomationFields>
        </fieldset>
        <footer className="notification-automation-footer">
          <Button
            disabled={busy || !draft.title.trim()}
            onClick={() =>
              action(async () => {
                const validated = await validatedDraft();
                if (validated) {
                  const result = await previewRule.mutateAsync(validated);
                  if (result) {
                    setPreview(result);
                  }
                }
              })
            }
            size="sm"
            variant="ghost"
          >
            <SearchIcon data-icon="inline-start" />
            Preview matches
          </Button>
          <Button
            disabled={busy || !draft.title.trim() || !draft.sources.length || !destinations.length}
            type="submit"
          >
            {busy ? (
              <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
            ) : savedId ? (
              <CheckIcon data-icon="inline-start" />
            ) : (
              <ZapIcon data-icon="inline-start" />
            )}
            {savedId
              ? "Save changes"
              : draft.enabled
                ? "Enable automation"
                : "Create paused automation"}
          </Button>
        </footer>
      </form>
      {preview ? (
        <div aria-live="polite" className="automation-preview">
          <h4>{preview.candidates.length} releases found right now</h4>
          {preview.errors.map((item) => (
            <Alert key={item.sourceId}>
              <AlertDescription>
                {sourceNames[item.sourceId] ?? item.sourceId}: {item.message}
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
                {candidate.reason ?? (candidate.uncertain ? "Would ask you" : "Would download")}
              </Badge>
            </div>
          ))}
          {preview.candidates.length ? null : (
            <p className="automation-muted">
              Nothing matches yet. The rule keeps checking for new releases.
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
