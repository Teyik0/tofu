import { expect, test } from "bun:test";
import { join } from "node:path";
import type { AutomationState } from "../src/types";
import { json } from "./helpers";

test("plugin mutations revalidate the shared loader for every plugin section", async () => {
  const upstream = Bun.serve({
    fetch: () => new Response("<rss><channel></channel></rss>"),
    hostname: "127.0.0.1",
    port: 0,
  });
  const ready = Promise.withResolvers<string>();
  const host = Bun.spawn([process.execPath, "tests/anilist-page-host.ts"], {
    cwd: join(import.meta.dir, ".."),
    env: { ...process.env, TOFU_TEST_ANILIST_ENDPOINT: upstream.url.toString() },
    ipc(message: unknown) {
      if (
        message &&
        typeof message === "object" &&
        "url" in message &&
        typeof message.url === "string"
      ) {
        ready.resolve(message.url);
      }
    },
    stderr: "pipe",
    stdout: "ignore",
  });
  const stderr = new Response(host.stderr).text();
  void host.exited.then(async (code) => {
    ready.reject(new Error(`The page server exited with code ${code}: ${await stderr}`));
  });
  try {
    const origin = await ready.promise;
    const initial = await fetch(new URL("/plugins/sources", origin));
    expect(initial.status).toBe(200);
    expect(await initial.text()).toContain("Torrent sources");

    const configured = await fetch(new URL("/api/plugins/nyaa", origin), {
      ...json({ enabled: true }),
      method: "PUT",
    });
    expect(configured.status).toBe(200);
    expect(configured.headers.get("x-furin-revalidate")?.split(",")).toContain("/plugins:layout");
    const configuredState = (await configured.json()) as AutomationState;
    expect(configuredState.plugins.find((plugin) => plugin.id === "nyaa")?.enabled).toBe(true);

    const tested = await fetch(new URL("/api/plugins/nyaa/test", origin), json({}));
    expect(tested.status).toBe(200);
    expect(tested.headers.get("x-furin-revalidate")?.split(",")).toContain("/plugins:layout");
    const testedState = (await tested.json()) as AutomationState;
    expect(testedState.plugins.find((plugin) => plugin.id === "nyaa")?.checkedAt).toEqual(
      expect.any(Number)
    );

    const refreshed = await fetch(new URL("/plugins/sources", origin));
    expect(refreshed.status).toBe(200);
    const html = await refreshed.text();
    expect(html).toContain("Enabled");
    expect(html).toContain("Checked at");

    const rejected = await fetch(new URL("/api/plugins/unknown", origin), {
      ...json({ enabled: true }),
      method: "PUT",
    });
    expect(rejected.status).toBe(404);
    expect(rejected.headers.get("x-furin-revalidate")).toBeNull();
  } finally {
    host.kill("SIGTERM");
    await host.exited;
    upstream.stop(true);
  }
});
