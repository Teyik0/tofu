import type { InferOutput } from "valibot";
import {
  boolean,
  integer,
  maxLength,
  maxValue,
  minValue,
  nonEmpty,
  number,
  object,
  optional,
  pipe,
  string,
  toNumber,
} from "valibot";

import { integerInput } from "./validation";

const dailyLimit = pipe(number(), integer(), minValue(1), maxValue(100_000));

export const pluginConfigurationSchema = object({
  apiKey: optional(pipe(string(), maxLength(4096))),
  dailyLimit: optional(pipe(integerInput, dailyLimit)),
  enabled: boolean(),
});

export const pluginFormSchema = object({
  apiKey: pluginConfigurationSchema.entries.apiKey.wrapped,
  dailyLimit: pipe(string(), nonEmpty("Enter a daily call limit"), toNumber(), dailyLimit),
});

export const pluginCredentialPages: Record<CredentialPluginId, string> = {
  c411: "https://c411.org/user/integrations",
};

export type SourcePluginId = string;

export type PluginId = SourcePluginId | "anilist";

export type CredentialPluginId = "c411";

export interface StoredPlugin extends PluginState {
  apiKey: string;
  callsDay: string;
}

export interface PluginState {
  callsToday: number;
  checkedAt: number | null;
  dailyLimit: number;
  description: string;
  enabled: boolean;
  error: string | null;
  hasApiKey: boolean;
  id: PluginId;
  name: string;
}

export type PluginConfiguration = InferOutput<typeof pluginConfigurationSchema>;
