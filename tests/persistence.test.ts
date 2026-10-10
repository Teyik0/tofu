import { expect, test } from "bun:test";
import { join } from "node:path";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import type { DashboardState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json, network, waitFor } from "./helpers";

test("pausing immediately after an active restart preserves completed file progress and access", async () => {
  const context = await fixture(65_536, []);
  let reopened: TorrentEngine | undefined;
  try {
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    await waitFor(
      async () => context.engine.detail(id),
      (value) => value.status === "seeding"
    );
    await context.engine.close();
    reopened = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const app = createTestApi(() => reopened as TorrentEngine, context.sync.options);
    const pause = await app.handle(
      new Request(`http://localhost/api/torrents/${id}/pause`, json({}))
    );
    expect(pause.status).toBe(200);
    const detail = (await (
      await app.handle(new Request(`http://localhost/api/torrents/${id}`))
    ).json()) as import("../src/types").TorrentDetail;
    expect(detail.status).toBe("paused");
    expect(detail.files[0]?.progress).toBe(1);
    expect(detail.files[0]?.downloaded).toBe(context.bytes.length);
    const file = await app.handle(
      new Request(`http://localhost/api/torrents/${id}/files/0/content`)
    );
    expect(file.status).toBe(200);
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array(context.bytes));
  } finally {
    await reopened?.close();
    await context.close();
  }
});

test("background preference survives restart and older settings requests preserve it", async () => {
  const context = await fixture(1024, []);
  let reopened: TorrentEngine | undefined;
  try {
    const response = await context.request("/settings", {
      ...json({ ...context.engine.settings, runInBackground: true }),
      method: "PUT",
    });
    expect(response.status).toBe(200);
    expect((await response.json()).runInBackground).toBe(true);
    await context.engine.close();
    reopened = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const app = createTestApi(() => reopened as TorrentEngine, context.sync.options);
    const saved = await app.handle(
      new Request("http://localhost/api/settings", {
        ...json({
          downloadLimit: -1,
          downloadPath: reopened.settings.downloadPath,
          uploadLimit: -1,
        }),
        method: "PUT",
      })
    );
    expect((await saved.json()).runInBackground).toBe(true);
  } finally {
    await reopened?.close();
    await context.close();
  }
});

test("a paused download survives restart with its files, trackers and traffic totals", async () => {
  const context = await fixture(65_536, []);
  let reopened: TorrentEngine | undefined;
  try {
    const { id }: { id: string } = await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json();
    const read = () =>
      context
        .request(`/state?selected=${id}`, undefined)
        .then((response) => response.json() as Promise<DashboardState>);
    await waitFor(read, (state) => state.detail?.status === "seeding");
    await context.request(`/torrents/${id}/pause`, json({}));
    const before = await read();
    await context.engine.close();
    reopened = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const app = createTestApi(() => reopened as TorrentEngine, context.sync.options);
    const restored: DashboardState = await (
      await app.handle(new Request(`http://localhost/api/state?selected=${id}`))
    ).json();
    expect(restored.torrents).toHaveLength(1);
    expect(restored.detail?.status).toBe("paused");
    expect(restored.detail?.progress).toBe(1);
    expect(restored.detail?.received).toBe(before.detail?.received);
    const file = await app.handle(
      new Request(`http://localhost/api/torrents/${id}/files/0/content`)
    );
    expect(Bun.SHA256.hash(await file.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    await app.handle(new Request(`http://localhost/api/torrents/${id}/resume`, json({})));
    await waitFor(
      async () =>
        (
          await app.handle(new Request(`http://localhost/api/state?selected=${id}`))
        ).json() as Promise<DashboardState>,
      (state) => state.detail?.status === "seeding"
    );
  } finally {
    await reopened?.close();
    await context.close();
  }
}, 30_000);
