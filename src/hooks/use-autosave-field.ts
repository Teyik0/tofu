import { getDeepError, handleSubmit, reset, useField, useForm } from "@formisch/react";
import { useEffect } from "react";
import { type GenericSchema, object } from "valibot";

export function useAutosaveField<Output>(
  schema: GenericSchema<string, Output>,
  savedValue: string,
  onSave: (value: Output) => void
) {
  const form = useForm({
    initialInput: { value: savedValue },
    schema: object({ value: schema }),
  });
  const field = useField(form, { path: ["value"] });
  useEffect(() => {
    if ((!form.isDirty || field.input === savedValue) && !form.isSubmitting) {
      reset(form, { initialInput: { value: savedValue } });
    }
  }, [field, form, savedValue]);
  const save = handleSubmit(form, ({ value }) => onSave(value));
  const onBlur = () => {
    field.props.onBlur();
    if (field.input !== savedValue) {
      void save();
    }
  };
  return { error: getDeepError(form), field, onBlur };
}
