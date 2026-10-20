import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import WebTorrent, { type Torrent } from "webtorrent";
import { defaultConnectionPolicy } from "../src/api/modules/torrents/connections";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import type { ConnectionDiagnostics, LibraryState } from "../src/types";
import { createTestApi } from "./helpers/application";
import { openTestDatabase } from "./helpers/database";
import { expectSuccess } from "./helpers/problem";
import { network, torrentBytes, waitFor } from "./helpers/torrent";

test("peer discovery bursts are paced while real bytes continue downloading", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-connections-"));
  const bytes = crypto.getRandomValues(new Uint8Array(512 * 1024));
  const source = join(directory, "source.bin");
  await Bun.write(source, bytes);
  const peers = Array.from(
    { length: 6 },
    () => new WebTorrent({ ...network, uploadLimit: 128 * 1024 })
  );
  const engine = await TorrentEngine.open({
    connectionPolicy: {
      attemptsPerSecond: 1,
      burst: 1,
      cooldownTtlMs: 30 * 60_000,
      maxConnections: 80,
      maxConnectionsPerTorrent: 40,
      maxCooldownEntries: 10_000,
      maxPending: 8,
      retryDelaysMs: [5000, 15_000, 45_000, 120_000, 300_000],
      seedAttemptsPerSecond: 0.5,
      seedBurst: 1,
      seedIntervalMs: 10_000,
      stableConnectionMs: 30_000,
    },
    dataDir: join(directory, "state"),
    downloadPath: join(directory, "downloads"),
    network,
  });
  const sync = await openTestDatabase(join(directory, "sync"));
  try {
    const seeds = await Promise.all(
      peers.map(
        (peer) =>
          new Promise<Torrent>((resolve, reject) => {
            peer.once("error", reject);
            peer.seed(source, { announce: [] }, resolve);
          })
      )
    );
    const api = await createTestApi(() => engine, sync.options);
    const client = treaty(api).api;
    const [first] = seeds;
    if (!first) {
      throw new Error("A real seeder is required");
    }
    const added = await client.torrents.post({ paused: false, source: first.magnetURI });
    expect(added.status).toBe(200);
    const { id } = expectSuccess(added) as { id: string };
    const accepted: number[] = [];
    for (const seed of seeds) {
      seed.on("wire", () => accepted.push(performance.now()));
    }
    const queuedAt = performance.now();
    const responses = await Promise.all(
      peers.map((peer) =>
        client.torrents({ id }).peers.post({ peer: `127.0.0.1:${peer.torrentPort}` })
      )
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    await waitFor(
      async () => accepted.length,
      (count) => count >= 3
    );
    const [, , thirdAt] = accepted;
    if (thirdAt === undefined) {
      throw new Error("Three real peer handshakes are required");
    } // Negotiation can delay the first wire; the rate limit starts when peers enter the queue.
    expect(thirdAt - queuedAt).toBeGreaterThanOrEqual(1500);
    const diagnostics = expectSuccess(
      await client.diagnostics.connections.get()
    ) as ConnectionDiagnostics;
    expect(diagnostics.deferredByRate).toBeGreaterThan(0);
    await waitFor(
      async () =>
        expectSuccess(await client.state.get({ query: { selected: id } })) as LibraryState,
      (state) => state.detail?.status === "seeding",
      25_000
    );
    const file = await client.torrents({ id }).files({ index: "0" }).content.get();
    expect(file.status).toBe(200);
    expect(Bun.SHA256.hash(torrentBytes(file), "hex")).toBe(Bun.SHA256.hash(bytes, "hex"));
  } finally {
    await engine.close();
    await sync.close();
    await Promise.all(
      peers.map((peer) => new Promise<void>((resolve) => peer.destroy(() => resolve())))
    );
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
test("repeated peer disconnects back off and pause cancels queued retries without losing bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-reconnect-"));
  const bytes = crypto.getRandomValues(new Uint8Array(512 * 1024));
  const source = join(directory, "source.bin");
  await Bun.write(source, bytes);
  const peer = new WebTorrent({ ...network, uploadLimit: 128 * 1024 });
  const engine = await TorrentEngine.open({
    connectionPolicy: {
      ...defaultConnectionPolicy,
      attemptsPerSecond: 20,
      burst: 2,
      retryDelaysMs: [1500],
      seedIntervalMs: 100,
    },
    dataDir: join(directory, "state"),
    downloadPath: join(directory, "downloads"),
    network,
  });
  const sync = await openTestDatabase(join(directory, "sync"));
  let disconnect = true;
  const accepted: number[] = [];
  try {
    const seed = await new Promise<Torrent>((resolve, reject) => {
      peer.once("error", reject);
      peer.seed(source, { announce: [] }, resolve);
    });
    seed.on("wire", (wire) => {
      accepted.push(performance.now());
      if (disconnect) {
        setTimeout(() => wire.destroy(), 150).unref();
      }
    });
    const api = await createTestApi(() => engine, sync.options);
    const client = treaty(api).api;
    const added = await client.torrents.post({
      paused: false,
      source: `${seed.magnetURI}&x.pe=127.0.0.1:${peer.torrentPort}`,
    });
    expect(added.status).toBe(200);
    const { id } = expectSuccess(added) as { id: string };
    await waitFor(
      async () => accepted.length,
      (count) => count >= 2
    );
    const [firstAt, secondAt] = accepted;
    if (firstAt === undefined || secondAt === undefined) {
      throw new Error("Two real peer handshakes are required");
    }
    expect(secondAt - firstAt).toBeGreaterThanOrEqual(1500);
    const { downloaded } = expectSuccess(await client.torrents({ id }).get());
    if (downloaded === null) {
      throw new Error("The real download must report verified bytes");
    }
    expect(downloaded).toBeGreaterThan(0);
    expect((await client.torrents({ id }).pause.post({})).status).toBe(200);
    expect(expectSuccess(await client.torrents({ id }).get()).downloaded).toBeGreaterThanOrEqual(
      downloaded
    );
    const readDiagnostics = async () =>
      expectSuccess(await client.diagnostics.connections.get()) as ConnectionDiagnostics;
    const diagnostics = await readDiagnostics();
    const attempts = diagnostics.outgoingAttempts;
    expect(diagnostics.outgoingRetries).toBeGreaterThan(0);
    const handshakes = accepted.length;
    await Bun.sleep(1800);
    expect((await readDiagnostics()).outgoingAttempts).toBe(attempts);
    expect(accepted.length).toBe(handshakes);
    disconnect = false;
    expect((await client.torrents({ id }).resume.post({})).status).toBe(200);
    await waitFor(
      async () =>
        expectSuccess(await client.state.get({ query: { selected: id } })) as LibraryState,
      (state) => state.detail?.status === "seeding",
      25_000
    );
    const file = await client.torrents({ id }).files({ index: "0" }).content.get();
    expect(Bun.SHA256.hash(torrentBytes(file), "hex")).toBe(Bun.SHA256.hash(bytes, "hex"));
  } finally {
    await engine.close();
    await sync.close();
    await new Promise<void>((resolve) => peer.destroy(() => resolve()));
    await rm(directory, { force: true, recursive: true });
  }
}, 30_000);
