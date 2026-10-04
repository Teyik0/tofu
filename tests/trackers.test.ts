import { expect, test } from "bun:test";
import { Server } from "bittorrent-tracker";
import type { DashboardState } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

async function tracker() {
  const server = new Server({
    http: true,
    interval: 1_800_000,
    stats: false,
    udp: false,
    ws: false,
  });
  let announces = 0;
  server.on("start", () => {
    announces += 1;
  });
  server.on("update", () => {
    announces += 1;
  });
  server.on("error", console.error);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.http.address();
  if (!address || typeof address === "string") {
    throw new Error("Tracker port missing");
  }
  return {
    close: () => new Promise<void>((resolve) => server.close(resolve)),
    count: () => announces,
    server,
    url: `http://127.0.0.1:${address.port}/announce`,
  };
}

test("trackers return real swarm statistics and can be reannounced, added and removed without losing data", async () => {
  const first = await tracker();
  const second = await tracker();
  const context = await fixture(65_536, [first.url]);
  try {
    const { id }: { id: string } = await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json();
    const read = () =>
      context
        .request(`/state?selected=${id}`, undefined)
        .then((response) => response.json() as Promise<DashboardState>);
    await waitFor(read, (value) => value.detail?.status === "seeding");
    const working = await waitFor(read, (value) => value.detail?.trackers[0]?.status === "working");
    expect(working.detail?.trackers[0]?.seeds).toBeGreaterThanOrEqual(1);
    expect((await context.request(`/torrents/${id}/announce`, json({}))).status).toBe(200);
    await waitFor(
      read,
      (value) =>
        (value.detail?.trackers[0]?.lastAnnounce ?? 0) >
        (working.detail?.trackers[0]?.lastAnnounce ?? 0)
    );
    const replace = await context.request(`/torrents/${id}/trackers`, {
      ...json({ urls: [second.url] }),
      method: "PUT",
    });
    expect(replace.status).toBe(200);
    await waitFor(
      read,
      (value) =>
        value.detail?.trackers[0]?.url === second.url &&
        value.detail.trackers[0].status === "working" &&
        value.detail.status === "seeding"
    );
    const previousCalls = first.count();
    const secondCalls = second.count();
    await context.request(`/torrents/${id}/announce`, json({}));
    await waitFor(
      async () => second.count(),
      (count) => count > secondCalls
    );
    expect(first.count()).toBe(previousCalls);
    const result = await read();
    expect(result.detail?.trackers).toHaveLength(1);
    expect(result.detail?.progress).toBe(1);
    const file = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(Bun.SHA256.hash(await file.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
    await Promise.all([first.close(), second.close()]);
  }
}, 30_000);
