import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { Api } from "../src/api";
import { resolveInstanceConfig } from "../src/api/lib/instance";
import type { LiveState } from "../src/types";
import { openTestDatabase } from "./helpers/database";
import { expectSuccess } from "./helpers/problem";
import { launchServer } from "./helpers/server-process";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

async function collect(
  stream: AsyncIterable<{ data: LiveState }>,
  signal: AbortSignal,
  snapshots: LiveState[]
) {
  try {
    for await (const event of stream) {
      snapshots.push(event.data);
    }
  } catch (error) {
    if (!signal.aborted) {
      throw error;
    }
  }
}

test("live streams publish worker snapshots with the selected detail without sync writes and stop telemetry after the last stream closes", async () => {
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
  const cursor = await journal.options.adapter.currentCursor();
  const before = expectSuccess(await client.torrents({ id }).get());
  await Bun.sleep(1500);
  expect(expectSuccess(await client.torrents({ id }).get()).received).toBeGreaterThan(
    before.received
  );
  expect(expectSuccess(await client.state.get()).history).toHaveLength(0);

  const firstAbort = new AbortController();
  const secondAbort = new AbortController();
  resources.defer(() => {
    firstAbort.abort();
    secondAbort.abort();
  });
  const first = expectSuccess(
    await client.live.get({ fetch: { signal: firstAbort.signal }, query: { selected: "missing" } })
  );
  const second = expectSuccess(
    await client.live.get({ fetch: { signal: secondAbort.signal }, query: { selected: id } })
  );
  const firstSnapshots: LiveState[] = [];
  const secondSnapshots: LiveState[] = [];
  const firstReading = collect(first, firstAbort.signal, firstSnapshots);
  const secondReading = collect(second, secondAbort.signal, secondSnapshots);
  await waitFor(
    () => firstSnapshots.at(-1),
    (state) => state !== undefined && state.session.downloadSpeed > 0 && state.history.length > 0
  );
  await waitFor(
    () => secondSnapshots.at(-1),
    (state) => state !== undefined && state.history.length > 0
  );
  expect(secondSnapshots.every((state) => state.detail?.id === id)).toBe(true);
  expect(firstSnapshots.length).toBeGreaterThan(1);
  expect(firstSnapshots.every((state) => state.detail === null)).toBe(true);
  expect(await journal.options.adapter.currentCursor()).toBe(cursor);

  firstAbort.abort();
  await firstReading;
  const received = secondSnapshots.length;
  await waitFor(
    () => secondSnapshots.length,
    (length) => length > received
  );
  secondAbort.abort();
  await secondReading;
  await Bun.sleep(100);
  const closedHistory = expectSuccess(await client.state.get()).history;
  await Bun.sleep(1500);
  expect(expectSuccess(await client.state.get()).history).toEqual(closedHistory);

  await waitFor(
    async () => expectSuccess(await client.torrents({ id }).get()),
    (detail) => detail.status === "seeding"
  );
  const reopenedAbort = new AbortController();
  resources.defer(() => reopenedAbort.abort());
  const reopened = expectSuccess(
    await client.live.get({ fetch: { signal: reopenedAbort.signal } })
  );
  const { value: snapshot } = await reopened.next();
  expect(snapshot?.data.torrents.find((torrent) => torrent.id === id)?.progress).toBe(1);
  reopenedAbort.abort();
  const bytes = torrentBytes(await client.torrents({ id }).files({ index: "0" }).content.get());
  expect(Bun.SHA256.hash(bytes, "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
  expect(await journal.options.adapter.currentCursor()).toBe(cursor);
}, 30_000);
