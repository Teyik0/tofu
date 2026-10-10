import { furinSync } from "@teyik0/furin/sync";
import { Elysia, t } from "elysia";
import { type CoreDependencies, createCore, unavailableAutomation } from "../core";

export function createJevApi(dependencies: CoreDependencies) {
  const { automation, sync } = dependencies;
  const service = automation ?? unavailableAutomation;
  return new Elysia({ name: "tofu-jev-api", prefix: "/api" })
    .use(createCore(dependencies))
    .use(furinSync(sync))
    .guard({ sync: false })
    .post(
      "/automations/interpret",
      {
        body: t.Object({
          destinationId: t.String(),
          query: t.String({ maxLength: 2000, minLength: 1 }),
        }),
      },
      ({ body }) => service().interpret(body.query, body.destinationId)
    );
}
