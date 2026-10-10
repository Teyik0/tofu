import { createClient } from "@teyik0/furin/client";
import type { createAutomationReadApi } from "./automation-read-api";

/** A typed client for the host's public automation read endpoint. */
export function createCoreClient(origin: string, request?: Request) {
  const cookie =
    request && new URL(request.url).origin === new URL(origin).origin
      ? request.headers.get("cookie")
      : null;
  return createClient<ReturnType<typeof createAutomationReadApi>>(origin, {
    headers: cookie ? { cookie } : undefined,
  });
}
