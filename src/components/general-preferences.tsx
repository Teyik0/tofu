import { Form, getDeepError, reset } from "@formisch/react";
import { useMutation, useQuery } from "@teyik0/furin/client";
import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import { useState } from "react";
import { usePreferencesForm } from "../hooks/use-preferences-form";
import { createAutomationMutations } from "../lib/automation-mutations";
import { api } from "../lib/client";
import type { AutomationPreferences } from "../types";
import { PreferenceFields } from "./automation-fields";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { FieldSet } from "./ui/field";

const mutations = createAutomationMutations(api);

export function GeneralPreferences({
  initialPreferences,
}: {
  initialPreferences: AutomationPreferences;
}) {
  const { data: live } = useQuery(api.automation.get);
  const savePreferences = useMutation(mutations.savePreferences);
  const [saved, setSaved] = useState(false);
  const preferences = live && "preferences" in live ? live.preferences : initialPreferences;
  const { form, value, setValue } = usePreferencesForm(preferences);
  const dirty = form.isDirty;
  const busy = form.isSubmitting;
  const [serverError, setError] = useState<string | null>(null);
  const error = getDeepError(form) ?? serverError;
  const save = async (next: AutomationPreferences) => {
    if (!dirty) {
      return;
    }
    setSaved(false);
    setError(null);
    try {
      const confirmed = await savePreferences.mutateAsync(next);
      reset(form, { initialInput: confirmed && "sources" in confirmed ? confirmed : next });
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save preferences");
    }
  };

  return (
    <Form
      className="automation-section general-preferences"
      id="preferences-form"
      of={form}
      onSubmit={save}
    >
      <header className="automation-section-title">
        <div>
          <h2>General preferences</h2>
          <p>
            New rules and AniList tracking start from these settings. Existing rules keep their own;
            edit a rule to change it.
          </p>
        </div>
      </header>
      {error && !busy ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <FieldSet aria-label="General preferences" className="rule-fields" disabled={busy}>
        <PreferenceFields
          idPrefix="preferences"
          onChange={(next) => {
            setValue(next);
            setSaved(false);
          }}
          value={value}
        />
      </FieldSet>
      <footer className="preferences-actions">
        <p aria-live="polite" className="settings-feedback" id="preferences-feedback" role="status">
          {saved
            ? "Preferences saved. New rules will start from them."
            : dirty
              ? "Unsaved changes"
              : null}
        </p>
        <Button
          disabled={busy || !dirty}
          onClick={() => {
            reset(form, { initialInput: preferences });
            setSaved(false);
          }}
          type="button"
          variant="ghost"
        >
          Discard changes
        </Button>
        <Button disabled={busy || !dirty || !value.sources.length} type="submit">
          {busy ? (
            <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
          ) : (
            <CheckIcon data-icon="inline-start" />
          )}
          {busy ? "Saving…" : "Save preferences"}
        </Button>
      </footer>
    </Form>
  );
}
