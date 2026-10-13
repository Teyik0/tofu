import { furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { sync } from "../../../sync";
import { automationPlugin } from ".";
import { draft, preferences } from "./model";
import { releaseAutomationPlugin } from "./plugin";

export const automationManagementPlugin = new Elysia({ name: "tofu-automation-management-api" })
  .use(automationPlugin)
  .use(releaseAutomationPlugin)
  .use(furinSync(sync))
  .get("/automation", ({ releaseAutomation }) => releaseAutomation.snapshot())
  .put(
    "/automation/preferences",
    {
      body: preferences,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ automation, body, mutation }) => {
      const result = await mutation((tx) => automation.writePreferences(tx, body));
      automation.refreshState();
      return result;
    }
  )
  .post("/automations/preview", { body: draft, sync: false }, ({ releaseAutomation, body }) =>
    releaseAutomation.preview(body)
  )
  .post(
    "/automations",
    {
      body: draft,
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ automation, releaseAutomation, body, mutation }) => {
      const service = automation;
      const prepared = await releaseAutomation.prepareRule(null, body);
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
    async ({ automation, releaseAutomation, params, body, mutation }) => {
      const service = automation;
      const prepared = await releaseAutomation.prepareRule(params.id, body);
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
    async ({ automation, params, mutation }) => {
      const service = automation;
      const result = await mutation((tx) => service.deleteRule(tx, params.id));
      service.refreshState();
      return result;
    }
  )
  .post("/automations/:id/run", { sync: false }, ({ releaseAutomation, params }) =>
    releaseAutomation.run(params.id)
  )
  .post("/automation-decisions/:id/approve", { sync: false }, ({ releaseAutomation, params }) =>
    releaseAutomation.approve(params.id)
  )
  .post(
    "/automation-decisions/:id/ignore",
    {
      sync: { invalidate: { path: "/", type: "layout" } },
    },
    async ({ automation, params, mutation }) => {
      const service = automation;
      const result = await mutation((tx) => service.ignoreDecision(tx, params.id));
      service.refreshState();
      return result;
    }
  );
