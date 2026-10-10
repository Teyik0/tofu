import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { contextPlugin } from "../../lib/context";
import { draft, preferences } from "./model";

export const automationPlugin = new Elysia({ name: "tofu-automation-api" })
  .use(contextPlugin)
  .use(furinSync(sync))
  .get("/automation", ({ application }) => application.automation.snapshot())
  .put(
    "/automation/preferences",
    {
      body: preferences,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ application, body, mutation }) => {
      const result = await mutation((tx) => application.automation.writePreferences(tx, body));
      application.automation.refreshState();
      return result;
    }
  )
  .post("/automations/preview", { body: draft, sync: false }, ({ application, body }) =>
    application.automation.preview(body)
  )
  .post(
    "/automations",
    {
      body: draft,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ application, body, mutation }) => {
      const service = application.automation;
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
    async ({ application, params, body, mutation }) => {
      const service = application.automation;
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
    async ({ application, params, mutation }) => {
      const service = application.automation;
      const result = await mutation((tx) => service.deleteRule(tx, params.id));
      service.refreshState();
      return result;
    }
  )
  .post("/automations/:id/run", { sync: false }, ({ application, params }) =>
    application.automation.run(params.id)
  )
  .post("/automation-decisions/:id/approve", { sync: false }, ({ application, params }) =>
    application.automation.approve(params.id)
  )
  .post(
    "/automation-decisions/:id/ignore",
    {
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ application, params, mutation }) => {
      const service = application.automation;
      const result = await mutation((tx) => service.ignoreDecision(tx, params.id));
      service.refreshState();
      return result;
    }
  );
