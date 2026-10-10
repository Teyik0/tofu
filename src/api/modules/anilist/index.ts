import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import type { AniListCatalogFilters } from "../../../types";
import { contextPlugin } from "../../lib/context";
import { draft } from "../automation/model";
import { catalogSchema } from "./catalog";
import {
  aniListConfigurationSchema,
  aniListPreferencesSchema,
  authorizationCallbackSchema,
  enabledSchema,
  episodeCompletionSchema,
  episodeParamsSchema,
  mediaParamsSchema,
  selectionSchema,
  subscriptionSchema,
  threadPreviewSchema,
} from "./model";

const invalidateLibrary = { path: "/anilist", type: "page" } as const;

export const anilistPlugin = new Elysia({ name: "tofu-anilist-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .use(furinInvalidate())
  .guard({ sync: false })
  .get("/anilist", { sync: { id: "tofu.anilist", scope: {} } }, ({ application, defer }) => {
    const { anilist: library } = application.automation;
    if (library.needsRefresh()) {
      defer(() => library.refresh().catch(() => undefined));
    }
    return library.snapshot();
  })
  .post("/anilist/catalog", { body: catalogSchema }, ({ application, body }) =>
    application.automation.anilist.catalog(body as AniListCatalogFilters)
  )
  .get("/anilist/catalog/options", ({ application }) =>
    application.automation.anilist.catalogOptions()
  )
  .post(
    "/anilist/entries/:mediaId/releases",
    { params: mediaParamsSchema },
    ({ application, params }) => application.automation.animeReleases(params.mediaId)
  )
  .put(
    "/anilist/entries/:mediaId/automation",
    {
      body: draft,
      params: mediaParamsSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ application, params, body, mutation }) => {
      const service = application.automation;
      const input = service.anilist.prepareAutomation(params.mediaId, body);
      const prepared = await service.prepareRule(input.id, input.draft);
      const result = await mutation((tx) => {
        const rule = service.writeRule(tx, prepared);
        service.anilist.writeAutomationLink(tx, input, rule.id);
        return rule;
      });
      service.refreshState();
      service.anilist.refreshState();
      return result;
    }
  )
  .put(
    "/anilist/entries/:mediaId/episodes/:episode",
    {
      body: episodeCompletionSchema,
      invalidate: invalidateLibrary,
      params: episodeParamsSchema,
    },
    ({ application, params, body }) =>
      application.automation.anilist.completeEpisode(params.mediaId, params.episode, body.completed)
  )
  .put(
    "/anilist/preferences",
    {
      body: aniListPreferencesSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ application, body, mutation }) => {
      const library = application.automation.anilist;
      const result = await mutation((tx) => library.writePreferences(tx, body.visibleStatuses));
      library.refreshState();
      return result;
    }
  )
  .post(
    "/anilist/threads/preview",
    {
      body: threadPreviewSchema,
    },
    ({ application, body }) =>
      application.automation.anilist.previewThreads(body.basePath, body.statuses)
  )
  .put(
    "/anilist/entries/:mediaId",
    {
      body: enabledSchema,
      params: mediaParamsSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ application, params, body, mutation }) => {
      const service = application.automation;
      const result = await mutation((tx) =>
        service.anilist.writeSelection(tx, [params.mediaId], body.enabled)
      );
      service.refreshState();
      service.anilist.refreshState();
      return result;
    }
  )
  .put(
    "/anilist/selection",
    {
      body: selectionSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ application, body, mutation }) => {
      const service = application.automation;
      const result = await mutation((tx) =>
        service.anilist.writeSelection(tx, body.mediaIds, body.enabled)
      );
      service.refreshState();
      service.anilist.refreshState();
      return result;
    }
  )
  .put(
    "/anilist",
    {
      body: aniListConfigurationSchema,
      invalidate: invalidateLibrary,
    },
    ({ application, body }) => application.automation.anilist.configure(body)
  )
  .post("/anilist/connect", { invalidate: invalidateLibrary }, ({ application }) =>
    application.automation.anilist.connect()
  )
  .post(
    "/anilist/callback",
    { body: authorizationCallbackSchema, invalidate: invalidateLibrary },
    ({ application, body }) => application.automation.anilist.receiveAuthorizationUrl(body.url)
  )
  .delete("/anilist/connect", { invalidate: invalidateLibrary }, ({ application }) =>
    application.automation.anilist.cancelAuthorization()
  )
  .post("/anilist/list", { invalidate: invalidateLibrary }, ({ application }) =>
    application.automation.anilist.list()
  )
  .post("/anilist/refresh", { invalidate: invalidateLibrary }, ({ application }) =>
    application.automation.anilist.refresh()
  )
  .post(
    "/anilist/subscriptions",
    {
      body: subscriptionSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ application, body, mutation }) => {
      const library = application.automation.anilist;
      const result = await mutation((tx) => library.writeSubscription(tx, body));
      library.refreshState();
      return result;
    }
  )
  .post(
    "/anilist/subscriptions/:id/sync",
    { invalidate: invalidateLibrary },
    ({ application, params }) => application.automation.anilist.sync(params.id)
  )
  .put(
    "/anilist/subscriptions/:id",
    {
      body: enabledSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ application, params, body, mutation }) => {
      const service = application.automation;
      const result = await mutation((tx) =>
        service.anilist.writeToggle(tx, params.id, body.enabled)
      );
      service.refreshState();
      service.anilist.refreshState();
      return result;
    }
  )
  .delete(
    "/anilist/subscriptions/:id",
    {
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ application, params, mutation }) => {
      const service = application.automation;
      const result = await mutation((tx) => service.anilist.deleteSubscription(tx, params.id));
      service.refreshState();
      service.anilist.refreshState();
      return result;
    }
  );
