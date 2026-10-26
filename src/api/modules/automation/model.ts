import type { InferOutput } from "valibot";
import {
  array,
  boolean,
  check,
  forward,
  integer,
  literal,
  maxLength,
  maxValue,
  minLength,
  minValue,
  null as nullSchema,
  object,
  optional,
  partialCheck,
  pipe,
  regex,
  string,
  union,
} from "valibot";
import { integerInput } from "../../lib/validation";
import type { FeedRelease } from "../discovery/model";
import type { PluginState } from "../plugins/model";

export const source = pipe(string(), minLength(1), maxLength(128), regex(/^[a-z0-9][a-z0-9._-]*$/));
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
    maxLength(32),
    check((items) => new Set(items).size === items.length, "Items must be unique")
  ),
  waitMinutes: pipe(integerInput, integer(), minValue(0), maxValue(1440)),
});
export const draft = pipe(
  object({
    afterEpisode: optional(pipe(integerInput, integer(), minValue(0), maxValue(10_000))),
    aliases: optional(pipe(array(pipe(string(), maxLength(500))), maxLength(30))),
    anilistId: optional(pipe(integerInput, integer(), minValue(1))),
    automatic: boolean(),
    codecs: pipe(array(pipe(string(), maxLength(20))), maxLength(6)),
    deleteReplacedFiles: optional(boolean()),
    destinationId: string(),
    enabled: boolean(),
    episodeCount: optional(pipe(integerInput, integer(), minValue(1))),
    excludePacks: boolean(),
    includeExisting: boolean(),
    intervalMinutes: pipe(integerInput, integer(), minValue(1), maxValue(1440)),
    languages: pipe(array(language), maxLength(3)),
    matchMode: union([literal("exact"), literal("pattern")]),
    paused: boolean(),
    priority: criteria,
    query: pipe(string(), minLength(1), maxLength(2000)),
    resolutions: pipe(array(pipe(string(), maxLength(10))), maxLength(6)),
    season: union([pipe(integerInput, integer(), minValue(0), maxValue(1000)), nullSchema()]),
    sources: pipe(
      array(source),
      minLength(1),
      maxLength(32),
      check((items) => new Set(items).size === items.length, "Items must be unique")
    ),
    title: pipe(string(), minLength(1), maxLength(500)),
    waitMinutes: pipe(integerInput, integer(), minValue(0), maxValue(1440)),
  }),
  forward(
    partialCheck(
      [["matchMode"], ["title"]],
      (input) => input.matchMode !== "pattern" || input.title.length <= 256,
      "Patterns must contain at most 256 characters"
    ),
    ["title"]
  )
);

export interface AutomationState {
  automations: AutomationRule[];
  decisions: AutomationDecision[];
  plugins: PluginState[];
  preferences: AutomationPreferences;
  updatedAt: number;
}

/** Defaults copied into every new rule; each rule can still override them. */
export type AutomationPreferences = InferOutput<typeof preferences>;

export type AutomationCriterion = InferOutput<typeof criteria>[number];

export type AutomationDraft = InferOutput<typeof draft>;

export interface AutomationRule extends AutomationDraft {
  createdAt: number;
  error: string | null;
  executorId?: string;
  id: string;
  key?: string;
  lastRunAt: number | null;
  nextRunAt: number | null;
  ownerId?: string;
  revision: number;
  status: "active" | "paused" | "source-disabled" | "running" | "error";
}

export interface AutomationDecision {
  approved?: boolean;
  automationId: string;
  contentKey: string;
  createdAt: number;
  deadline: number | null;
  id: string;
  probability: number | null;
  reason: string;
  release: FeedRelease;
  status: "waiting" | "review" | "adding" | "added" | "ignored" | "error";
  supersedes?: { release: FeedRelease; torrentId: string } | null;
  torrentId: string | null;
}

export const interpretationSchema = object({
  destinationId: string(),
  query: pipe(string(), minLength(1), maxLength(2000)),
});
