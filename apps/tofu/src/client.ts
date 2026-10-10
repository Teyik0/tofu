import { createClient } from "@teyik0/furin/client";
import type { createApi } from "./api";

export function createTofuClient(origin: string, request?: Request) {
  const cookie =
    request && new URL(request.url).origin === new URL(origin).origin
      ? request.headers.get("cookie")
      : null;
  return createClient<ReturnType<typeof createApi>>(origin, {
    headers: cookie ? { cookie } : undefined,
  });
}
export const api = createTofuClient(
  typeof window === "undefined" ? "http://localhost" : window.location.origin
);
