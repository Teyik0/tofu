import { furinSync } from "@teyik0/furin/sync";
import { Elysia, t } from "elysia";
import type { AniListCatalogFilters } from "../../types";
import { type CoreDependencies, createCore, unavailableAutomation } from "../core";
import { catalogSchema } from "./anilist-catalog";
import { draft, listStatus, organization } from "./schemas";

export function createAniListApi(dependencies: CoreDependencies) {
  const { automation, sync } = dependencies;
  const service = automation ?? unavailableAutomation;
  return new Elysia({ name: "tofu-anilist-api", prefix: "/api" })
    .use(createCore(dependencies))
    .use(furinSync(sync))
    .guard({ sync: false })
    .get("/anilist", () => service().anilist.snapshot())
    .post("/anilist/catalog", { body: catalogSchema }, ({ body }) =>
      service().anilist.catalog(body as AniListCatalogFilters)
    )
    .get("/anilist/catalog/options", () => service().anilist.catalogOptions())
    .post(
      "/anilist/entries/:mediaId/releases",
      { params: t.Object({ mediaId: t.Numeric({ minimum: 1, multipleOf: 1 }) }) },
      ({ params }) => service().animeReleases(params.mediaId)
    )
    .put(
      "/anilist/entries/:mediaId/automation",
      { body: draft, params: t.Object({ mediaId: t.Numeric({ minimum: 1, multipleOf: 1 }) }) },
      ({ params, body }) => service().anilist.saveAutomation(params.mediaId, body)
    )
    .put(
      "/anilist/entries/:mediaId/episodes/:episode",
      {
        body: t.Object({ completed: t.Boolean() }),
        params: t.Object({
          episode: t.Numeric({ maximum: 10_000, minimum: 1, multipleOf: 1 }),
          mediaId: t.Numeric({ minimum: 1, multipleOf: 1 }),
        }),
      },
      ({ params, body }) =>
        service().anilist.completeEpisode(params.mediaId, params.episode, body.completed)
    )
    .put(
      "/anilist/preferences",
      {
        body: t.Object({
          visibleStatuses: t.Array(listStatus, { maxItems: 6, uniqueItems: true }),
        }),
      },
      ({ body }) => service().anilist.preferences(body.visibleStatuses)
    )
    .post(
      "/anilist/threads/preview",
      {
        body: t.Object({
          basePath: t.String({ maxLength: 4096, minLength: 1 }),
          statuses: t.Array(listStatus, {
            maxItems: 6,
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
        params: t.Object({ mediaId: t.Numeric({ minimum: 1, multipleOf: 1 }) }),
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
          clientId: t.Optional(t.String({ maxLength: 50 })),
          clientSecret: t.Optional(t.String({ maxLength: 4096 })),
          redirectUri: t.Optional(t.String({ maxLength: 500 })),
          userName: t.String({ maxLength: 100 }),
        }),
      },
      ({ body }) => service().anilist.configure(body)
    )
    .post("/anilist/connect", () => service().anilist.connect())
    .post(
      "/anilist/callback",
      { body: t.Object({ url: t.String({ maxLength: 8192 }) }) },
      ({ body }) => service().anilist.receiveAuthorizationUrl(body.url)
    )
    .delete("/anilist/connect", () => service().anilist.cancelAuthorization())
    .post("/anilist/list", () => service().anilist.list())
    .post(
      "/anilist/subscriptions",
      {
        body: t.Object({
          enabled: t.Boolean(),
          intervalMinutes: t.Integer({ maximum: 1440, minimum: 5 }),
          organization: t.Optional(organization),
          statuses: t.Array(listStatus, {
            maxItems: 6,
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
    .delete("/anilist/subscriptions/:id", ({ params }) => service().anilist.remove(params.id));
}
