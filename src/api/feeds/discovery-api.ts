import { furinSync } from "@teyik0/furin/sync";
import { Elysia, t } from "elysia";
import { type CoreDependencies, createCore, unavailableAutomation } from "../core";
import { source } from "./schemas";

export function createDiscoveryApi(dependencies: CoreDependencies) {
  const { automation, sync } = dependencies;
  const service = automation ?? unavailableAutomation;
  return new Elysia({ name: "tofu-discovery-api", prefix: "/api" })
    .use(createCore(dependencies))
    .use(furinSync(sync))
    .guard({ sync: false })
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
    );
}
