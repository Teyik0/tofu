import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import WebTorrent, { type Torrent } from "webtorrent";
import { WorkerTorrentEngine } from "../src/api/modules/torrents/worker-client";
import type { ConnectionDiagnostics, DashboardState } from "../src/types";
import { createTestApi } from "./helpers/application";
import { openTestDatabase } from "./helpers/database";
import { expectSuccess } from "./helpers/problem";
import { network, torrentBytes, waitFor } from "./helpers/torrent";

test.each([false, true])(
  "isolated engine exposes real MSE diagnostics only with explicit opt-in (%s)",
  async (enabled) => {
    await using resources = new AsyncDisposableStack();
    const directory = await mkdtemp(join(tmpdir(), "tofu-crypto-worker-"));
    resources.defer(() => rm(directory, { force: true, recursive: true }));
    const bytes = crypto.getRandomValues(new Uint8Array(64 * 1024));
    const source = join(directory, "source.bin");
    await Bun.write(source, bytes);
    const seeder = new WebTorrent(network);
    resources.defer(() => new Promise<void>((resolve) => seeder.destroy(() => resolve())));
    const seed = await new Promise<Torrent>((resolve, reject) => {
      seeder.once("error", reject);
      seeder.seed(source, { announce: [] }, resolve);
    });
    const sync = await openTestDatabase(join(directory, "sync"));
    resources.defer(() => sync.close());
    const previous = process.env.TOFU_CRYPTO_DIAGNOSTICS;
    let engine: WorkerTorrentEngine;
    try {
      if (enabled) {
        process.env.TOFU_CRYPTO_DIAGNOSTICS = "1";
      } else {
        delete process.env.TOFU_CRYPTO_DIAGNOSTICS;
      }
      engine = await WorkerTorrentEngine.open({
        dataDir: join(directory, "state"),
        downloadPath: join(directory, "downloads"),
        network,
      });
    } finally {
      if (previous === undefined) {
        delete process.env.TOFU_CRYPTO_DIAGNOSTICS;
      } else {
        process.env.TOFU_CRYPTO_DIAGNOSTICS = previous;
      }
    }
    resources.defer(() => engine.close());
    const api = await createTestApi(() => engine, sync.options);
    const client = treaty(api).api;
    const added = await client.torrents.post({
      paused: false,
      source: `${seed.magnetURI}&x.pe=127.0.0.1:${seeder.torrentPort}`,
    });
    expect(added.status).toBe(200);
    const { id } = expectSuccess(added) as { id: string };
    await waitFor(
      async () =>
        expectSuccess(await client.state.get({ query: { selected: id } })) as DashboardState,
      (state) => state.detail?.status === "seeding"
    );
    const file = await client.torrents({ id }).files({ index: "0" }).content.get();
    expect(file.status).toBe(200);
    expect(Bun.SHA256.hash(torrentBytes(file), "hex")).toBe(Bun.SHA256.hash(bytes, "hex"));
    const response = await client.diagnostics.connections.get();
    expect(response.status).toBe(200);
    const diagnostics = expectSuccess(response) as ConnectionDiagnostics;
    if (enabled) {
      expect(diagnostics.crypto).not.toBeNull();
      expect(diagnostics.crypto?.attempts).toBeGreaterThan(0);
      expect(diagnostics.crypto?.failures).toBe(0);
      expect(diagnostics.crypto?.totalConstructorMilliseconds).toBeGreaterThan(0);
      expect(diagnostics.crypto?.maxConstructorMilliseconds).toBeGreaterThan(0);
    } else {
      expect(diagnostics.crypto).toBeNull();
    }
  }
);
