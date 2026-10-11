// biome-ignore-all lint/performance/noAwaitInLoops: poll observable network state sequentially
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebTorrent, { type Torrent } from "webtorrent";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import type { DashboardState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { openTestDatabase } from "./database";

const network = {
  dht: false,
  lsd: false,
  natPmp: false,
  natUpnp: false,
  tracker: false,
  utp: false,
};

export async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const value = await read();
    if (ready(value)) {
      return value;
    }
    await Bun.sleep(30);
  }
  throw new Error("The expected condition was not reached");
}

test("a magnet added through the API downloads real bytes and exposes its files and statistics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-test-"));
  const bytes = crypto.getRandomValues(new Uint8Array(65_536));
  const source = join(directory, "source.bin");
  await Bun.write(source, bytes);
  const seeder = new WebTorrent(network);
  const engine = await TorrentEngine.open({
    dataDir: join(directory, "state"),
    downloadPath: join(directory, "downloads"),
    network,
  });
  const sync = await openTestDatabase(join(directory, "sync"));
  const api = await createTestApi(() => engine, sync.options);
  try {
    const seed = await new Promise<Torrent>((resolve, reject) => {
      seeder.on("error", reject);
      seeder.seed(source, { announce: [] }, resolve);
    });
    const response = await api.handle(
      new Request("http://localhost/api/torrents", {
        body: JSON.stringify({
          paused: false,
          source: `${seed.magnetURI}&x.pe=127.0.0.1:${seeder.torrentPort}`,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      })
    );
    expect(response.status).toBe(200);
    const { id }: { id: string } = await response.json();
    const state = await waitFor(
      async () =>
        (
          await api.handle(new Request(`http://localhost/api/state?selected=${id}`))
        ).json() as Promise<DashboardState>,
      (value) => value.detail?.status === "seeding"
    );
    expect(state.detail?.progress).toBe(1);
    expect(state.detail?.downloaded).toBe(bytes.length);
    expect(state.detail?.files).toHaveLength(1);
    const content = await api.handle(
      new Request(`http://localhost/api/torrents/${id}/files/0/content`)
    );
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(Bun.SHA256.hash(bytes, "hex"));
  } finally {
    await sync.close();
    await engine.close();
    await new Promise<void>((resolve) => seeder.destroy(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  }
});
