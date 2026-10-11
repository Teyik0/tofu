import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../src/api";
import { resolveInstanceConfig } from "../src/api/lib/instance";
import { openTestDatabase } from "./helpers/database";
import { expectSuccess } from "./helpers/problem";
import { launchServer } from "./helpers/server-process";
import { openSyncBrowser } from "./helpers/sync-browser";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

test("worker sync wakes browsers after commit and stops telemetry when the last browser closes", async () => {
  await using resources = new AsyncDisposableStack();
  const context = await fixture(512 * 1024, []);
  resources.defer(context.close);
  const config = resolveInstanceConfig({
    dataDir: join(context.directory, "background-state"),
    desktop: false,
    downloadPath: join(context.directory, "background-downloads"),
    homeDir: context.directory,
    platform: process.platform,
    port: "0",
    profile: "dev",
  });
  const server = launchServer(config);
  resources.defer(server.stop);
  const origin = await server.ready();
  const client = treaty<Api>(origin).api;
  const journal = await openTestDatabase(config.dataDir);
  resources.defer(journal.close);
  expectSuccess(await client.settings.patch({ downloadLimit: 64 * 1024 }));
  const { id } = expectSuccess(
    await client.torrents.post({ paused: false, source: context.magnet })
  );
  await waitFor(
    async () => expectSuccess(await client.torrents({ id }).get()),
    (detail) => detail.received >= 64 * 1024
  );
  await Bun.sleep(100);
  const backgroundCursor = await journal.options.adapter.currentCursor();
  const before = expectSuccess(await client.torrents({ id }).get());
  await Bun.sleep(1500);
  expect(expectSuccess(await client.torrents({ id }).get()).received).toBeGreaterThan(
    before.received
  );
  expect(await journal.options.adapter.currentCursor()).toBe(backgroundCursor);
  expect(expectSuccess(await client.state.get()).history).toHaveLength(0);

  const first = await openSyncBrowser(origin);
  resources.defer(first.close);
  const second = await openSyncBrowser(origin);
  resources.defer(second.close);
  await waitFor(
    async () => second.cursor,
    (cursor) => cursor !== undefined && BigInt(cursor) > BigInt(backgroundCursor)
  );
  expect(first.cursor).toBe(second.cursor);
  const visibleCursor = second.cursor;
  const changes = await journal.options.adapter.readChanges({
    after: backgroundCursor,
    limit: 100,
  });
  expect(
    changes.changes.some((change) =>
      change.invalidations.some(
        (invalidation) => invalidation.kind === "path" && invalidation.path === "/"
      )
    )
  ).toBe(true);
  const state = expectSuccess(await client.state.get());
  expect(state.session.downloadSpeed).toBeGreaterThan(0);
  await waitFor(
    async () => expectSuccess(await client.state.get()).history.length,
    (length) => length > 0
  );

  await first.close();
  await waitFor(
    async () => second.cursor,
    (cursor) => cursor !== undefined && cursor !== visibleCursor
  );
  await second.close();
  await Bun.sleep(100);
  const closedCursor = await journal.options.adapter.currentCursor();
  const closedHistory = expectSuccess(await client.state.get()).history;
  await Bun.sleep(1500);
  expect(await journal.options.adapter.currentCursor()).toBe(closedCursor);
  expect(expectSuccess(await client.state.get()).history).toEqual(closedHistory);

  await waitFor(
    async () => expectSuccess(await client.torrents({ id }).get()),
    (detail) => detail.status === "seeding"
  );
  await waitFor(
    () => journal.options.adapter.currentCursor(),
    (cursor) => BigInt(cursor) > BigInt(closedCursor)
  );
  const reopened = await openSyncBrowser(origin);
  resources.defer(reopened.close);
  await waitFor(
    async () => reopened.cursor,
    (cursor) => cursor !== undefined && BigInt(cursor) > BigInt(closedCursor)
  );
  expect(expectSuccess(await client.torrents({ id }).get()).progress).toBe(1);
  const bytes = torrentBytes(await client.torrents({ id }).files({ index: "0" }).content.get());
  expect(Bun.SHA256.hash(bytes, "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
  const completedCursor = reopened.cursor;
  await waitFor(
    async () => expectSuccess(await client.state.get()).session.downloadSpeed,
    (speed) => speed === 0
  );
  await waitFor(
    async () => reopened.cursor,
    (cursor) => cursor !== undefined && cursor !== completedCursor
  );
}, 30_000);
