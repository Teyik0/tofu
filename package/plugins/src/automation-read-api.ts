import { type FurinSyncOptions, furinSync } from "@teyik0/furin/sync";
import { Elysia } from "elysia";
import type { AutomationState } from "./domain";

export function createAutomationReadApi(read: () => AutomationState, sync: FurinSyncOptions) {
  return new Elysia({ name: "tofu-automation-read", prefix: "/api" })
    .use(furinSync(sync))
    .get("/automation", { sync: { id: "tofu.automation", scope: {} } }, read);
}
