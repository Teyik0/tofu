import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { forwardNativeAuthorization } from "../src/server/desktop-protocol";

test("the protocol helper forwards OAuth to the matching running instance without starting another engine", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-protocol-"));
  const received: string[] = [];
  const server = Bun.serve({
    async fetch(request) {
      if (request.headers.get("cookie") !== "furin_desktop_test=secret") {
        return new Response("Forbidden", { status: 403 });
      }
      const path = new URL(request.url).pathname;
      if (path === "/api/instance") {
        return Response.json({ dataDir: directory, profile: "release" });
      }
      if (path === "/api/anilist/callback") {
        received.push(((await request.json()) as { url: string }).url);
        return Response.json({ authenticated: true });
      }
      return Response.json({ opened: true });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  try {
    await Bun.write(
      join(directory, "server.json"),
      JSON.stringify({
        cookie: "furin_desktop_test=secret",
        mode: "desktop",
        profile: "release",
        url: server.url.origin,
      })
    );
    const input = "tofu://oauth/anilist#access_token=example&state=nonce";
    expect(
      await forwardNativeAuthorization({ dataDir: directory, profile: "release", url: input })
    ).toBe(true);
    expect(received).toEqual([input]);
    await expect(
      forwardNativeAuthorization({ dataDir: directory, profile: "dev", url: input })
    ).rejects.toThrow();
    expect(received).toHaveLength(1);
  } finally {
    server.stop(true);
    await rm(directory, { force: true, recursive: true });
  }
});
