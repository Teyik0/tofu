import { Elysia } from "elysia";

const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function createRequestGuard() {
  return new Elysia({ name: "tofu-local-requests" }).request(({ request, set }) => {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    // A loopback listener can still receive requests with a hostile Host through DNS rebinding.
    if (!localHosts.has(url.hostname)) {
      set.status = 403;
      return { error: "This address cannot access Tofu" };
    }
    if (request.method !== "GET" && origin && origin !== url.origin) {
      set.status = 403;
      return { error: "This action must come from the Tofu interface" };
    }
  });
}
