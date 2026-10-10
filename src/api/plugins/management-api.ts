import { furinSync } from "@teyik0/furin/sync";
import { Elysia, t } from "elysia";
import { type CoreDependencies, createCore, unavailableAutomation } from "../core";

export function createPluginManagementApi(dependencies: CoreDependencies) {
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
      ({ params, body }) => service().configure(params.id, body)
    );
}
