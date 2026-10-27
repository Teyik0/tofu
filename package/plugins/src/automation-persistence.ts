import { Effect, Schema, Struct } from "effect";
import { releaseSchema } from "./discovery-persistence";

export const listStatusSchema = Schema.Literals([
  "CURRENT",
  "PLANNING",
  "COMPLETED",
  "PAUSED",
  "DROPPED",
  "REPEATING",
]);
const strings = Schema.Array(Schema.String).pipe(Schema.mutable);
const preferencesFields = {
  automatic: Schema.Boolean,
  codecs: strings,
  deleteReplacedFiles: Schema.Boolean,
  excludePacks: Schema.Boolean,
  intervalMinutes: Schema.Number,
  languages: Schema.Array(Schema.Literals(["VF", "VOSTFR", "MULTI"])).pipe(Schema.mutable),
  paused: Schema.Boolean,
  priority: Schema.Array(Schema.Literals(["language", "resolution", "source", "codec"])).pipe(
    Schema.mutable
  ),
  resolutions: strings,
  sources: strings,
  waitMinutes: Schema.Number,
};
export const automationDraftSchema = Schema.Struct({
  ...preferencesFields,
  afterEpisode: Schema.optional(Schema.Number),
  aliases: Schema.optional(strings),
  anilistId: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  deleteReplacedFiles: Schema.optional(Schema.Boolean),
  destinationId: Schema.String,
  enabled: Schema.Boolean,
  episodeCount: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  includeExisting: Schema.Boolean,
  matchMode: Schema.Literals(["exact", "pattern"]),
  query: Schema.String,
  season: Schema.NullOr(Schema.Number),
  title: Schema.String,
});
const ruleSchema = Schema.Struct({
  ...automationDraftSchema.fields,
  createdAt: Schema.Number,
  error: Schema.NullOr(Schema.String),
  executorId: Schema.optional(Schema.String),
  id: Schema.String,
  key: Schema.optional(Schema.String),
  lastRunAt: Schema.NullOr(Schema.Number),
  nextRunAt: Schema.NullOr(Schema.Number),
  ownerId: Schema.optional(Schema.String),
  revision: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  status: Schema.Literals(["active", "paused", "source-disabled", "running", "error"]),
}).mapFields(Struct.map(Schema.mutableKey));
const decisionSchema = Schema.Struct({
  approved: Schema.optional(Schema.Boolean),
  automationId: Schema.String,
  contentKey: Schema.String,
  createdAt: Schema.Number,
  deadline: Schema.NullOr(Schema.Number),
  id: Schema.String,
  probability: Schema.NullOr(Schema.Number),
  reason: Schema.String,
  release: releaseSchema,
  status: Schema.Literals(["waiting", "review", "adding", "added", "ignored", "error"]),
  supersedes: Schema.optional(
    Schema.NullOr(Schema.Struct({ release: releaseSchema, torrentId: Schema.String }))
  ),
  torrentId: Schema.NullOr(Schema.String),
});

export const decodeAutomationPreferences = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct(preferencesFields).mapFields(Struct.map(Schema.optional)))
);
const decodeRule = Schema.decodeUnknownSync(Schema.fromJsonString(ruleSchema));
const aniListRuleKey = /^anime-rule:\d+:([1-9]\d*)$/;

export function decodeAutomationRule(value: string) {
  const rule = decodeRule(value);
  if (rule.ownerId === "tofu.anilist" && rule.anilistId === undefined) {
    const mediaId = Number(rule.key?.match(aniListRuleKey)?.[1]);
    if (Number.isSafeInteger(mediaId) && mediaId > 0) {
      return { ...rule, anilistId: mediaId };
    }
  }
  return rule;
}
export const decodeAutomationDecision = Schema.decodeUnknownSync(
  Schema.fromJsonString(decisionSchema)
);
