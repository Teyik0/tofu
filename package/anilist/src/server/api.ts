import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { draft } from "@tofu/plugins/automation-model";
import type { AniListCatalogFilters } from "@tofu/plugins/domain";
import { Elysia } from "elysia";
import { object, string } from "valibot";
import { catalogSchema } from "./catalog";
import type { AniListApiDependencies } from "./dependencies";
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
import { createAniListOpeningApi } from "./opening";

const invalidateLibrary = { path: "/anilist", type: "page" } as const;

export function createAniListApi<const Prefix extends string>(
  dependencies: AniListApiDependencies,
  prefix: Prefix
) {
  const routes = new Elysia({ name: "tofu-anilist-api", prefix })
    .derive("global", () => ({ ...dependencies.application() }))
    .use(furinSync(dependencies.sync))
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
      async ({ anilist, automation, releaseAutomation, params, body, mutation }) => {
        const input = anilist.prepareAutomation(params.mediaId, body);
        const prepared = await releaseAutomation.prepareRule(input.id, input.draft, {
          key: input.key,
          ownerId: "tofu.anilist",
        });
        const result = await mutation((tx) => {
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
      { invalidate: invalidateLibrary, params: object({ id: string() }) },
      ({ anilist, params }) => anilist.sync(params.id)
    )
    .put(
      "/anilist/subscriptions/:id",
      {
        body: enabledSchema,
        params: object({ id: string() }),
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
        params: object({ id: string() }),
        sync: { invalidate: { path: "/", type: "layout" } },
      },
      async ({ anilist, automation, params, mutation }) => {
        const result = await mutation((tx) => anilist.deleteSubscription(tx, params.id));
        automation.refreshState();
        anilist.refreshState();
        return result;
      }
    );

  return new Elysia().use(routes).use(
    createAniListOpeningApi(
      {
        isDesktop: () => dependencies.application().platform.kind === "desktop",
        openExternal: (url) => {
          const { platform } = dependencies.application();
          return platform.kind === "desktop" && platform.openExternal(url);
        },
      },
      prefix
    )
  );
}

export type { AniListApiDependencies } from "./dependencies";

export type AniListApi = ReturnType<typeof createAniListApi<"/api">>;
