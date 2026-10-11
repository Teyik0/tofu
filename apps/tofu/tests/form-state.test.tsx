import { expect, test } from "bun:test";
import { getInput, reset, setInput, validate } from "@formisch/react";
import { renderToStaticMarkup } from "react-dom/server";
import { bandwidthInputSchema } from "../src/api/modules/settings/model";
import { useAutomationDraftForm } from "../src/hooks/use-automation-draft-form";
import { useAutosaveField } from "../src/hooks/use-autosave-field";
import { usePluginForms } from "../src/hooks/use-plugin-forms";
import { usePreferencesForm } from "../src/hooks/use-preferences-form";
import { confirmPluginConfiguration } from "../src/lib/plugin-forms";
import type { AutomationDraft, AutomationPreferences, PluginForms } from "../src/types";
import { waitFor } from "./helpers";

test("an autosaved bandwidth input becomes canonical and does not save again on blur", async () => {
  let editor: ReturnType<typeof useAutosaveField<number>> | undefined;
  let writes = 0;
  function Bandwidth() {
    editor = useAutosaveField(bandwidthInputSchema, "0", (value) => {
      writes += 1;
      return Promise.resolve(String(value / 1024));
    });
    return null;
  }
  renderToStaticMarkup(<Bandwidth />);
  if (!editor) {
    throw new Error("The bandwidth editor did not render");
  }
  const field = editor;
  field.field.onChange("1.234");
  field.onBlur();
  await waitFor(
    () => field.field.input,
    (value) => value === "1.234375"
  );
  expect(field.field.isDirty).toBe(false);
  field.onBlur();
  await Bun.sleep(0);
  expect(writes).toBe(1);
});

const preferences: AutomationPreferences = {
  automatic: true,
  codecs: [],
  deleteReplacedFiles: false,
  excludePacks: true,
  intervalMinutes: 15,
  languages: ["VOSTFR"],
  paused: false,
  priority: ["language", "resolution", "source", "codec"],
  resolutions: [],
  sources: ["nyaa"],
  waitMinutes: 0,
};

function pluginForms() {
  let forms: PluginForms | undefined;
  function Layout() {
    forms = usePluginForms([]);
    return null;
  }
  renderToStaticMarkup(<Layout />);
  if (!forms) {
    throw new Error("The plugin layout did not render");
  }
  return forms;
}

test("plugin layouts preserve unsaved inputs independently and clear only confirmed credentials", () => {
  const forms = pluginForms();
  setInput(forms.jev, { input: { apiKey: "submitted-key", dailyLimit: "42" } });
  const separate = pluginForms();
  expect(getInput(separate.jev)).toEqual({ apiKey: "", dailyLimit: "1000" });
  expect(getInput(forms.c411)).toEqual({ apiKey: "", dailyLimit: "1000" });
  setInput(forms.jev, { input: { apiKey: "new-unsaved-key", dailyLimit: "43" } });
  confirmPluginConfiguration(forms.jev, { apiKey: "submitted-key", dailyLimit: 42 });
  expect(getInput(forms.jev)).toEqual({ apiKey: "new-unsaved-key", dailyLimit: "43" });
  expect(forms.jev.isDirty).toBe(true);
  confirmPluginConfiguration(forms.jev, { apiKey: "new-unsaved-key", dailyLimit: 43 });
  expect(getInput(forms.jev)).toEqual({ apiKey: "", dailyLimit: "43" });
  expect(forms.jev.isDirty).toBe(false);
});

test("a plugin form validates string inputs before producing API numbers", async () => {
  const forms = pluginForms();
  setInput(forms.jev, { input: "", path: ["dailyLimit"] });
  expect((await validate(forms.jev)).success).toBe(false);
  setInput(forms.jev, { input: "42", path: ["dailyLimit"] });
  const result = await validate(forms.jev);
  expect(result.success).toBe(true);
  expect(result.output).toEqual({ apiKey: "", dailyLimit: 42 });
});

test("a confirmed limit normalizes equivalent input and clears the unsaved state", () => {
  const forms = pluginForms();
  setInput(forms.jev, { input: "0042", path: ["dailyLimit"] });
  confirmPluginConfiguration(forms.jev, { dailyLimit: 42 });
  expect(getInput(forms.jev, { path: ["dailyLimit"] })).toBe("42");
  expect(forms.jev.isDirty).toBe(false);
});

test("preferences can be edited, rejected and discarded without changing saved values", async () => {
  let editor: ReturnType<typeof usePreferencesForm> | undefined;
  function Preferences() {
    editor = usePreferencesForm(preferences);
    return null;
  }
  renderToStaticMarkup(<Preferences />);
  if (!editor) {
    throw new Error("Preferences did not render");
  }
  editor.setValue({ ...preferences, sources: [] });
  expect(editor.form.isDirty).toBe(true);
  expect((await validate(editor.form)).success).toBe(false);
  expect(preferences.sources).toEqual(["nyaa"]);
  reset(editor.form, { initialInput: preferences });
  expect(editor.form.isDirty).toBe(false);
  expect((await validate(editor.form)).output).toEqual(preferences);
});

test("a rule editor starts empty and validates complete drafts before saving", async () => {
  let editor: ReturnType<typeof useAutomationDraftForm> | undefined;
  function Rule() {
    editor = useAutomationDraftForm(null);
    return null;
  }
  renderToStaticMarkup(<Rule />);
  if (!editor) {
    throw new Error("The rule editor did not render");
  }
  expect(editor.draft).toBeNull();
  const draft: AutomationDraft = {
    ...preferences,
    destinationId: "default",
    enabled: true,
    includeExisting: false,
    matchMode: "exact",
    query: "Example Show",
    season: null,
    title: "Example Show",
  };
  editor.setDraft({ ...draft, title: "" });
  expect(await editor.validatedDraft()).toBeNull();
  editor.setDraft(draft);
  expect(await editor.validatedDraft()).toEqual(draft);
});
