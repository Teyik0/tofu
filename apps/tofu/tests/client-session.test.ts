import { expect, test } from "bun:test";
import { createTofuClient } from "../src/client";

test("SSR clients forward the native cookie only to the incoming request origin", async () => {
  const local = Bun.serve({
    fetch: () => Response.json({ theme: "dark" }),
    hostname: "127.0.0.1",
    port: 0,
  });
  let received: string | null = "unexpected";
  const other = Bun.serve({
    fetch: (request) => {
      received = request.headers.get("cookie");
      return Response.json({ theme: "dark" });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    const incoming = new Request(local.url, { headers: { cookie: "furin_desktop_test=secret" } });
    await createTofuClient(other.url.origin, incoming).api.settings.get();
    expect(received).toBeNull();
  } finally {
    local.stop(true);
    other.stop(true);
  }
});
