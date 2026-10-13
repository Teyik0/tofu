import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import type { DashboardState } from "../src/types";
import { createTestApi } from "./helpers/application";
import { expectSuccess } from "./helpers/problem";
import { fixture, network, torrentBytes, waitFor } from "./helpers/torrent";

test("torrent source deletion is opt-in, persists, and survives older settings requests", async () => {
  const context = await fixture(1024, []);
  let reopened: TorrentEngine | undefined;
  try {
    const initial = await context.client.settings.get();
    expect(expectSuccess(initial).deleteTorrentFileAfterAdd).toBe(false);
    const enabled = await context.client.settings.patch({ deleteTorrentFileAfterAdd: true });
    expect(enabled.status).toBe(200);
    expect(expectSuccess(enabled).deleteTorrentFileAfterAdd).toBe(true);
    await context.engine.close();
    reopened = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const app = await createTestApi(() => reopened as TorrentEngine, context.sync.options);
    const client = treaty(app).api;
    const saved = await client.settings.put({
      downloadLimit: -1,
      downloadPath: reopened.settings.downloadPath,
      uploadLimit: -1,
    });
    expect(saved.status).toBe(200);
    expect(expectSuccess(saved).deleteTorrentFileAfterAdd).toBe(true);
    const disabled = await client.settings.patch({ deleteTorrentFileAfterAdd: false });
    expect(expectSuccess(disabled).deleteTorrentFileAfterAdd).toBe(false);
  } finally {
    await reopened?.close();
    await context.close();
  }
});
test("pausing immediately after an active restart preserves completed file progress and access", async () => {
  const context = await fixture(65_536, []);
  let reopened: TorrentEngine | undefined;
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (value) => value.status === "seeding"
    );
    await context.engine.close();
    reopened = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const app = await createTestApi(() => reopened as TorrentEngine, context.sync.options);
    const client = treaty(app).api;
    const pause = await client.torrents({ id }).pause.post({});
    expect(pause.status).toBe(200);
    const detail = expectSuccess(
      await client.torrents({ id }).get()
    ) as import("../src/types").TorrentDetail;
    expect(detail.status).toBe("paused");
    expect(detail.files[0]?.progress).toBe(1);
    expect(detail.files[0]?.downloaded).toBe(context.bytes.length);
    const file = await client.torrents({ id }).files({ index: "0" }).content.get();
    expect(file.status).toBe(200);
    expect(new Uint8Array(torrentBytes(file))).toEqual(new Uint8Array(context.bytes));
  } finally {
    await reopened?.close();
    await context.close();
  }
});
test("background preference survives restart and older settings requests preserve it", async () => {
  const context = await fixture(1024, []);
  let reopened: TorrentEngine | undefined;
  try {
    const response = await context.client.settings.put({
      ...context.engine.settings,
      runInBackground: true,
    });
    expect(response.status).toBe(200);
    expect(expectSuccess(response).runInBackground).toBe(true);
    await context.engine.close();
    reopened = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const app = await createTestApi(() => reopened as TorrentEngine, context.sync.options);
    const client = treaty(app).api;
    const saved = await client.settings.put({
      downloadLimit: -1,
      downloadPath: reopened.settings.downloadPath,
      uploadLimit: -1,
    });
    expect(expectSuccess(saved).runInBackground).toBe(true);
  } finally {
    await reopened?.close();
    await context.close();
  }
});
test("a paused download survives restart with its files, trackers and traffic totals", async () => {
  const context = await fixture(65_536, []);
  let reopened: TorrentEngine | undefined;
  try {
    const { id }: { id: string } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = () =>
      context.client.state
        .get({ query: { selected: id } })
        .then((response) => expectSuccess(response) as DashboardState);
    await waitFor(read, (state) => state.detail?.status === "seeding");
    await context.client.torrents({ id }).pause.post({});
    const before = await read();
    await context.engine.close();
    reopened = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const app = await createTestApi(() => reopened as TorrentEngine, context.sync.options);
    const client = treaty(app).api;
    const restored: DashboardState = expectSuccess(
      await client.state.get({ query: { selected: id } })
    );
    expect(restored.torrents).toHaveLength(1);
    expect(restored.detail?.status).toBe("paused");
    expect(restored.detail?.progress).toBe(1);
    expect(restored.detail?.received).toBe(before.detail?.received);
    const file = await client.torrents({ id }).files({ index: "0" }).content.get();
    expect(Bun.SHA256.hash(torrentBytes(file), "hex")).toBe(Bun.SHA256.hash(context.bytes, "hex"));
    await client.torrents({ id }).resume.post({});
    await waitFor(
      async () =>
        expectSuccess(await client.state.get({ query: { selected: id } })) as DashboardState,
      (state) => state.detail?.status === "seeding"
    );
  } finally {
    await reopened?.close();
    await context.close();
  }
}, 30_000);
