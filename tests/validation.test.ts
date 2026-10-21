import { expect, test } from "bun:test";
import { treaty } from "@elysia/eden";
import { expectSuccess } from "./helpers/problem";
import { fixture, waitFor } from "./helpers/torrent";

test("moving downloads requires a destination path", async () => {
  const context = await fixture(4096, []);
  try {
    const invalid = await context.client.settings.patch({ moveFiles: true });
    expect(invalid.status).toBe(422);
    expect(new Headers(invalid.headers).get("cache-control")).toBe("private, no-store");
    const valid = await context.client.settings.patch({ downloadLimit: 1024 });
    expect(valid.status).toBe(200);
    expect(expectSuccess(valid).downloadLimit).toBe(1024);
  } finally {
    await context.close();
  }
});
test("the API rejects untrusted hosts even when their Origin matches", async () => {
  const context = await fixture(16_384, []);
  try {
    await context.api.listen({ hostname: "127.0.0.1", port: 0 });
    await context.api.modules;
    const { server } = context.api;
    if (!server) {
      throw new Error("The test API did not start listening");
    }
    const origin = `http://127.0.0.1:${server.port}`;
    const network = treaty<typeof context.api>(origin).api;
    await waitFor(
      () => network.state.get(),
      (response) => response.status === 200,
      3000
    );
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: true, source: context.magnet })
    ) as { id: string };
    const untrusted = treaty<typeof context.api>(origin, {
      headers: { host: "attacker.example:3030", origin: "http://attacker.example:3030" },
    }).api;
    expect((await untrusted.state.get()).status).toBe(403);
    expect(
      (
        await untrusted
          .torrents({ id })
          .delete({ deleteFiles: true }, { headers: { origin: "http://attacker.example:3030" } })
      ).status
    ).toBe(403);
    const nested = await network.updates.check.post(
      {},
      { headers: { origin: "https://another-site.example" } }
    );
    expect(nested.status).toBe(403);
    expect(expectSuccess(await context.client.state.get()).torrents).toHaveLength(1);
  } finally {
    if (context.api.server) {
      await context.api.stop(true);
    }
    await context.close();
  }
});
test("invalid input, duplicates and cross-origin mutations fail without changing the library", async () => {
  const context = await fixture(64 * 1024, []);
  try {
    await context.api.listen({ hostname: "127.0.0.1", port: 0 });
    await context.api.modules;
    const { server } = context.api;
    if (!server) {
      throw new Error("The test API did not start listening");
    }
    const network = treaty<typeof context.api>(`http://127.0.0.1:${server.port}`).api;
    await waitFor(
      () => network.state.get(),
      (response) => response.status === 200,
      3000
    );
    const invalid = await context.client.torrents.post({ paused: true, source: "pas-un-torrent" });
    expect(invalid.status).toBe(400);
    const added = await context.client.torrents.post({ paused: true, source: context.magnet });
    expect(added.status).toBe(200);
    const { id } = expectSuccess(added) as { id: string };
    const duplicate = await context.client.torrents.post({ paused: true, source: context.magnet });
    expect(duplicate.status).toBe(409);
    const tracker = await context.client.torrents({ id }).trackers.put({ urls: ["file:///tmp"] });
    expect(tracker.status).toBe(400);
    const forbidden = await network
      .torrents({ id })
      .delete({ deleteFiles: true }, { headers: { origin: "https://another-site.example" } });
    expect(forbidden.status).toBe(403);
    expect(
      expectSuccess(await context.client.state.get({ query: { selected: id } })).torrents
    ).toHaveLength(1);
  } finally {
    if (context.api.server) {
      await context.api.stop(true);
    }
    await context.close();
  }
});
test("two concurrent additions of the same torrent create a single library entry", async () => {
  const context = await fixture(64 * 1024, []);
  try {
    const responses = await Promise.all([
      context.client.torrents.post({ paused: true, source: context.magnet }),
      context.client.torrents.post({ paused: true, source: context.magnet }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(expectSuccess(await context.client.state.get()).torrents).toHaveLength(1);
  } finally {
    await context.close();
  }
});
