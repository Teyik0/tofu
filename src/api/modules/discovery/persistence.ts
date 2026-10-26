import { Schema } from "effect";

export const releaseSchema = Schema.Struct({
  anilistId: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
  codec: Schema.NullOr(Schema.String),
  downloadUrl: Schema.String,
  episode: Schema.NullOr(Schema.Number),
  id: Schema.String,
  infoHash: Schema.NullOr(Schema.String),
  language: Schema.NullOr(Schema.Literals(["VF", "VOSTFR", "MULTI"])),
  pack: Schema.Boolean,
  pageUrl: Schema.NullOr(Schema.String),
  privateDownload: Schema.optional(Schema.Boolean),
  publishedAt: Schema.NullOr(Schema.Number),
  resolution: Schema.NullOr(Schema.String),
  season: Schema.NullOr(Schema.Number),
  seeders: Schema.NullOr(Schema.Number),
  size: Schema.NullOr(Schema.Number),
  sourceEpisode: Schema.optional(Schema.Number),
  sourceId: Schema.String,
  title: Schema.String,
  workTitle: Schema.String,
});

export const decodeRelease = Schema.decodeUnknownSync(Schema.fromJsonString(releaseSchema));
