import { getInput, isDirty, reset, useForm } from "@formisch/react";
import { useEffect } from "react";
import { pluginFormSchema } from "../api/modules/plugins/model";
import type { PluginForm, PluginState } from "../types";

function usePluginForm(dailyLimit: number): PluginForm {
  const form = useForm({
    initialInput: { apiKey: "", dailyLimit: String(dailyLimit) },
    schema: pluginFormSchema,
  });
  const dirty = isDirty(form, { path: ["dailyLimit"] });
  useEffect(() => {
    if (!dirty && getInput(form, { path: ["dailyLimit"] }) !== String(dailyLimit)) {
      reset(form, { initialInput: String(dailyLimit), path: ["dailyLimit"] });
    }
  }, [dailyLimit, dirty, form]);
  return form;
}

export function usePluginForms(plugins: PluginState[]) {
  const c411 = usePluginForm(plugins.find((plugin) => plugin.id === "c411")?.dailyLimit ?? 1000);
  const jev = usePluginForm(plugins.find((plugin) => plugin.id === "jev")?.dailyLimit ?? 1000);
  const nyaa = usePluginForm(plugins.find((plugin) => plugin.id === "nyaa")?.dailyLimit ?? 1000);
  const tsundere = usePluginForm(
    plugins.find((plugin) => plugin.id === "tsundere")?.dailyLimit ?? 1000
  );
  const anilist = usePluginForm(
    plugins.find((plugin) => plugin.id === "anilist")?.dailyLimit ?? 1000
  );
  return { anilist, c411, jev, nyaa, tsundere };
}
