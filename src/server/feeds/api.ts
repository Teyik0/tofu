import { type FurinSyncOptions, furinSync } from "@teyik0/furin/sync";
import { Elysia, t } from "elysia";
import type { AutomationService } from "./service";

const source = t.Union([t.Literal("nyaa"), t.Literal("tsundere"), t.Literal("c411")]);
const organization = t.Union([
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
const draft = t.Object({
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

export function createAutomationApi(service: () => AutomationService, sync: FurinSyncOptions) {
  return new Elysia()
    .use(furinSync(sync))
    .guard({ sync: false })
    .get("/anilist", () => service().anilist.snapshot())
    .post(
      "/anilist/threads/preview",
      {
        body: t.Object({
          basePath: t.String({ maxLength: 4096, minLength: 1 }),
          statuses: t.Array(t.Union([t.Literal("CURRENT"), t.Literal("PLANNING")]), {
            maxItems: 2,
            minItems: 1,
            uniqueItems: true,
          }),
        }),
      },
      ({ body }) => service().anilist.previewThreads(body.basePath, body.statuses)
    )
    .put(
      "/anilist/entries/:mediaId",
      {
        body: t.Object({ enabled: t.Boolean() }),
        params: t.Object({ mediaId: t.Numeric({ minimum: 1 }) }),
      },
      ({ params, body }) => service().anilist.select([params.mediaId], body.enabled)
    )
    .put(
      "/anilist/selection",
      {
        body: t.Object({
          enabled: t.Boolean(),
          mediaIds: t.Array(t.Integer({ minimum: 1 }), {
            maxItems: 500,
            minItems: 1,
            uniqueItems: true,
          }),
        }),
      },
      ({ body }) => service().anilist.select(body.mediaIds, body.enabled)
    )
    .put(
      "/anilist",
      {
        body: t.Object({
          clientId: t.String({ maxLength: 50 }),
          clientSecret: t.Optional(t.String({ maxLength: 4096 })),
          redirectUri: t.String({ maxLength: 500 }),
          userName: t.String({ maxLength: 100 }),
        }),
      },
      ({ body }) => service().anilist.configure(body)
    )
    .post("/anilist/connect", () => service().anilist.connect())
    .post("/anilist/list", () => service().anilist.list())
    .post(
      "/anilist/subscriptions",
      {
        body: t.Object({
          enabled: t.Boolean(),
          intervalMinutes: t.Integer({ maximum: 1440, minimum: 5 }),
          organization: t.Optional(organization),
          statuses: t.Array(t.Union([t.Literal("CURRENT"), t.Literal("PLANNING")]), {
            maxItems: 2,
            minItems: 1,
            uniqueItems: true,
          }),
          template: draft,
        }),
      },
      ({ body }) => service().anilist.subscribe(body)
    )
    .post("/anilist/subscriptions/:id/sync", ({ params }) => service().anilist.sync(params.id))
    .put(
      "/anilist/subscriptions/:id",
      { body: t.Object({ enabled: t.Boolean() }) },
      ({ params, body }) => service().anilist.toggle(params.id, body.enabled)
    )
    .delete("/anilist/subscriptions/:id", ({ params }) => service().anilist.remove(params.id))
    .get("/automation", { sync: { id: "tofu.automation", scope: {} } }, () => service().snapshot())
    .post(
      "/automations/interpret",
      {
        body: t.Object({
          destinationId: t.String(),
          query: t.String({ maxLength: 2000, minLength: 1 }),
        }),
      },
      ({ body }) => service().interpret(body.query, body.destinationId)
    )
    .post("/automations/preview", { body: draft }, ({ body }) => service().preview(body))
    .post("/automations", { body: draft }, ({ body }) => service().save(null, body))
    .put("/automations/:id", { body: draft }, ({ params, body }) => service().save(params.id, body))
    .delete("/automations/:id", ({ params }) => service().remove(params.id))
    .post("/automations/:id/run", ({ params }) => service().run(params.id))
    .post("/automation-decisions/:id/approve", ({ params }) => service().approve(params.id))
    .post("/automation-decisions/:id/ignore", ({ params }) => service().ignore(params.id))
    .post(
      "/discover",
      {
        body: t.Object({
          query: t.String({ maxLength: 1000 }),
          sources: t.Optional(
            t.Array(t.Union([t.Literal("nyaa"), t.Literal("tsundere"), t.Literal("c411")]), {
              maxItems: 3,
            })
          ),
        }),
      },
      ({ body }) => service().discover(body.query, body.sources)
    )
    .post(
      "/discover/add",
      {
        body: t.Object({
          destinationId: t.String(),
          id: t.String({ maxLength: 4096 }),
          paused: t.Boolean(),
          sourceId: source,
        }),
      },
      ({ body }) => service().addRelease(body.sourceId, body.id, body.destinationId, body.paused)
    )
    .post("/plugins/:id/test", ({ params }) => service().testPlugin(params.id))
    .put(
      "/plugins/:id",
      {
        body: t.Object({
          apiKey: t.Optional(t.String({ maxLength: 4096 })),
          dailyLimit: t.Optional(t.Integer({ maximum: 100_000, minimum: 1 })),
          enabled: t.Boolean(),
        }),
      },
      ({ params, body }) => service().configure(params.id, body)
    );
}
