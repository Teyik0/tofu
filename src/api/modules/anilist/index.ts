import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { Elysia, HTTPError } from "elysia";
import { sync } from "../../../sync";
import type { AniListCatalogFilters } from "../../../types";
import { automationPlugin } from "../automation";
import { draft } from "../automation/model";
import { releaseAutomationPlugin } from "../automation/plugin";
import { catalogSchema } from "./catalog";
import {
  aniListConfigurationSchema,
  aniListEntrySchema,
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
import { anilistServicePlugin } from "./plugin";

const invalidateLibrary = { path: "/anilist", type: "page" } as const;

export const anilistPlugin = new Elysia({ name: "tofu-anilist-api" })
  .use(anilistServicePlugin)
  .use(automationPlugin)
  .use(releaseAutomationPlugin)
  .use(furinSync(sync))
  .use(furinInvalidate())
  .guard({ sync: false })
  .get("/anilist", { sync: { id: "tofu.anilist", scope: {} } }, ({ anilist, defer }) => {
    if (anilist.needsRefresh()) {
      defer(() => anilist.refresh().catch(() => undefined));
    }
    return anilist.snapshot();
  })
  .post("/anilist/catalog", { body: catalogSchema }, ({ anilist, body }) =>
    anilist.catalog(body as AniListCatalogFilters)
  )
  .get("/anilist/catalog/options", ({ anilist }) => anilist.catalogOptions())
  .get("/anilist/entries/:mediaId/editor", { params: mediaParamsSchema }, ({ anilist, params }) =>
    anilist.editor(params.mediaId)
  )
  .put(
    "/anilist/entries/:mediaId/editor",
    {
      body: aniListEntrySchema,
      invalidate: invalidateLibrary,
      params: mediaParamsSchema,
    },
    ({ anilist, params, body }) => anilist.saveEntry(params.mediaId, body)
  )
  .put(
    "/anilist/entries/:mediaId/favourite",
    {
      body: enabledSchema,
      invalidate: invalidateLibrary,
      params: mediaParamsSchema,
    },
    ({ anilist, params, body }) => anilist.favourite(params.mediaId, body.enabled)
  )
  .delete(
    "/anilist/entries/:mediaId/editor",
    {
      invalidate: invalidateLibrary,
      params: mediaParamsSchema,
    },
    ({ anilist, params }) => anilist.deleteEntry(params.mediaId)
  )
  .post(
    "/anilist/entries/:mediaId/releases",
    { params: mediaParamsSchema },
    ({ anilist, params }) => anilist.releases(params.mediaId)
  )
  .put(
    "/anilist/entries/:mediaId/automation",
    {
      body: draft,
      params: mediaParamsSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ anilist, automation, releaseAutomation, torrents, params, body, mutation }) => {
      const input = anilist.prepareAutomation(params.mediaId, body);
      const prepared = await releaseAutomation.prepareRule(input.id, input.draft, {
        key: input.key,
        ownerId: "tofu.anilist",
      });
      const result = await mutation((tx) => {
        if (
          !torrents
            .snapshot(null, false)
            .destinations.some((destination) => destination.id === prepared.rule.destinationId)
        ) {
          throw new (HTTPError.id("BAD_REQUEST", 400))("Unknown destination");
        }
        const rule = automation.writeRule(tx, prepared);
        anilist.writeAutomationLink(tx, input, rule.id);
        return rule;
      });
      automation.refreshState();
      anilist.refreshState();
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
    ({ anilist, params, body }) =>
      anilist.completeEpisode(params.mediaId, params.episode, body.completed)
  )
  .put(
    "/anilist/preferences",
    {
      body: aniListPreferencesSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ anilist, body, mutation }) => {
      const library = anilist;
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
    ({ anilist, body }) => anilist.previewThreads(body.basePath, body.statuses)
  )
  .put(
    "/anilist/entries/:mediaId",
    {
      body: enabledSchema,
      params: mediaParamsSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ anilist, automation, params, body, mutation }) => {
      const result = await mutation((tx) =>
        anilist.writeSelection(tx, [params.mediaId], body.enabled)
      );
      automation.refreshState();
      anilist.refreshState();
      return result;
    }
  )
  .put(
    "/anilist/selection",
    {
      body: selectionSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ anilist, automation, body, mutation }) => {
      const result = await mutation((tx) =>
        anilist.writeSelection(tx, body.mediaIds, body.enabled)
      );
      automation.refreshState();
      anilist.refreshState();
      return result;
    }
  )
  .put(
    "/anilist",
    {
      body: aniListConfigurationSchema,
      invalidate: invalidateLibrary,
    },
    ({ anilist, body }) => anilist.configure(body)
  )
  .post("/anilist/connect", { invalidate: invalidateLibrary }, ({ anilist }) => anilist.connect())
  .post(
    "/anilist/callback",
    { body: authorizationCallbackSchema, invalidate: invalidateLibrary },
    ({ anilist, body }) => anilist.receiveAuthorizationUrl(body.url)
  )
  .delete("/anilist/connect", { invalidate: invalidateLibrary }, ({ anilist }) =>
    anilist.cancelAuthorization()
  )
  .post("/anilist/list", { invalidate: invalidateLibrary }, ({ anilist }) => anilist.list())
  .post("/anilist/refresh", { invalidate: invalidateLibrary }, ({ anilist }) => anilist.refresh())
  .post(
    "/anilist/subscriptions",
    {
      body: subscriptionSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ anilist, body, mutation }) => {
      const result = await mutation((tx) => anilist.writeSubscription(tx, body));
      anilist.refreshState();
      return result;
    }
  )
  .post(
    "/anilist/subscriptions/:id/sync",
    { invalidate: invalidateLibrary },
    ({ anilist, params }) => anilist.sync(params.id)
  )
  .put(
    "/anilist/subscriptions/:id",
    {
      body: enabledSchema,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ anilist, automation, params, body, mutation }) => {
      const result = await mutation((tx) => anilist.writeToggle(tx, params.id, body.enabled));
      automation.refreshState();
      anilist.refreshState();
      return result;
    }
  )
  .delete(
    "/anilist/subscriptions/:id",
    {
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ anilist, automation, params, mutation }) => {
      const result = await mutation((tx) => anilist.deleteSubscription(tx, params.id));
      automation.refreshState();
      anilist.refreshState();
      return result;
    }
  );
