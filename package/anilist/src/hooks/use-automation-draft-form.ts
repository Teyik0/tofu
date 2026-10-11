import { getDeepError, useField, useForm, validate } from "@formisch/react";
import { draft as draftSchema } from "@tofu/plugins/automation-model";
import type { AutomationDraft } from "@tofu/plugins/domain";
import { nullable, object } from "valibot";

const schema = object({ draft: nullable(draftSchema) });

export function useAutomationDraftForm(initialDraft: AutomationDraft | null) {
  const form = useForm({ initialInput: { draft: initialDraft }, schema });
  const field = useField(form, { path: ["draft"] });
  // Drafts come from the API and the editor writes their complete shape on every change.
  const draft = field.input as AutomationDraft | null;
  const setDraft = (value: AutomationDraft | null) => field.onChange(value);
  const validatedDraft = async () => {
    const result = await validate(form, { shouldFocus: true });
    return result.success ? result.output.draft : null;
  };
  return { draft, error: getDeepError(form), setDraft, validatedDraft };
}
