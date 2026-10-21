import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebTorrent, { type Torrent } from "webtorrent";

export async function peer(length?: number, filename?: string) {
  const directory = await mkdtemp(join(tmpdir(), "tofu-peer-"));
  const resources = new AsyncDisposableStack();
  resources.defer(() => rm(directory, { force: true, recursive: true }));
  try {
    const bytes = randomBytes(length ?? 65_536);
    const name = filename ?? "Example - 01.mkv";
    const source = join(directory, name);
    await Bun.write(source, bytes);
    const client = new WebTorrent({
      dht: false,
      lsd: false,
      natPmp: false,
      natUpnp: false,
      tracker: false,
      utp: false,
    });
    resources.defer(
      () =>
        new Promise<void>((resolve, reject) =>
          client.destroy((error) => (error ? reject(error) : resolve()))
        )
    );
    const torrent = await new Promise<Torrent>((resolve, reject) => {
      client.once("error", reject);
      client.seed(source, { announce: [] }, resolve);
    });
    if (!client.listening) {
      await once(client, "listening");
    }
    return {
      bytes,
      filename: name,
      id: torrent.infoHash,
      magnet: `${torrent.magnetURI}&x.pe=127.0.0.1:${client.torrentPort}`,
      [Symbol.asyncDispose]: resources.disposeAsync.bind(resources),
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}
