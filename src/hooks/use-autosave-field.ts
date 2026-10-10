import { getDeepError, handleSubmit, reset, useField, useForm } from "@formisch/react";
import { useEffect, useState } from "react";
import { type GenericSchema, object } from "valibot";

export function useAutosaveField<Output>(
  schema: GenericSchema<string, Output>,
  savedValue: string,
  onSave: (value: Output) => Promise<string>
) {
  const form = useForm({
    initialInput: { value: savedValue },
    schema: object({ value: schema }),
  });
  const field = useField(form, { path: ["value"] });
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if ((!form.isDirty || field.input === savedValue) && !form.isSubmitting) {
      reset(form, { initialInput: { value: savedValue } });
    }
  }, [field, form, savedValue]);
  const save = handleSubmit(form, async ({ value }) => {
    const submitted = field.input;
    setSaveError(null);
    try {
      const confirmed = await onSave(value);
      reset(form, {
        initialInput: { value: confirmed },
        keepInput: field.input !== submitted,
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Unable to save this setting");
    }
  });
  const onBlur = () => {
    field.props.onBlur();
    if (form.isDirty && !form.isSubmitting) {
      void save();
    }
  };
  return { error: getDeepError(form) ?? saveError, field, onBlur };
}
