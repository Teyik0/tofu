import { getInput, reset } from "@formisch/react";
import type { PluginForm } from "../types";

export function confirmPluginConfiguration(
  form: PluginForm,
  configuration: { apiKey?: string; dailyLimit: number }
) {
  if ((getInput(form, { path: ["apiKey"] }) ?? "").trim() === configuration.apiKey) {
    reset(form, { initialInput: "", path: ["apiKey"] });
  }
  reset(form, {
    initialInput: String(configuration.dailyLimit),
    keepInput: Number(getInput(form, { path: ["dailyLimit"] })) !== configuration.dailyLimit,
    path: ["dailyLimit"],
  });
}
