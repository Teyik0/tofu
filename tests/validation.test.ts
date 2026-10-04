import { expect, test } from "bun:test";
import { fixture, json } from "./helpers";

test("invalid input, duplicates and cross-origin mutations fail without changing the library", async () => {
  const context = await fixture(64 * 1024, []);
  try {
    const invalid = await context.request(
      "/torrents",
      json({ paused: true, source: "pas-un-torrent" })
    );
    expect(invalid.status).toBe(400);
    const added = await context.request(
      "/torrents",
      json({ paused: true, source: context.magnet })
    );
    expect(added.status).toBe(200);
    const { id } = (await added.json()) as { id: string };
    const duplicate = await context.request(
      "/torrents",
      json({ paused: true, source: context.magnet })
    );
    expect(duplicate.status).toBe(409);
    const tracker = await context.request(`/torrents/${id}/trackers`, {
      ...json({ urls: ["file:///tmp"] }),
      method: "PUT",
    });
    expect(tracker.status).toBe(400);
    const forbidden = await context.request(`/torrents/${id}`, {
      ...json({ deleteFiles: true }),
      headers: { "content-type": "application/json", origin: "https://another-site.example" },
      method: "DELETE",
    });
    expect(forbidden.status).toBe(403);
    expect(context.engine.snapshot(id).torrents).toHaveLength(1);
  } finally {
    await context.close();
  }
});

test("two concurrent additions of the same torrent create a single library entry", async () => {
  const context = await fixture(64 * 1024, []);
  try {
    const responses = await Promise.all([
      context.request("/torrents", json({ paused: true, source: context.magnet })),
      context.request("/torrents", json({ paused: true, source: context.magnet })),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(context.engine.snapshot(null).torrents).toHaveLength(1);
  } finally {
    await context.close();
  }
});
