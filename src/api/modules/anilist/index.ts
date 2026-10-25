import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { Cause, Effect } from "effect";
import { Elysia, ElysiaStatus, problem } from "elysia";
import { createLogger } from "evlog";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { automationPlugin } from "../automation";
import { draft } from "../automation/model";
import { releaseAutomationPlugin } from "../automation/plugin";
import type { AniListCatalogFilters } from "./catalog";
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

export const anilistPlugin = new Elysia({ name: "tofu-anilist-api", prefix: "/anilist" })
  .use(anilistServicePlugin)
  .use(automationPlugin)
  .use(releaseAutomationPlugin)
  .use(furinSync(sync))
  .use(furinInvalidate())
  .use(accessPlugin)
  // The AniList account, list and automation belong to the server owner.
  .guard({ administration: true })
  .get("/", {}, ({ anilist, defer }) => {
    if (anilist.needsRefresh()) {
      defer(async () => {
        await Effect.runPromise(
          anilist.refresh().pipe(
            Effect.catchCause((cause) =>
              Effect.sync(() => {
                if (Cause.hasInterruptsOnly(cause)) {
                  return;
                }
                const log = createLogger({
                  component: "anilist",
                  error: Cause.squash(cause),
                  operation: "refresh",
                });
                log.setLevel("error");
                log.emit();
              })
            )
          )
        );
      });
    }
    return anilist.snapshot();
  })
  .post("/catalog", { body: catalogSchema }, ({ anilist, body }) =>
    Effect.runPromise(anilist.catalog(body as AniListCatalogFilters))
  )
  .get("/catalog/options", ({ anilist }) => Effect.runPromise(anilist.catalogOptions()))
  .get("/entries/:mediaId/editor", { params: mediaParamsSchema }, ({ anilist, params }) =>
    Effect.runPromise(anilist.editor(params.mediaId))
  )
  .put(
    "/entries/:mediaId/editor",
    {
      body: aniListEntrySchema,

      params: mediaParamsSchema,
    },
    ({ anilist, params, body, invalidate }) => {
      invalidate(invalidateLibrary);
      return Effect.runPromise(anilist.saveEntry(params.mediaId, body));
    }
  )
  .put(
    "/entries/:mediaId/favourite",
    {
      body: enabledSchema,

      params: mediaParamsSchema,
    },
    ({ anilist, params, body, invalidate }) => {
      invalidate(invalidateLibrary);
      return Effect.runPromise(anilist.favourite(params.mediaId, body.enabled));
    }
  )
  .delete(
    "/entries/:mediaId/editor",
    {
      params: mediaParamsSchema,
    },
    ({ anilist, params, invalidate }) => {
      invalidate(invalidateLibrary);
      return Effect.runPromise(anilist.deleteEntry(params.mediaId));
    }
  )
  .post("/entries/:mediaId/releases", { params: mediaParamsSchema }, ({ anilist, params }) =>
    Effect.runPromise(anilist.releases(params.mediaId))
  )
  .put(
    "/entries/:mediaId/automation",
    {
      body: draft,
      params: mediaParamsSchema,
    },
    async ({ anilist, automation, releaseAutomation, params, body, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const input = anilist.prepareAutomation(params.mediaId, body);
      if (input instanceof ElysiaStatus) {
        return input;
      }
      const prepared = await Effect.runPromise(
        releaseAutomation.prepareRule(input.id, input.draft, {
          key: input.key,
          ownerId: "tofu.anilist",
        })
      );
      if (prepared instanceof ElysiaStatus) {
        return prepared;
      }
      const result = await mutation((tx) => {
        const rule = releaseAutomation.writeRule(tx, prepared);
        if (rule instanceof ElysiaStatus) {
          return rule;
        }
        return anilist.writeAutomationLink(tx, input, rule.id) ?? rule;
      });
      automation.refreshState();
      anilist.refreshState();
      return result;
    }
  )
  .put(
    "/entries/:mediaId/episodes/:episode",
    {
      body: episodeCompletionSchema,

      params: episodeParamsSchema,
    },
    ({ anilist, params, body, invalidate }) => {
      invalidate(invalidateLibrary);
      return Effect.runPromise(
        anilist.completeEpisode(params.mediaId, params.episode, body.completed, body.accountId)
      );
    }
  )
  .put(
    "/preferences",
    {
      body: aniListPreferencesSchema,
    },
    async ({ anilist, body, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const library = anilist;
      const result = await mutation((tx) => library.writePreferences(tx, body.visibleStatuses));
      library.refreshState();
      return result;
    }
  )
  .post(
    "/threads/preview",
    {
      body: threadPreviewSchema,
    },
    ({ anilist, body }) => anilist.previewThreads(body.basePath, body.statuses)
  )
  .put(
    "/entries/:mediaId",
    {
      body: enabledSchema,
      params: mediaParamsSchema,
    },
    async ({ anilist, automation, params, body, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const result = await mutation((tx) =>
        anilist.writeSelection(tx, [params.mediaId], body.enabled)
      );
      automation.refreshState();
      anilist.refreshState();
      return result;
    }
  )
  .put(
    "/selection",
    {
      body: selectionSchema,
    },
    async ({ anilist, automation, body, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const result = await mutation((tx) =>
        anilist.writeSelection(tx, body.mediaIds, body.enabled)
      );
      automation.refreshState();
      anilist.refreshState();
      return result;
    }
  )
  .put(
    "/",
    {
      body: aniListConfigurationSchema,
    },
    ({ anilist, body, invalidate }) => {
      invalidate(invalidateLibrary);
      return anilist.configure(body);
    }
  )
  .post("/connect", {}, ({ anilist, caller, invalidate }) => {
    invalidate(invalidateLibrary);

    if (caller.kind === "device" && caller.device.kind !== "desktop") {
      return problem(409, {
        detail:
          "Start AniList authorization in a paired Tofu desktop app or the server's own desktop window",
      });
    }
    return Effect.runPromise(
      anilist.connect(caller.kind === "device" ? caller.device.id : undefined)
    );
  })
  .post(
    "/callback",
    { body: authorizationCallbackSchema },
    ({ anilist, body, caller, invalidate }) => {
      invalidate(invalidateLibrary);
      return Effect.runPromise(
        anilist.receiveAuthorizationUrl(
          body.url,
          caller.kind === "device" ? caller.device.id : undefined
        )
      );
    }
  )
  .post(
    "/oauth/remote-callback",
    { body: authorizationCallbackSchema },
    ({ anilist, body, caller, invalidate }) => {
      invalidate(invalidateLibrary);
      return Effect.runPromise(
        anilist.receiveAuthorizationUrl(
          body.url,
          caller.kind === "device" ? caller.device.id : undefined
        )
      );
    }
  )
  .delete("/connect", {}, ({ anilist, invalidate }) => {
    invalidate(invalidateLibrary);
    return anilist.cancelAuthorization();
  })
  .post("/list", {}, ({ anilist, invalidate }) => {
    invalidate(invalidateLibrary);
    return Effect.runPromise(anilist.list());
  })
  .post("/refresh", {}, ({ anilist, invalidate }) => {
    invalidate(invalidateLibrary);
    return Effect.runPromise(anilist.refresh());
  })
  .post(
    "/subscriptions",
    {
      body: subscriptionSchema,
    },
    async ({ anilist, body, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const result = await mutation((tx) => anilist.writeSubscription(tx, body));
      anilist.refreshState();
      return result;
    }
  )
  .post("/subscriptions/:id/sync", {}, ({ anilist, params, invalidate }) => {
    invalidate(invalidateLibrary);
    return Effect.runPromise(anilist.sync(params.id));
  })
  .put(
    "/subscriptions/:id",
    {
      body: enabledSchema,
    },
    async ({ anilist, automation, params, body, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const result = await mutation((tx) => anilist.writeToggle(tx, params.id, body.enabled));
      automation.refreshState();
      anilist.refreshState();
      return result;
    }
  )
  .delete(
    "/subscriptions/:id",
    {},
    async ({ anilist, automation, params, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const result = await mutation((tx) => anilist.deleteSubscription(tx, params.id));
      automation.refreshState();
      anilist.refreshState();
      return result;
    }
  );
