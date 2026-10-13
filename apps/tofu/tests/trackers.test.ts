import { expect, test } from "bun:test";
import { Server } from "bittorrent-tracker";
import type { DashboardState } from "../src/types";
import { expectSuccess } from "./helpers/problem";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

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
    const { id }: { id: string } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = () =>
      context.client.state
        .get({ query: { selected: id } })
        .then((response) => expectSuccess(response) as DashboardState);
    await waitFor(read, (value) => value.detail?.status === "seeding");
    const working = await waitFor(read, (value) => value.detail?.trackers[0]?.status === "working");
    expect(working.detail?.trackers[0]?.seeds).toBeGreaterThanOrEqual(1);
    expect((await context.client.torrents({ id }).announce.post({})).status).toBe(200);
    await waitFor(
      read,
      (value) =>
        (value.detail?.trackers[0]?.lastAnnounce ?? 0) >
        (working.detail?.trackers[0]?.lastAnnounce ?? 0)
    );
    const replace = await context.client.torrents({ id }).trackers.put({ urls: [second.url] });
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
    await context.client.torrents({ id }).announce.post({});
    await waitFor(
      async () => second.count(),
      (count) => count > secondCalls
    );
    expect(first.count()).toBe(previousCalls);
    const result = await read();
    expect(result.detail?.trackers).toHaveLength(1);
    expect(result.detail?.progress).toBe(1);
    const file = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(Bun.SHA256.hash(torrentBytes(file), "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
  } finally {
    await context.close();
    await Promise.all([first.close(), second.close()]);
  }
}, 30_000);
