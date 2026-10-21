import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import type { OpenedTorrent } from "../src/types";
import { expectSuccess } from "./helpers/problem";
import { fixture, waitFor } from "./helpers/torrent";

test("a thread adds new .torrent files saved in its folder and applies its own deletion setting", async () => {
  await using resources = new AsyncDisposableStack();
  const context = await fixture(16 * 1024, []);
  resources.defer(context.close);
  const folder = join(context.directory, "anime");
  await mkdir(folder, { recursive: true });
  const earlier = join(folder, "earlier.torrent");
  await Bun.write(earlier, context.seed.torrentFile);
  await Bun.sleep(20);

  const thread = expectSuccess(
    await context.client.destinations.post({
      autoAddTorrentFiles: true,
      deleteTorrentFileAfterAdd: true,
      downloadPath: folder,
      name: "Anime",
    })
  );
  expect(thread.autoAddTorrentFilesSince).toEqual(expect.any(Number));
  const duplicate = await context.client.destinations.post({
    autoAddTorrentFiles: true,
    downloadPath: folder,
    name: "Duplicate",
  });
  expect(duplicate.status).toBe(409);

  const saved = join(folder, "saved.torrent");
  await Bun.write(saved, context.seed.torrentFile);
  const torrent = await waitFor(
    async () =>
      expectSuccess(await context.client.state.get()).torrents.find(
        (item) => item.id === context.seed.infoHash
      ),
    Boolean
  );
  expect(torrent?.destinationId).toBe(thread.id);
  await waitFor(
    () => Bun.file(saved).exists(),
    (exists) => !exists
  );
  // Files that were already in the folder when the option was enabled are left alone.
  expect(await Bun.file(earlier).exists()).toBe(true);
  expect(expectSuccess(await context.client.settings.get()).deleteTorrentFileAfterAdd).toBe(false);
}, 30_000);

test("a .torrent file opened from the system waits for the user to choose its thread", async () => {
  await using resources = new AsyncDisposableStack();
  const context = await fixture(16 * 1024, []);
  resources.defer(context.close);
  const folder = join(context.directory, "series");
  const series = expectSuccess(
    await context.client.destinations.post({
      deleteTorrentFileAfterAdd: false,
      downloadPath: folder,
      name: "Series",
    })
  );
  expectSuccess(await context.client.settings.patch({ deleteTorrentFileAfterAdd: true }));
  const source = join(folder, "opened.torrent");
  await Bun.write(source, context.seed.torrentFile);

  const controller = new AbortController();
  resources.defer(() => controller.abort());
  const { data: stream } = await context.client.desktop.openings.get({
    fetch: { signal: controller.signal },
  });
  if (!stream) {
    throw new Error("The openings stream did not start");
  }
  const events = stream[Symbol.asyncIterator]();
  expect((await events.next()).value?.data).toEqual([]);

  const { shown, messages } = expectSuccess(
    await treaty(context.api).__test.desktop.open.post({ path: source })
  );
  expect(messages).toEqual([]);
  expect(shown).toBe(1);
  const [opened] = ((await events.next()).value?.data ?? []) as OpenedTorrent[];
  expect(opened).toMatchObject({
    destinationId: series.id,
    existing: null,
    infoHash: context.seed.infoHash,
    length: 16 * 1024,
  });
  // The torrent is only added once the user confirms the dialog.
  expect(expectSuccess(await context.client.state.get()).torrents).toEqual([]);

  const added = expectSuccess(
    await context.client.desktop
      .openings({ id: opened?.id ?? "" })
      .post({ destinationId: series.id, paused: true })
  );
  expect(added.id).toBe(context.seed.infoHash);
  expect((await events.next()).value?.data).toEqual([]);
  const detail = expectSuccess(await context.client.torrents({ id: added.id }).get());
  expect(detail).toMatchObject({ destinationId: series.id, status: "paused" });
  // The thread keeps its .torrent files even though the global setting deletes them.
  expect(await Bun.file(source).exists()).toBe(true);
  const missing = await context.client.desktop.openings({ id: opened?.id ?? "" }).delete();
  expect(missing.status).toBe(404);
}, 30_000);
