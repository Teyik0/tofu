import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { services } from "../../lib/services";
import { draft, preferences } from "./model";

export const automation = new Elysia({ name: "tofu-automation-api" })
  .use(furinSync(sync))
  .get("/automation", () => services.automation.snapshot())
  .put(
    "/automation/preferences",
    {
      body: preferences,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ body, mutation }) => {
      const result = await mutation((tx) => services.automation.writePreferences(tx, body));
      services.automation.refreshState();
      return result;
    }
  )
  .post("/automations/preview", { body: draft, sync: false }, ({ body }) =>
    services.automation.preview(body)
  )
  .post(
    "/automations",
    {
      body: draft,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ body, mutation }) => {
      const service = services.automation;
      const prepared = await service.prepareRule(null, body);
      const result = await mutation((tx) => service.writeRule(tx, prepared));
      service.refreshState();
      return result;
    }
  )
  .put(
    "/automations/:id",
    {
      body: draft,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ params, body, mutation }) => {
      const service = services.automation;
      const prepared = await service.prepareRule(params.id, body);
      const result = await mutation((tx) => service.writeRule(tx, prepared));
      service.refreshState();
      return result;
    }
  )
  .delete(
    "/automations/:id",
    {
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ params, mutation }) => {
      const service = services.automation;
      const result = await mutation((tx) => service.deleteRule(tx, params.id));
      service.refreshState();
      return result;
    }
  )
  .post("/automations/:id/run", { sync: false }, ({ params }) => services.automation.run(params.id))
  .post("/automation-decisions/:id/approve", { sync: false }, ({ params }) =>
    services.automation.approve(params.id)
  )
  .post(
    "/automation-decisions/:id/ignore",
    {
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ params, mutation }) => {
      const service = services.automation;
      const result = await mutation((tx) => service.ignoreDecision(tx, params.id));
      service.refreshState();
      return result;
    }
  );
