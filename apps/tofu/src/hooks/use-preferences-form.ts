import { getInput, isDirty, reset, setInput, useForm } from "@formisch/react";
import { useEffect } from "react";
import { preferences as preferencesSchema } from "../api/modules/automation/model";
import type { AutomationPreferences } from "../types";

export function usePreferencesForm(preferences: AutomationPreferences) {
  const form = useForm({ initialInput: preferences, schema: preferencesSchema });
  const dirty = isDirty(form);
  useEffect(() => {
    if (!dirty && JSON.stringify(getInput(form)) !== JSON.stringify(preferences)) {
      reset(form, { initialInput: preferences });
    }
  }, [dirty, form, preferences]);

  // The editor initializes every field and always writes complete preference objects.
  const value = getInput(form) as AutomationPreferences;
  const setValue = (input: AutomationPreferences) => setInput(form, { input });
  return { form, setValue, value };
}
