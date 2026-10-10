import {
  array,
  boolean,
  check,
  integer,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  null as nullSchema,
  object,
  optional,
  pipe,
  string,
  union,
} from "valibot";
import { integerInput } from "../../lib/validation";

export const source = union([literal("nyaa"), literal("tsundere"), literal("c411")]);
export const listStatus = union([
  literal("CURRENT"),
  literal("PLANNING"),
  literal("COMPLETED"),
  literal("PAUSED"),
  literal("DROPPED"),
  literal("REPEATING"),
]);
export const organization = union([
  object({ mode: literal("shared") }),
  object({
    basePath: pipe(string(), minLength(1), maxLength(4096)),
    mode: literal("per-anime"),
    overrides: pipe(
      array(
        object({
          destinationId: union([string(), nullSchema()]),
          downloadPath: pipe(string(), minLength(1), maxLength(4096)),
          mediaId: pipe(integerInput, integer(), minValue(1)),
          name: pipe(string(), minLength(1), maxLength(500)),
        })
      ),
      maxLength(500)
    ),
  }),
]);
export const language = union([literal("VF"), literal("VOSTFR"), literal("MULTI")]);
export const criteria = pipe(
  array(union([literal("language"), literal("resolution"), literal("source"), literal("codec")])),
  minLength(4),
  maxLength(4),
  check((items) => new Set(items).size === items.length, "Items must be unique")
);
export const preferences = object({
  automatic: boolean(),
  codecs: pipe(
    array(pipe(string(), maxLength(20))),
    maxLength(6),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  ),
  deleteReplacedFiles: boolean(),
  excludePacks: boolean(),
  intervalMinutes: pipe(integerInput, integer(), minValue(1), maxValue(1440)),
  languages: pipe(
    array(language),
    maxLength(3),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  ),
  paused: boolean(),
  priority: criteria,
  resolutions: pipe(
    array(pipe(string(), maxLength(10))),
    maxLength(6),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  ),
  sources: pipe(
    array(source),
    minLength(1),
    maxLength(3),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  ),
  waitMinutes: pipe(integerInput, integer(), minValue(0), maxValue(1440)),
});
export const draft = object({
  afterEpisode: optional(pipe(integerInput, integer(), minValue(0), maxValue(10_000))),
  aliases: optional(pipe(array(pipe(string(), maxLength(500))), maxLength(30))),
  automatic: boolean(),
  codecs: pipe(array(pipe(string(), maxLength(20))), maxLength(6)),
  deleteReplacedFiles: optional(boolean()),
  destinationId: string(),
  enabled: boolean(),
  excludePacks: boolean(),
  includeExisting: boolean(),
  intervalMinutes: pipe(integerInput, integer(), minValue(1), maxValue(1440)),
  languages: pipe(array(language), maxLength(3)),
  matchMode: union([literal("exact"), literal("pattern"), literal("jev")]),
  paused: boolean(),
  priority: criteria,
  query: pipe(string(), minLength(1), maxLength(2000)),
  resolutions: pipe(array(pipe(string(), maxLength(10))), maxLength(6)),
  season: union([pipe(integerInput, integer(), minValue(1), maxValue(1000)), nullSchema()]),
  sources: pipe(
    array(source),
    minLength(1),
    maxLength(3),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  ),
  title: pipe(string(), minLength(1), maxLength(500)),
  waitMinutes: pipe(integerInput, integer(), minValue(0), maxValue(1440)),
});
