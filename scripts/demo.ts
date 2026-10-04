// biome-ignore-all lint/performance/noAwaitInLoops: seed and register demo fixtures sequentially.
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server as Tracker } from "bittorrent-tracker";
import WebTorrent, { type Torrent } from "webtorrent";

const dataDir = process.env.TOFU_DATA_DIR ?? join(homedir(), "Library/Application Support/Tofu");
const serverInfo = Bun.file(join(dataDir, "server.json"));
const saved = (await serverInfo.exists()) ? ((await serverInfo.json()) as { url: string }) : null;
const url = Bun.argv[2] ?? saved?.url ?? "http://127.0.0.1:3030";
const directory = join(import.meta.dir, "../.cache/demo-source");
await mkdir(directory, { recursive: true });
const tracker = new Tracker({ http: true, stats: false, udp: false, ws: false });
await new Promise<void>((resolve) => tracker.listen(0, "127.0.0.1", resolve));
const address = tracker.http.address();
if (!address || typeof address === "string") {
  throw new Error("Le tracker ne démarre pas");
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
  { length: 2048, name: "Démo — Bienvenue dans Tofu.txt", paused: false },
  { length: 32 * 1024 * 1024, name: "Démo — Transfert local.bin", paused: false },
  { length: 64 * 1024, name: "Démo — À télécharger plus tard.bin", paused: true },
];
for (const example of examples) {
  const path = join(directory, example.name);
  if (!(await Bun.file(path).exists())) {
    await Bun.write(
      path,
      example.name.endsWith(".txt")
        ? "Bienvenue dans Tofu. Ce fichier a été téléchargé depuis un vrai pair local.\n".repeat(28)
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
  `Trois torrents de démonstration sont disponibles dans ${url}. Gardez ce terminal ouvert pour que le pair et le tracker restent actifs.`
);
const close = async () => {
  await new Promise<void>((resolve) => client.destroy(() => resolve()));
  await new Promise<void>((resolve) => tracker.close(resolve));
  process.exit(0);
};
process.on("SIGINT", close);
process.on("SIGTERM", close);
