// biome-ignore-all lint/performance/noAwaitInLoops: poll observable network state sequentially
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebTorrent, { type Torrent } from "webtorrent";
import { createApi } from "../src/server/api";
import { TorrentEngine } from "../src/server/engine";
import { createTofuSync } from "../src/server/sync";

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

export async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const value = await read();
    if (ready(value)) {
      return value;
    }
    await Bun.sleep(30);
  }
  throw new Error("La condition attendue n'a pas été atteinte");
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
  const sync = await createTofuSync(join(directory, "sync"));
  const api = createApi(() => engine, sync.options);
  return {
    api,
    bytes,
    async close() {
      sync.close();
      await Promise.all([
        engine.close(),
        new Promise<void>((resolve) => seeder.destroy(() => resolve())),
      ]);
      await rm(directory, { force: true, recursive: true });
    },
    directory,
    engine,
    magnet: `${seed.magnetURI}&x.pe=127.0.0.1:${seeder.torrentPort}`,
    request(path: string, init: RequestInit | undefined) {
      return api.handle(new Request(`http://localhost/api${path}`, init));
    },
    seed,
    seeder,
    sync,
  };
}
