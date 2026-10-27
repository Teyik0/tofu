import {
  array,
  integer,
  maxLength,
  minLength,
  minValue,
  nullable,
  number,
  object,
  optional,
  pipe,
  string,
} from "valibot";

export const availabilityQuerySchema = object({
  episodeOffset: optional(nullable(pipe(number(), integer(), minValue(0)))),
  episodes: pipe(array(pipe(number(), integer(), minValue(0))), maxLength(500)),
  infoHashes: pipe(array(pipe(string(), maxLength(64))), maxLength(500)),
  key: pipe(string(), maxLength(128)),
  part: optional(nullable(pipe(number(), integer(), minValue(1)))),
  season: nullable(pipe(number(), integer(), minValue(0))),
  titles: pipe(array(pipe(string(), maxLength(300))), minLength(1), maxLength(12)),
});

/** Sent by a linked server: one batch per anime, never one request per episode card. */
export const availabilityBatchSchema = object({
  queries: pipe(array(availabilityQuerySchema), maxLength(20)),
});

/** Sent by this server's AniList UI; `mediaId` lets the server build the search plan itself. */
export const linkedAvailabilitySchema = object({
  ...availabilityQuerySchema.entries,
  mediaId: optional(pipe(number(), integer(), minValue(1))),
});

export const linkServerSchema = object({
  address: pipe(string(), minLength(1), maxLength(2048)),
  code: optional(pipe(string(), maxLength(32))),
  label: pipe(string(), minLength(1), maxLength(64)),
  secret: optional(pipe(string(), maxLength(64))),
});

export const linkedPlaySchema = object({
  fileIndex: pipe(number(), integer(), minValue(0)),
  torrentId: pipe(string(), maxLength(64)),
});

export const linkedPlaybackRevokeSchema = object({ playbackId: pipe(string(), maxLength(64)) });
