import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { databaseMigrationsPlugin } from "../scripts/database-migrations";
import { WorkerTorrentEngine } from "../src/api/modules/torrents/worker-client";
import type { DashboardState, TorrentDetail } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json, network, waitFor } from "./helpers";

test.each(["source", "bundle", "host"])(
  "the %s isolated engine transfers from a real peer through the public API",
  async (mode) => {
    const cache = join(import.meta.dir, "../.cache");
    await mkdir(cache, { recursive: true });
    const bundle = await mkdtemp(join(cache, "worker-test-"));
    const context = await fixture(256 * 1024, []);
    let opened: WorkerTorrentEngine | undefined;
    try {
      let Engine = WorkerTorrentEngine;
      if (mode !== "source") {
        const outdir = mode === "host" ? join(bundle, "furin") : bundle;
        const result = await Bun.build({
          entrypoints: [join(import.meta.dir, "../src/api/modules/torrents/worker-client.ts")],
          outdir,
          plugins: [databaseMigrationsPlugin],
          target: "bun",
        });
        if (!result.success) {
          throw new AggregateError(result.logs, "Worker client build failed");
        }
        let client = join(outdir, "worker-client.js");
        if (mode === "host") {
          await mkdir(join(bundle, "bun"));
          const host = join(bundle, "bun/worker-client.js");
          await rename(client, host);
          client = host;
        }
        const module: { WorkerTorrentEngine: typeof WorkerTorrentEngine } = await import(
          pathToFileURL(client).href
        );
        Engine = module.WorkerTorrentEngine;
      }
      const engine = await Engine.open({
        dataDir: join(context.directory, "worker-state"),
        downloadPath: join(context.directory, "worker-downloads"),
        network,
      });
      opened = engine;
      const api = await createTestApi(() => engine, context.sync.options);
      const request = (path: string, init: RequestInit | undefined) =>
        api.handle(new Request(`http://localhost/api${path}`, init));
      const added = await request("/torrents", json({ paused: false, source: context.magnet }));
      expect(added.status).toBe(200);
      const { id } = (await added.json()) as { id: string };
      await waitFor(
        async () =>
          (await (await request(`/state?selected=${id}`, undefined)).json()) as DashboardState,
        (state) => state.detail?.status === "seeding"
      );
      const file = await request(`/torrents/${id}/files/0/content`, undefined);
      expect(file.status).toBe(200);
      expect(Bun.SHA256.hash(await file.arrayBuffer(), "hex")).toBe(
        Bun.SHA256.hash(context.bytes, "hex")
      );
      expect((await request("/health", undefined)).status).toBe(200);
    } finally {
      await opened?.close();
      await context.close();
      await rm(bundle, { force: true, recursive: true });
    }
  }
);

test("isolated engine lifecycle preserves files and public errors across restart", async () => {
  const context = await fixture(128 * 1024, []);
  const options = {
    dataDir: join(context.directory, "worker-state"),
    downloadPath: join(context.directory, "worker-downloads"),
    network,
  };
  let engine = await WorkerTorrentEngine.open(options);
  let api = await createTestApi(() => engine, context.sync.options);
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    expect((await request("/torrents/missing/pause", json({}))).status).toBe(404);
    expect((await request("/torrents", json({ paused: false, source: "invalid" }))).status).toBe(
      400
    );
    const added = await request("/torrents", json({ paused: false, source: context.magnet }));
    const { id } = (await added.json()) as { id: string };
    const detail = async () =>
      (await (await request(`/torrents/${id}`, undefined)).json()) as TorrentDetail;
    await waitFor(detail, (value) => value.status === "seeding");
    expect((await request(`/torrents/${id}/pause`, json({}))).status).toBe(200);
    expect(
      (await request(`/torrents/${id}/trackers`, { ...json({ urls: [] }), method: "PUT" })).status
    ).toBe(200);
    const retained = join(options.downloadPath, "source.bin");
    expect(Bun.SHA256.hash(await Bun.file(retained).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    await engine.close();
    engine = await WorkerTorrentEngine.open(options);
    api = await createTestApi(() => engine, context.sync.options);
    expect((await detail()).status).toBe("paused");
    expect((await request(`/torrents/${id}/resume`, json({}))).status).toBe(200);
    await waitFor(detail, (value) => value.status === "seeding");
    expect(
      (await request(`/torrents/${id}`, { ...json({ deleteFiles: false }), method: "DELETE" }))
        .status
    ).toBe(200);
    expect(await Bun.file(retained).exists()).toBe(true);
    expect((await request(`/torrents/${id}`, undefined)).status).toBe(404);
  } finally {
    await engine.close();
    await context.close();
  }
});

test("health and summaries stay responsive during peer handshakes", async () => {
  const context = await fixture(64 * 1024, []);
  await using resources = new AsyncDisposableStack();
  resources.defer(() => context.close());
  type PeerSocket = Awaited<ReturnType<typeof Bun.connect>>;
  const sockets = new Set<PeerSocket>();
  const handshakes = new Set<PeerSocket>();
  resources.defer(() => {
    for (const socket of sockets) {
      socket.terminate();
    }
  });
  const peers = Array.from({ length: 40 }, () => {
    const peer = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        close(socket) {
          sockets.delete(socket);
        },
        data(socket) {
          handshakes.add(socket);
        },
        open(socket) {
          sockets.add(socket);
        },
      },
    });
    resources.defer(() => peer.stop(true));
    return peer;
  });
  const engine = await WorkerTorrentEngine.open({
    dataDir: join(context.directory, "worker-state"),
    downloadPath: join(context.directory, "worker-downloads"),
    network: { ...network, maxConns: 100 },
  });
  resources.defer(() => engine.close());
  const api = await createTestApi(() => engine, context.sync.options);
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  const added = await request("/torrents", json({ paused: false, source: context.magnet }));
  const { id } = (await added.json()) as { id: string };
  const started = performance.now();
  const connecting = Promise.all(
    peers.map((peer) => request(`/torrents/${id}/peers`, json({ peer: `127.0.0.1:${peer.port}` })))
  );
  await Bun.sleep(20);
  const responses = await Promise.all([
    request("/health", undefined),
    request("/state?detail=false", undefined),
  ]);
  expect(responses.map((response) => response.status)).toEqual([200, 200]);
  expect(performance.now() - started).toBeLessThan(500);
  const results = await connecting;
  expect(results.every((response) => response.status === 200)).toBe(true);
  await waitFor(
    async () => handshakes.size,
    (count) => count >= peers.length
  );
});
