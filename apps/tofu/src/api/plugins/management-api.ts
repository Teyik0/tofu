import { furinSync } from "@teyik0/furin/sync";
import { Elysia, t } from "elysia";
import { type CoreDependencies, createCore, unavailableAutomation } from "../core";
import type { PluginHost } from "../plugin-host";

export function createPluginManagementApi(dependencies: CoreDependencies, host?: PluginHost) {
  const { automation, sync } = dependencies;
  const service = automation ?? unavailableAutomation;
  return new Elysia({ name: "tofu-pluginmanagement-api", prefix: "/api" })
    .use(createCore(dependencies))
    .use(furinSync(sync))
    .guard({ sync: false })
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
      async ({ params, body }) => {
        const state = service().configure(params.id, body);
        if (params.id === "anilist" && host) {
          await host.initialize();
          await host.setEnabled(params.id, body.enabled);
        }
        return state;
      }
    );
}
