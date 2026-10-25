import { furinSync } from "@teyik0/furin/sync";
import { Effect } from "effect";
import { Elysia, ElysiaStatus } from "elysia";
import { sync } from "../../../sync";
import { accessPlugin } from "../access/plugin";
import { automationPlugin } from ".";
import { draft, preferences } from "./model";
import { releaseAutomationPlugin } from "./plugin";

export const automationManagementPlugin = new Elysia({ name: "tofu-automation-management-api" })
  .use(automationPlugin)
  .use(releaseAutomationPlugin)
  .use(accessPlugin)
  .use(furinSync(sync))
  .guard({ administration: true })
  .get("/automation", ({ releaseAutomation }) => releaseAutomation.snapshot())
  .put(
    "/automation/preferences",
    {
      body: preferences,
    },
    async ({ automation, body, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const result = await mutation((tx) => automation.writePreferences(tx, body));
      automation.refreshState();
      return result;
    }
  )
  .post("/automations/preview", { body: draft, idempotent: false }, ({ releaseAutomation, body }) =>
    Effect.runPromise(releaseAutomation.preview(body))
  )
  .post(
    "/automations",
    { body: draft },
    async ({ automation, releaseAutomation, body, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const prepared = await Effect.runPromise(releaseAutomation.prepareRule(null, body));
      if (prepared instanceof ElysiaStatus) {
        return prepared;
      }
      const result = await mutation((tx) => releaseAutomation.writeRule(tx, prepared));
      automation.refreshState();
      return result;
    }
  )
  .put(
    "/automations/:id",
    { body: draft },
    async ({ automation, releaseAutomation, params, body, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const prepared = await Effect.runPromise(releaseAutomation.prepareRule(params.id, body));
      if (prepared instanceof ElysiaStatus) {
        return prepared;
      }
      const result = await mutation((tx) => releaseAutomation.writeRule(tx, prepared));
      automation.refreshState();
      return result;
    }
  )
  .delete("/automations/:id", {}, async ({ automation, params, mutation, invalidate }) => {
    invalidate({ path: "/", type: "layout" });

    const result = await mutation((tx) => automation.deleteRule(tx, params.id));
    automation.refreshState();
    return result;
  })
  .post("/automations/:id/run", { idempotent: false }, ({ releaseAutomation, params }) =>
    Effect.runPromise(releaseAutomation.run(params.id))
  )
  .post(
    "/automation-decisions/:id/approve",
    { idempotent: false },
    ({ releaseAutomation, params }) => Effect.runPromise(releaseAutomation.approve(params.id))
  )
  .post(
    "/automation-decisions/:id/ignore",
    {},
    async ({ automation, params, mutation, invalidate }) => {
      invalidate({ path: "/", type: "layout" });

      const result = await mutation((tx) => automation.ignoreDecision(tx, params.id));
      automation.refreshState();
      return result;
    }
  );
