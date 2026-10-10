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
import { integerInput } from "../../lib/validation";

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
