import { furinInvalidate } from "@teyik0/furin";
import { furinSync } from "@teyik0/furin/sync";
import { draft } from "@tofu/plugins/automation-model";
import type { FeedRelease } from "@tofu/plugins/discovery-model";
import { Cause, Effect, Queue, Stream } from "effect";
import { Elysia, ElysiaStatus, problem, sse } from "elysia";
import { createLogger } from "evlog";
import { object, string } from "valibot";
import type { AniListCatalogFilters } from "./catalog";
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
  notificationsSchema,
  selectionSchema,
  subscriptionSchema,
  threadPreviewSchema,
} from "./model";
import type { AniListReleases } from "./releases";

const invalidateLibrary = { path: "/anilist", type: "page" } as const;
export function createAniListApi<const Prefix extends string>(
  dependencies: AniListApiDependencies,
  prefix: Prefix
) {
  const { sync } = dependencies;
  const notificationMonitor = dependencies.application().anilist;
  return new Elysia({ name: "tofu-anilist-api", prefix: `${prefix}/anilist` })
    .derive("local", ({ request }) => {
      const caller = dependencies.authorize(request);
      if (caller instanceof ElysiaStatus) {
        return caller;
      }
      return { ...dependencies.application(), caller };
    })
    .use(furinSync(sync))
    .use(furinInvalidate())
    .onStart(() => Effect.runPromise(notificationMonitor.startNotifications(sync)))
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
    .get("/notifications", { query: notificationsSchema }, ({ anilist, query }) =>
      Effect.runPromise(anilist.notifications(query))
    )
    .get("/notifications/status", {}, ({ anilist }) => anilist.notificationStatus())
    .post("/notifications/check", { idempotent: false }, ({ anilist }) =>
      Effect.runPromise(anilist.checkNotifications(true))
    )
    .post("/notifications/read", {}, ({ anilist }) =>
      Effect.runPromise(anilist.notifications({ category: "all", page: 1 }, true))
    )
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
    .post(
      "/entries/:mediaId/releases/stream",
      { params: mediaParamsSchema },
      async function* ({ anilist, params, request, set }) {
        set.headers["cache-control"] = "private, no-store";
        const stream = Stream.callback<
          | { type: "progress"; releases: FeedRelease[] }
          | { type: "complete"; result: AniListReleases }
          | { type: "error"; status: number; detail: string }
        >((queue) =>
          Effect.gen(function* () {
            const result = yield* anilist.releases(params.mediaId, (releases) => {
              Queue.offerUnsafe(queue, { releases, type: "progress" });
            });
            if (result instanceof ElysiaStatus) {
              Queue.offerUnsafe(queue, {
                detail: result.response.detail,
                status: result.status,
                type: "error",
              });
            } else {
              Queue.offerUnsafe(queue, { result, type: "complete" });
            }
            Queue.endUnsafe(queue);
          })
        );
        const iterator = Stream.toAsyncIterable(stream)[Symbol.asyncIterator]();
        await using cleanup = new AsyncDisposableStack();
        cleanup.defer(async () => {
          await iterator.return?.();
        });
        for (;;) {
          // biome-ignore lint/performance/noAwaitInLoops: Consume and forward each incremental search update in order.
          const next = await Effect.runPromise(
            Effect.tryPromise({ catch: (cause) => cause, try: () => iterator.next() }),
            { signal: request.signal }
          );
          if (next.done) {
            return;
          }
          yield sse({ data: next.value });
        }
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
    .post(
      "/subscriptions/:id/sync",
      { params: object({ id: string() }) },
      ({ anilist, params, invalidate }) => {
        invalidate(invalidateLibrary);
        return Effect.runPromise(anilist.sync(params.id));
      }
    )
    .put(
      "/subscriptions/:id",
      {
        body: enabledSchema,
        params: object({ id: string() }),
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
      { params: object({ id: string() }) },
      async ({ anilist, automation, params, mutation, invalidate }) => {
        invalidate({ path: "/", type: "layout" });

        const result = await mutation((tx) => anilist.deleteSubscription(tx, params.id));
        automation.refreshState();
        anilist.refreshState();
        return result;
      }
    );
}
export type { AniListApiDependencies } from "./dependencies";
export type AniListApi = ReturnType<typeof createAniListApi<"/api">>;
