import { type FurinSyncOptions, furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import { type CoreAutomationActions, createCoreActionsApi } from "./core-actions-api";
import type { AutomationState } from "./domain";

export function createAutomationReadApi(read: () => AutomationState, sync: FurinSyncOptions) {
  return new Elysia({ name: "tofu-automation-read", prefix: "/api" })
    .use(furinSync(sync))
    .get("/automation", { idempotent: false }, read);
}

export function createCoreAutomationApi(
  read: () => AutomationState,
  actions: () => CoreAutomationActions,
  sync: FurinSyncOptions
) {
  return new Elysia()
    .use(createAutomationReadApi(read, sync))
    .use(createCoreActionsApi(actions, sync));
}
