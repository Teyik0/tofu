import { Schema } from "effect";
import { automationDraftSchema, listStatusSchema } from "../automation/persistence";

const strings = Schema.Array(Schema.String).pipe(Schema.mutable);
const numbers = Schema.Array(Schema.Number).pipe(Schema.mutable);
const statuses = Schema.Array(listStatusSchema).pipe(Schema.mutable);
const date = Schema.Struct({
  day: Schema.NullOr(Schema.Number),
  month: Schema.NullOr(Schema.Number),
  year: Schema.NullOr(Schema.Number),
});
const account = Schema.Struct({ id: Schema.Number, name: Schema.String });
const entry = Schema.Struct({
  airingStatus: Schema.optional(Schema.NullOr(Schema.String)),
  aliases: strings,
  automationId: Schema.NullOr(Schema.String),
  averageScore: Schema.optional(Schema.NullOr(Schema.Number)),
  bannerImage: Schema.NullOr(Schema.String),
  completedEpisodes: numbers,
  countryOfOrigin: Schema.optional(Schema.NullOr(Schema.String)),
  coverColor: Schema.optional(Schema.NullOr(Schema.String)),
  coverImage: Schema.NullOr(Schema.String),
  duration: Schema.optional(Schema.NullOr(Schema.Number)),
  endDate: Schema.optional(Schema.NullOr(date)),
  episodes: Schema.NullOr(Schema.Number),
  favourites: Schema.optional(Schema.NullOr(Schema.Number)),
  format: Schema.NullOr(Schema.String),
  genres: strings,
  isAdult: Schema.optional(Schema.NullOr(Schema.Boolean)),
  isLicensed: Schema.optional(Schema.NullOr(Schema.Boolean)),
  mediaId: Schema.Number,
  nextAiringEpisode: Schema.optional(
    Schema.NullOr(Schema.Struct({ airingAt: Schema.Number, episode: Schema.Number }))
  ),
  popularity: Schema.optional(Schema.NullOr(Schema.Number)),
  progress: Schema.Number,
  releaseDate: Schema.optional(Schema.NullOr(date)),
  season: Schema.NullOr(Schema.Literals(["FALL", "SPRING", "SUMMER", "WINTER"])),
  seasonYear: Schema.NullOr(Schema.Number),
  siteUrl: Schema.NullOr(Schema.String),
  source: Schema.optional(Schema.NullOr(Schema.String)),
  startDate: Schema.optional(Schema.NullOr(Schema.Number)),
  status: listStatusSchema,
  streamingOn: Schema.optional(numbers),
  studios: Schema.optional(strings),
  tags: Schema.optional(
    Schema.Array(
      Schema.Struct({ isAdult: Schema.Boolean, name: Schema.String, rank: Schema.Number })
    ).pipe(Schema.mutable)
  ),
  title: Schema.String,
  trending: Schema.optional(Schema.NullOr(Schema.Number)),
});

export const decodeAniListConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      clientId: Schema.optional(Schema.String),
      clientSecret: Schema.optional(Schema.String),
      redirectUri: Schema.optional(Schema.String),
      userName: Schema.optional(Schema.String),
    })
  )
);
export const decodeAniListAccount = Schema.decodeUnknownSync(Schema.fromJsonString(account));
export const decodeAniListStatuses = Schema.decodeUnknownSync(Schema.fromJsonString(statuses));
export const decodeAniListRule = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.String));
export const decodeAniListWatched = Schema.decodeUnknownSync(Schema.fromJsonString(numbers));
export const decodeAniListSelection = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Boolean)
);
export const decodeAniListCache = Schema.decodeUnknownResult(
  Schema.fromJsonString(
    Schema.Struct({
      account,
      entries: Schema.Array(entry).pipe(Schema.mutable),
      key: Schema.String,
      updatedAt: Schema.Number,
    })
  )
);
export const decodeAniListSubscription = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      bindings: Schema.Array(
        Schema.Struct({ active: Schema.Boolean, mediaId: Schema.Number, ruleId: Schema.String })
      ).pipe(Schema.mutable),
      enabled: Schema.Boolean,
      error: Schema.NullOr(Schema.String),
      id: Schema.String,
      intervalMinutes: Schema.Number,
      lastSyncAt: Schema.NullOr(Schema.Number),
      nextSyncAt: Schema.NullOr(Schema.Number),
      organization: Schema.optional(
        Schema.Union([
          Schema.Struct({ mode: Schema.Literal("shared") }),
          Schema.Struct({
            basePath: Schema.String,
            mode: Schema.Literal("per-anime"),
            overrides: Schema.Array(
              Schema.Struct({
                destinationId: Schema.NullOr(Schema.String),
                downloadPath: Schema.String,
                mediaId: Schema.Number,
                name: Schema.String,
              })
            ).pipe(Schema.mutable),
          }),
        ])
      ),
      statuses,
      template: automationDraftSchema,
      userId: Schema.optional(Schema.Number),
    })
  )
);
