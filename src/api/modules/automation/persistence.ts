import { Effect, Schema, Struct } from "effect";
import { releaseSchema } from "../discovery/persistence";

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
  deleteReplacedFiles: Schema.optional(Schema.Boolean),
  destinationId: Schema.String,
  enabled: Schema.Boolean,
  includeExisting: Schema.Boolean,
  matchMode: Schema.Literals(["exact", "pattern", "jev"]),
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
export const decodeAutomationRule = Schema.decodeUnknownSync(Schema.fromJsonString(ruleSchema));
export const decodeAutomationDecision = Schema.decodeUnknownSync(
  Schema.fromJsonString(decisionSchema)
);
