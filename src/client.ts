import { createClient } from "@teyik0/furin/client";
import type { createApi } from "./server/api";

export function createTofuClient(origin: string) {
  return createClient<ReturnType<typeof createApi>>(origin);
}
export const api = createTofuClient(
  typeof window === "undefined" ? "http://localhost" : window.location.origin
);
