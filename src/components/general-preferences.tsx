import { useMutation, useQuery } from "@teyik0/furin/client";
import { CheckIcon, LoaderCircleIcon } from "lucide-react";
import { startTransition, useActionState, useState } from "react";
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
  const [draft, setDraft] = useState<AutomationPreferences | null>(null);
  const [saved, setSaved] = useState(false);
  const preferences = live && "preferences" in live ? live.preferences : initialPreferences;
  const value = draft ?? preferences;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(preferences);
  const [error, save, busy] = useActionState<string | null, AutomationPreferences>(
    async (_previous, next) => {
      try {
        await savePreferences.mutateAsync(next);
        setDraft(null);
        setSaved(true);
        return null;
      } catch (cause) {
        return cause instanceof Error ? cause.message : "Unable to save preferences";
      }
    },
    null
  );

  return (
    <form
      className="automation-section general-preferences"
      id="preferences-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (dirty && !busy && value.sources.length) {
          setSaved(false);
          startTransition(() => save(value));
        }
      }}
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
            setDraft(next);
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
            setDraft(null);
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
    </form>
  );
}
