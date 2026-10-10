import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { type CoreDependencies, createCore, unavailableAutomation } from "../core";
import { draft, preferences } from "./schemas";

export function createAutomationApi(dependencies: CoreDependencies) {
  const { automation, sync } = dependencies;
  const service = automation ?? unavailableAutomation;
  return new Elysia({ name: "tofu-automation-api", prefix: "/api" })
    .use(createCore(dependencies))
    .use(furinSync(sync))
    .guard({ sync: false })
    .get("/automation", { sync: { id: "tofu.automation", scope: {} } }, () => service().snapshot())
    .put("/automation/preferences", { body: preferences }, ({ body }) =>
      service().savePreferences(body)
    )
    .post("/automations/preview", { body: draft }, ({ body }) => service().preview(body))
    .post("/automations", { body: draft }, ({ body }) => service().save(null, body))
    .put("/automations/:id", { body: draft }, ({ params, body }) => service().save(params.id, body))
    .delete("/automations/:id", ({ params }) => service().remove(params.id))
    .post("/automations/:id/run", ({ params }) => service().run(params.id))
    .post("/automation-decisions/:id/approve", ({ params }) => service().approve(params.id))
    .post("/automation-decisions/:id/ignore", ({ params }) => service().ignore(params.id));
}
