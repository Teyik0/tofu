// biome-ignore-all lint/performance/noAwaitInLoops: seed and register demo fixtures sequentially.
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Server as Tracker } from "bittorrent-tracker";
import WebTorrent, { type Torrent } from "webtorrent";
import { currentInstanceConfig } from "../src/api/lib/instance";

const { dataDir, profile } = await currentInstanceConfig();
const serverInfo = Bun.file(join(dataDir, "server.json"));
const saved = (await serverInfo.exists()) ? ((await serverInfo.json()) as { url: string }) : null;
if (!saved) {
  throw new Error("Start the Tofu development instance before running the demo");
}
const { url } = saved;
const target = (await fetch(`${url}/api/instance`).then((response) => response.json())) as {
  profile: string;
};
if (profile !== "dev" || target.profile !== "dev") {
  throw new Error("The demo is restricted to the Tofu development profile");
}
const directory = join(import.meta.dir, "../.cache/demo-source");
await mkdir(directory, { recursive: true });
const tracker = new Tracker({ http: true, stats: false, udp: false, ws: false });
await new Promise<void>((resolve) => tracker.listen(0, "127.0.0.1", resolve));
const address = tracker.http.address();
if (!address || typeof address === "string") {
  throw new Error("The tracker did not start");
}
const announce = `http://127.0.0.1:${address.port}/announce`;
const client = new WebTorrent({
  dht: false,
  lsd: false,
  natPmp: false,
  natUpnp: false,
  utp: false,
});
client.throttleUpload(384 * 1024);
const examples = [
  { length: 2048, name: "Demo — Welcome to Tofu.txt", paused: false },
  { length: 32 * 1024 * 1024, name: "Demo — Local transfer.bin", paused: false },
  { length: 64 * 1024, name: "Demo — Download later.bin", paused: true },
];
for (const example of examples) {
  const path = join(directory, example.name);
  if (!(await Bun.file(path).exists())) {
    await Bun.write(
      path,
      example.name.endsWith(".txt")
        ? "Welcome to Tofu. This file was downloaded from a real local peer.\n".repeat(28)
        : randomBytes(example.length)
    );
  }

  const torrent = await new Promise<Torrent>((resolve) =>
    client.seed(path, { announce: [announce] }, resolve)
  );
  const body = new FormData();
  body.set("file", new File([new Uint8Array(torrent.torrentFile)], `${example.name}.torrent`));
  body.set("paused", String(example.paused));

  const response = await fetch(`${url}/api/torrents/file`, { body, method: "POST" });
  if (!response.ok && response.status !== 409) {
    throw new Error(await response.text());
  }
  if (response.ok) {
    const result = (await response.json()) as { id: string };
    if (!example.paused) {
      await fetch(`${url}/api/torrents/${result.id}/peers`, {
        body: JSON.stringify({ peer: `127.0.0.1:${client.torrentPort}` }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
    }
  }
}
console.log(
  `Three demo torrents are available at ${url}. Keep this terminal open so the peer and tracker remain active.`
);
const close = async () => {
  await new Promise<void>((resolve) => client.destroy(() => resolve()));
  await new Promise<void>((resolve) => tracker.close(resolve));
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
