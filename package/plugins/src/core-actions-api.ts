import { furinInvalidate } from "@teyik0/furin";
import { type FurinSyncOptions, furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { boolean, maxLength, object, pipe, string } from "valibot";
import { source } from "./automation-model";
import type { AutomationState, SourcePluginId } from "./domain";
import { pluginConfigurationSchema } from "./plugin-model";

export interface CoreAutomationActions {
  addRelease: (
    source: SourcePluginId,
    id: string,
    threadId: string,
    paused: boolean
  ) => Promise<{ id: string }>;
  configure: (
    id: string,
    configuration: { enabled: boolean; apiKey?: string; dailyLimit?: number }
  ) => AutomationState;
  run: (id: string) => Promise<AutomationState>;
}

// The host and plugin clients share this route definition and its inferred Eden types.
export function createCoreActionsApi(
  services: () => CoreAutomationActions,
  sync: FurinSyncOptions
) {
  return new Elysia({ name: "tofu-core-actions", prefix: "/api" })
    .use(furinSync(sync))
    .use(furinInvalidate())

    .post(
      "/discover/add",
      {
        body: object({
          destinationId: string(),
          id: pipe(string(), maxLength(4096)),
          paused: boolean(),
          sourceId: source,
        }),
      },
      ({ body }) => services().addRelease(body.sourceId, body.id, body.destinationId, body.paused)
    )
    .post("/automations/:id/run", ({ params }) => services().run(params.id))
    .put(
      "/plugins/:id",
      {
        body: pluginConfigurationSchema,
      },
      ({ params, body, invalidate }) => {
        invalidate({ path: "/", type: "layout" });
        invalidate({ path: "/plugins", type: "layout" });
        invalidate({ path: "/anilist", type: "page" });
        return services().configure(params.id, body);
      }
    );
}
