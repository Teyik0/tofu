// biome-ignore-all lint/performance/noAwaitInLoops: poll observable network state sequentially
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import WebTorrent, { type Torrent } from "webtorrent";
import { TorrentEngine } from "../../src/api/modules/torrents/service";
import { createTestApi } from "./application";
import { openTestDatabase } from "./database";
import { expectSuccess } from "./problem";
export const network = {
  dht: false,
  lsd: false,
  natPmp: false,
  natUpnp: false,
  tracker: false,
  utp: false,
};
export function json(body: object): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  };
}
export async function waitFor<T>(
  read: () => Promise<T>,
  ready: (value: T) => boolean,
  timeoutMs?: number
) {
  const until = Date.now() + (timeoutMs ?? 15_000);
  while (Date.now() < until) {
    const value = await read();
    if (ready(value)) {
      return value;
    }
    await Bun.sleep(30);
  }
  throw new Error("The expected condition was not reached");
}
export async function fixture(length: number, trackers: string[], filename?: string) {
  const directory = await mkdtemp(join(tmpdir(), "tofu-test-"));
  const bytes = randomBytes(length);
  const source = join(directory, filename ?? "source.bin");
  await Bun.write(source, bytes);
  const seeder = new WebTorrent({ ...network, tracker: trackers.length > 0 });
  const seed = await new Promise<Torrent>((resolve, reject) => {
    seeder.on("error", reject);
    seeder.seed(source, { announce: trackers }, resolve);
  });
  const engine = await TorrentEngine.open({
    dataDir: join(directory, "state"),
    downloadPath: join(directory, "downloads"),
    network: { ...network, tracker: trackers.length > 0 },
  });
  const sync = await openTestDatabase(join(directory, "state"));
  const api = await createTestApi(() => engine, sync.options);
  return {
    api,
    bytes,
    client: treaty<typeof api>("http://localhost", {
      fetcher: Object.assign(
        (input: RequestInfo | URL, init?: RequestInit) => api.handle(new Request(input, init)),
        { preconnect: fetch.preconnect }
      ),
    }).api,
    async close() {
      await sync.close();
      await Promise.all([
        engine.close(),
        new Promise<void>((resolve) => seeder.destroy(() => resolve())),
      ]);
      await rm(directory, { force: true, recursive: true });
    },
    directory,
    engine,
    magnet: `${seed.magnetURI}&x.pe=127.0.0.1:${seeder.torrentPort}`,
    seed,
    seeder,
    sync,
  };
}
export function torrentBytes(result: { data: unknown; error: unknown; status: number }) {
  const data = expectSuccess(result);
  if (!(data instanceof ArrayBuffer)) {
    throw new Error("The torrent content response must contain binary data");
  }
  return data;
}
