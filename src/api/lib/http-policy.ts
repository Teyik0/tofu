import { Elysia } from "elysia";

export const httpPolicyPlugin = new Elysia({ name: "tofu-http-policy" }).macro({
  noStore: {
    transform({ request, set }) {
      const { pathname } = new URL(request.url);
      // Furin assets and versioned player files retain their own cache policies.
      if (
        (pathname.startsWith("/_furin/") && pathname !== "/_furin/data") ||
        pathname.startsWith("/api/player/engine/")
      ) {
        return;
      }
      set.headers["cache-control"] = "private, no-store";
    },
  },
});
