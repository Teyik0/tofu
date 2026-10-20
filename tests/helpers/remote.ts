import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import WebTorrent, { type Torrent } from "webtorrent";
import type { Api } from "../../src/api";
import { resolveInstanceConfig } from "../../src/api/lib/instance";
import { launchServer } from "./server-process";
import { network, waitFor } from "./torrent";

/**
 * A real headless Tofu process in temporary directories, plus a real WebTorrent peer seeding one
 * file. Remote access starts disabled, so loopback requests act for the server owner.
 */
export async function remoteServerFixture(length: number, filename?: string, content?: Uint8Array) {
  const directory = await mkdtemp(join(tmpdir(), "tofu-remote-"));
  const config = resolveInstanceConfig({
    dataDir: join(directory, "state"),
    desktop: false,
    downloadPath: join(directory, "downloads"),
    homeDir: directory,
    platform: process.platform,
    port: "0",
    profile: "dev",
  });
  const bytes = content ? new Uint8Array(content) : crypto.getRandomValues(new Uint8Array(length));
  const source = join(directory, "seed", filename ?? "Show - 01.mkv");
  await Bun.write(source, bytes);
  const seeder = new WebTorrent(network);
  const server = launchServer(config);
  try {
    const [seed, url] = await Promise.all([
      new Promise<Torrent>((resolve, reject) => {
        seeder.once("error", reject);
        seeder.seed(source, { announce: [] }, resolve);
      }),
      server.ready(),
    ]);
    return {
      bytes,
      /** Waits until the server holds the seeded file completely. */
      async complete(id: string) {
        const owner = treaty<Api>(url).api;
        return await waitFor(
          async () => (await owner.torrents({ id }).get()).data,
          (detail) => detail?.progress === 1,
          30_000
        );
      },
      config,
      directory,
      seed,
      seeder,
      server,
      url,
      async [Symbol.asyncDispose]() {
        try {
          await server.stop();
        } finally {
          await new Promise<void>((resolve) => seeder.destroy(() => resolve()));
          await rm(directory, { force: true, recursive: true });
        }
      },
    };
  } catch (error) {
    await server.stop();
    await new Promise<void>((resolve) => seeder.destroy(() => resolve()));
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

/** Cookie pair from a Set-Cookie response header, as a browser would send it back. */
export function sessionCookie(response: Response) {
  const header = response.headers.get("set-cookie");
  if (!header) {
    throw new Error("The server did not set a session cookie");
  }
  return header.split(";")[0] ?? "";
}

export function redemptionNonce() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}
