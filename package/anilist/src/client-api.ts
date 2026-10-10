import type { createAutomationReadApi } from "@tofu/plugins/automation-read-api";
import { createClient } from "@tofu/plugins/client";
import type { createAniListApi } from "./server/api";

const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
export const api = createClient<ReturnType<typeof createAniListApi>>(origin);
export const coreClient = createClient<ReturnType<typeof createAutomationReadApi>>(origin);
