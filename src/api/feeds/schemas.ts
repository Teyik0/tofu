import { t } from "elysia";

export const source = t.Union([t.Literal("nyaa"), t.Literal("tsundere"), t.Literal("c411")]);
export const listStatus = t.Union([
  t.Literal("CURRENT"),
  t.Literal("PLANNING"),
  t.Literal("COMPLETED"),
  t.Literal("PAUSED"),
  t.Literal("DROPPED"),
  t.Literal("REPEATING"),
]);
export const organization = t.Union([
  t.Object({ mode: t.Literal("shared") }),
  t.Object({
    basePath: t.String({ maxLength: 4096, minLength: 1 }),
    mode: t.Literal("per-anime"),
    overrides: t.Array(
      t.Object({
        destinationId: t.Union([t.String(), t.Null()]),
        downloadPath: t.String({ maxLength: 4096, minLength: 1 }),
        mediaId: t.Integer({ minimum: 1 }),
        name: t.String({ maxLength: 500, minLength: 1 }),
      }),
      { maxItems: 500 }
    ),
  }),
]);
export const draft = t.Object({
  afterEpisode: t.Optional(t.Integer({ maximum: 10_000, minimum: 0 })),
  aliases: t.Optional(t.Array(t.String({ maxLength: 500 }), { maxItems: 30 })),
  automatic: t.Boolean(),
  codecs: t.Array(t.String({ maxLength: 20 }), { maxItems: 6 }),
  deleteReplacedFiles: t.Optional(t.Boolean()),
  destinationId: t.String(),
  enabled: t.Boolean(),
  excludePacks: t.Boolean(),
  includeExisting: t.Boolean(),
  intervalMinutes: t.Integer({ maximum: 1440, minimum: 1 }),
  languages: t.Array(t.Union([t.Literal("VF"), t.Literal("VOSTFR"), t.Literal("MULTI")]), {
    maxItems: 3,
  }),
  matchMode: t.Union([t.Literal("exact"), t.Literal("pattern"), t.Literal("jev")]),
  paused: t.Boolean(),
  priority: t.Array(
    t.Union([
      t.Literal("language"),
      t.Literal("resolution"),
      t.Literal("source"),
      t.Literal("codec"),
    ]),
    { maxItems: 4, minItems: 4, uniqueItems: true }
  ),
  query: t.String({ maxLength: 2000, minLength: 1 }),
  resolutions: t.Array(t.String({ maxLength: 10 }), { maxItems: 6 }),
  season: t.Union([t.Integer({ maximum: 1000, minimum: 1 }), t.Null()]),
  sources: t.Array(source, { maxItems: 3, minItems: 1, uniqueItems: true }),
  title: t.String({ maxLength: 500, minLength: 1 }),
  waitMinutes: t.Integer({ maximum: 1440, minimum: 0 }),
});
