import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/api/lib/db";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import type { Destination, LibraryState } from "../src/types";
import { createTestApi } from "./helpers/application";
import { expectSuccess } from "./helpers/problem";
import { fixture, network, torrentBytes, waitFor } from "./helpers/torrent";

test("pinned threads retain their selected icon after restart without changing downloaded data", async () => {
  const context = await fixture(8192, []);
  let restarted: TorrentEngine | null = null;
  try {
    const response = await context.client.destinations.post({
      downloadPath: join(context.directory, "series"),
      icon: "film",
      name: "Series",
      pinned: true,
    });
    expect(response.status).toBe(200);
    const destination = expectSuccess(response) as Destination;
    expect(destination).toMatchObject({ icon: "film", name: "Series", pinned: true });
    const { id } = expectSuccess(
      await context.client.torrents.post({
        destinationId: destination.id,
        paused: false,
        source: context.magnet,
      })
    ) as { id: string };
    await waitFor(
      async () =>
        expectSuccess(await context.client.state.get({ query: { selected: id } })) as LibraryState,
      (snapshot) => snapshot.detail?.status === "seeding"
    );
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const restored = restarted;
    const api = await createTestApi(() => restored, context.sync.options);
    const client = treaty(api).api;
    await waitFor(
      async () =>
        expectSuccess(await client.state.get({ query: { selected: id } })) as LibraryState,
      (snapshot) => snapshot.detail?.status === "seeding"
    );
    expect(
      expectSuccess(await client.host.get()).destinations.find((item) => item.id === destination.id)
    ).toEqual(destination);
    const content = await client.torrents({ id }).files({ index: "0" }).content.get();
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await restarted?.close();
    await context.close();
  }
});
test("pinning and changing icons preserve live transfers and older clients retain thread presentation", async () => {
  const context = await fixture(8192, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    const read = async () =>
      expectSuccess(await context.client.state.get({ query: { selected: id } })) as LibraryState;
    await waitFor(read, (state) => state.detail?.status === "seeding");
    const updated = await context.client
      .destinations({ id: "default" })
      .patch({ icon: "tv", pinned: true });
    expect(updated.status).toBe(200);
    const destination = expectSuccess(updated) as Destination;
    expect(destination).toMatchObject({ icon: "tv", pinned: true });
    const older = await context.client
      .destinations({ id: "default" })
      .put({ downloadPath: destination.downloadPath, name: "Saved thread" });
    expect(expectSuccess(older)).toMatchObject({ icon: "tv", name: "Saved thread", pinned: true });
    const invalid = await context.client
      .destinations({ id: "default" })
      .patch({ icon: "unsupported" as never, pinned: false });
    expect(invalid.status).toBe(422);
    expect((await read()).destinations[0]).toMatchObject({ icon: "tv", pinned: true });
    expect((await read()).detail?.status).toBe("seeding");
    const unpinned = await context.client.destinations({ id: "default" }).patch({ pinned: false });
    expect(expectSuccess(unpinned)).toMatchObject({ icon: "tv", pinned: false });
    const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
});
test("default thread icons and pinning persist without changing names, folders or transfers", async () => {
  const context = await fixture(8192, []);
  let restarted: TorrentEngine | null = null;
  try {
    const destination = expectSuccess(
      await context.client.destinations.post({
        downloadPath: join(context.directory, "saved"),
        name: "My saved thread",
      })
    ) as Destination;
    expect(destination).toMatchObject({ icon: "folder", pinned: false });
    const { id } = expectSuccess(
      await context.client.torrents.post({
        destinationId: destination.id,
        paused: false,
        source: context.magnet,
      })
    ) as { id: string };
    await waitFor(
      async () =>
        expectSuccess(await context.client.state.get({ query: { selected: id } })) as LibraryState,
      (state) => state.detail?.status === "seeding"
    );
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const restored = restarted;
    const api = await createTestApi(() => restored, context.sync.options);
    const client = treaty(api).api;
    const read = async () =>
      expectSuccess(await client.state.get({ query: { selected: id } })) as LibraryState;
    await waitFor(read, (state) => state.detail?.status === "seeding");
    expect(
      expectSuccess(await client.host.get()).destinations.find((item) => item.id === destination.id)
    ).toEqual(destination);
    const response = await client.torrents({ id }).files({ index: "0" }).content.get();
    expect(response.status).toBe(200);
    expect(Bun.SHA256.hash(torrentBytes(response), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await restarted?.close();
    await context.close();
  }
});
test("deleting a tab preserves real transfers and files and persists their default assignment", async () => {
  const context = await fixture(65_536, []);
  let restarted: TorrentEngine | null = null;
  try {
    const path = join(context.directory, "series");
    const destination = expectSuccess(
      await context.client.destinations.post({ downloadPath: path, name: "Series" })
    ) as { id: string };
    const { id } = expectSuccess(
      await context.client.torrents.post({
        destinationId: destination.id,
        paused: false,
        source: context.magnet,
      })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
    const response = await context.client.destinations({ id: destination.id }).delete({});
    expect(response.status).toBe(200);
    const state = expectSuccess(
      await context.client.state.get({ query: { selected: id } })
    ) as LibraryState;
    expect(state.destinations.some((item) => item.id === destination.id)).toBe(false);
    expect(state.detail).toMatchObject({ destinationId: "default", status: "seeding" });
    expect(expectSuccess(await context.client.torrents({ id }).host.get()).savePath).toBe(path);
    expect(
      new Uint8Array(
        torrentBytes(await context.client.torrents({ id }).files({ index: "0" }).content.get())
      )
    ).toEqual(context.bytes);
    await context.client.torrents({ id }).pause.post({});
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const restartedClient = treaty(
      await createTestApi(() => restarted as TorrentEngine, context.sync.options)
    ).api;
    expect(
      expectSuccess(await restartedClient.state.get({ query: { selected: id } })).destinations.some(
        (item) => item.id === destination.id
      )
    ).toBe(false);
    expect(expectSuccess(await restartedClient.torrents({ id }).get())).toMatchObject({
      destinationId: "default",
      status: "paused",
    });
    expect(expectSuccess(await restartedClient.torrents({ id }).host.get()).savePath).toBe(path);
    expect(new Uint8Array(await Bun.file(join(path, "source.bin")).arrayBuffer())).toEqual(
      context.bytes
    );
  } finally {
    await restarted?.close();
    await context.close();
  }
});
test("deleting tabs keeps one tab and rejects unknown or already deleted tabs", async () => {
  const context = await fixture(4096, []);
  try {
    expect((await context.client.destinations({ id: "default" }).delete({})).status).toBe(409);
    expect((await context.client.destinations({ id: "unknown" }).delete({})).status).toBe(404);
    const destination = expectSuccess(
      await context.client.destinations.post({
        downloadPath: join(context.directory, "empty"),
        name: "Empty",
      })
    ) as { id: string };
    expect((await context.client.destinations({ id: destination.id }).delete({})).status).toBe(200);
    expect((await context.client.destinations({ id: destination.id }).delete({})).status).toBe(404);
    expect(
      expectSuccess(await context.client.state.get()).destinations.map((item) => item.id)
    ).toEqual(["default"]);
  } finally {
    await context.close();
  }
});
test.each(["default", "saved"])(
  "a failed %s tab deletion preserves destinations, settings and real transfers",
  async (tab) => {
    const context = await fixture(8192, []);
    const database = createDatabase(join(context.directory, "state/feeds.sqlite"));
    try {
      const destination = expectSuccess(
        await context.client.destinations.post({
          downloadPath: join(context.directory, "series"),
          name: "Series",
        })
      ) as Destination;
      const { id } = expectSuccess(
        await context.client.torrents.post({
          destinationId: destination.id,
          paused: false,
          source: context.magnet,
        })
      ) as { id: string };
      const read = async () =>
        expectSuccess(await context.client.state.get({ query: { selected: id } })) as LibraryState;
      await waitFor(read, (state) => state.detail?.status === "seeding");
      const before = expectSuccess(await context.client.host.get());
      database.run(sql`CREATE TRIGGER reject_destination_delete BEFORE DELETE ON destinations
        BEGIN SELECT RAISE(ABORT, 'Destination deletion failed'); END`);
      const target = tab === "default" ? "default" : destination.id;
      const response = await context.client.destinations({ id: target }).delete({});
      expect(response.status).toBe(500);
      const after = expectSuccess(await context.client.host.get());
      expect(after.destinations).toEqual(before.destinations);
      expect(after.settings.downloadPath).toBe(before.settings.downloadPath);
      expect((await read()).detail).toMatchObject({
        destinationId: destination.id,
        status: "seeding",
      });
      const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
      expect(new Uint8Array(torrentBytes(content))).toEqual(context.bytes);
      database.run(sql`DROP TRIGGER reject_destination_delete`);
      expect((await context.client.destinations({ id: target }).delete({})).status).toBe(200);
      expect((await read()).detail?.destinationId).toBe("default");
    } finally {
      database.$client.close(true);
      await context.close();
    }
  }
);
test("deleting the default tab hands its role to the next tab without moving real transfers", async () => {
  const context = await fixture(65_536, []);
  let restarted: TorrentEngine | null = null;
  try {
    const downloads = join(context.directory, "downloads");
    const series = join(context.directory, "series");
    const destination = expectSuccess(
      await context.client.destinations.post({
        downloadPath: series,
        icon: "tv",
        name: "Series",
        pinned: true,
      })
    ) as Destination;
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
    const response = await context.client.destinations({ id: "default" }).delete({});
    expect(response.status).toBe(200);
    expect(expectSuccess(response)).toEqual({ ok: true, removed: destination.id });
    const state = expectSuccess(
      await context.client.state.get({ query: { selected: id } })
    ) as LibraryState;
    const host = expectSuccess(await context.client.host.get());
    expect(host.destinations).toEqual([
      {
        autoAddTorrentFilesSince: null,
        deleteTorrentFileAfterAdd: null,
        downloadPath: series,
        icon: "tv",
        id: "default",
        name: "Series",
        pinned: true,
      },
    ]);
    expect(host.settings.downloadPath).toBe(series);
    expect(state.detail).toMatchObject({ destinationId: "default", status: "seeding" });
    expect(expectSuccess(await context.client.torrents({ id }).host.get()).savePath).toBe(
      downloads
    );
    expect(
      new Uint8Array(
        torrentBytes(await context.client.torrents({ id }).files({ index: "0" }).content.get())
      )
    ).toEqual(context.bytes);
    expect((await context.client.destinations({ id: "default" }).delete({})).status).toBe(409);
    await context.client.torrents({ id }).pause.post({});
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: downloads,
      network,
    });
    const restartedClient = treaty(
      await createTestApi(() => restarted as TorrentEngine, context.sync.options)
    ).api;
    expect(expectSuccess(await restartedClient.host.get()).destinations).toEqual(host.destinations);
    expect(expectSuccess(await restartedClient.torrents({ id }).get())).toMatchObject({
      destinationId: "default",
      status: "paused",
    });
    expect(expectSuccess(await restartedClient.torrents({ id }).host.get()).savePath).toBe(
      downloads
    );
    expect(new Uint8Array(await Bun.file(join(downloads, "source.bin")).arrayBuffer())).toEqual(
      context.bytes
    );
  } finally {
    await restarted?.close();
    await context.close();
  }
});
test("moving a destination relocates downloaded bytes and preserves paused torrents after restart", async () => {
  const context = await fixture(65_536, []);
  let restarted: TorrentEngine | null = null;
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    const read = async () =>
      expectSuccess(await context.client.state.get({ query: { selected: id } })) as LibraryState;
    await waitFor(read, (state) => state.detail?.status === "seeding");
    const completed = expectSuccess(await context.client.torrents({ id }).host.get());
    await context.client.torrents({ id }).pause.post({});
    await context.client.torrents({ id }).files({ index: "0" }).put({ priority: "high" });
    const newPath = join(context.directory, "moved");
    const presentation = await context.client
      .destinations({ id: "default" })
      .patch({ icon: "music", pinned: true });
    expect(presentation.status).toBe(200);
    const response = await context.client
      .destinations({ id: "default" })
      .put({ downloadPath: newPath, moveFiles: true, name: "Moved" });
    expect(response.status).toBe(200);
    expect(expectSuccess(response)).toMatchObject({ icon: "music", pinned: true });
    const moved = (await read()).detail;
    expect(expectSuccess(await context.client.torrents({ id }).host.get()).savePath).toBe(newPath);
    expect(moved?.status).toBe("paused");
    expect(moved?.files[0]?.priority).toBe("high");
    expect(await Bun.file(join(completed.savePath, "source.bin")).exists()).toBe(false);
    const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const restartedClient = treaty(
      await createTestApi(() => restarted as TorrentEngine, context.sync.options)
    ).api;
    expect(expectSuccess(await restartedClient.torrents({ id }).host.get()).savePath).toBe(newPath);
    expect(expectSuccess(await restartedClient.torrents({ id }).get()).status).toBe("paused");
    expect(expectSuccess(await restartedClient.state.get()).destinations[0]).toMatchObject({
      icon: "music",
      pinned: true,
    });
    expectSuccess(await restartedClient.torrents({ id }).resume.post({}));
    await waitFor(
      async () => expectSuccess(await restartedClient.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
  } finally {
    await restarted?.close();
    await context.close();
  }
});
test("a missing downloaded file refuses relocation and keeps the original destination", async () => {
  const context = await fixture(65_536, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
    const completed = expectSuccess(await context.client.torrents({ id }).host.get());
    await context.client.torrents({ id }).pause.post({});
    await rm(join(completed.savePath, "source.bin"));
    const response = await context.client
      .destinations({ id: "default" })
      .put({ downloadPath: join(context.directory, "missing"), moveFiles: true, name: "Moved" });
    expect(response.status).toBe(404);
    expect(response.error?.value).toMatchObject({
      detail: expect.stringContaining("is no longer present"),
    });
    const state = expectSuccess(await context.client.state.get({ query: { selected: id } }));
    expect(expectSuccess(await context.client.torrents({ id }).host.get()).savePath).toBe(
      completed.savePath
    );
    expect(expectSuccess(await context.client.host.get()).destinations[0]?.downloadPath).toBe(
      completed.savePath
    );
    expect(state.detail?.status).toBe("paused");
  } finally {
    await context.close();
  }
});
test("a destination collision preserves existing files and running downloads", async () => {
  const context = await fixture(65_536, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
    const originalPath = expectSuccess(await context.client.torrents({ id }).host.get()).savePath;
    const newPath = join(context.directory, "occupied");
    await Bun.write(join(newPath, "source.bin"), "Do not overwrite");
    const response = await context.client
      .destinations({ id: "default" })
      .put({ downloadPath: newPath, moveFiles: true, name: "Moved" });
    expect(response.status).toBe(409);
    expect(response.error?.value).toMatchObject({
      detail: expect.stringContaining("already exists"),
    });
    expect(expectSuccess(await context.client.torrents({ id }).host.get()).savePath).toBe(
      originalPath
    );
    expect(await Bun.file(join(newPath, "source.bin")).text()).toBe("Do not overwrite");
    expect(
      Bun.SHA256.hash(await Bun.file(join(originalPath, "source.bin")).arrayBuffer(), "hex")
    ).toBe(Bun.SHA256.hash(context.bytes, "hex"));
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (detail) => detail.status === "seeding"
    );
  } finally {
    await context.close();
  }
});
test("moving the default folder from preferences resumes a partial transfer in its new location", async () => {
  const context = await fixture(1024 * 1024, []);
  try {
    const { settings } = expectSuccess(await context.client.host.get());
    await context.client.settings.put({ ...settings, downloadLimit: 32_768 });
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    const read = async () =>
      expectSuccess(await context.client.state.get({ query: { selected: id } })) as LibraryState;
    await waitFor(read, (state) => (state.detail?.downloaded ?? 0) > 0);
    const before = await read();
    expect(before.detail?.progress).toBeLessThan(1);
    const { savePath: previousPath } = expectSuccess(
      await context.client.torrents({ id }).host.get()
    );
    const newPath = join(context.directory, "partial");
    const response = await context.client.settings.put({
      ...settings,
      downloadLimit: -1,
      downloadPath: newPath,
      moveFiles: true,
    });
    expect(response.status).toBe(200);
    await waitFor(read, (state) => state.detail?.status === "seeding");
    expect(expectSuccess(await context.client.torrents({ id }).host.get()).savePath).toBe(newPath);
    const host = expectSuccess(await context.client.host.get());
    expect(host.settings.downloadPath).toBe(newPath);
    expect(host.settings).not.toHaveProperty("moveFiles");
    const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    expect(await Bun.file(join(previousPath, "source.bin")).exists()).toBe(false);
  } finally {
    await context.close();
  }
});
test("distinct destination tabs may share a folder and an add uses its chosen tab", async () => {
  const context = await fixture(65_536, []);
  try {
    const path = join(context.directory, "shared-output");
    const first = await context.client.destinations.post({ downloadPath: path, name: "Series" });
    expect(first.status).toBe(200);
    const a = expectSuccess(first) as { id: string };
    const second = await context.client.destinations.post({
      downloadPath: path,
      name: "Following",
    });
    expect(second.status).toBe(200);
    const b = expectSuccess(second) as { id: string };
    expect(a.id).not.toBe(b.id);
    const response = await context.client.torrents.post({
      destinationId: b.id,
      paused: false,
      source: context.magnet,
    });
    expect(response.status).toBe(200);
    const { id } = expectSuccess(response) as { id: string };
    const state = await waitFor(
      async () =>
        expectSuccess(await context.client.state.get({ query: { selected: id } })) as LibraryState,
      (value) => value.detail?.status === "seeding"
    );
    expect(expectSuccess(await context.client.torrents({ id }).host.get()).savePath).toBe(path);
    expect(Bun.SHA256.hash(await Bun.file(join(path, "source.bin")).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    expect((state.detail as typeof state.detail & { destinationId: string })?.destinationId).toBe(
      b.id
    );
    const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
});
test("bulk pause targets the visible torrent IDs rather than every destination", async () => {
  const first = await fixture(65_536, []);
  const second = await fixture(65_536, []);
  try {
    const a = expectSuccess(
      await first.client.torrents.post({ paused: false, source: first.magnet })
    ) as { id: string };
    const b = expectSuccess(
      await first.client.torrents.post({ paused: false, source: second.magnet })
    ) as { id: string };
    const response = await first.client.bulk.post({ action: "pause", ids: [a.id] });
    expect(response.status).toBe(200);
    const state = expectSuccess(await first.client.state.get({ query: { selected: b.id } }));
    expect(state.torrents.find((t) => t.id === a.id)?.status).toBe("paused");
    expect(state.torrents.find((t) => t.id === b.id)?.status).not.toBe("paused");
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});
test("editing a destination persists its identity and changes future adds without moving files", async () => {
  const context = await fixture(65_536, []);
  const other = await fixture(65_536, []);
  let restarted: import("../src/api/modules/torrents/service").TorrentEngine | null = null;
  try {
    const path = join(context.directory, "original");
    const destination = expectSuccess(
      await context.client.destinations.post({ downloadPath: path, name: "Series" })
    ) as import("../src/types").Destination;
    const { id } = expectSuccess(
      await context.client.torrents.post({
        destinationId: destination.id,
        paused: false,
        source: context.magnet,
      })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.state.get({ query: { selected: id } })),
      (value) => value.detail?.status === "seeding"
    );
    const newPath = join(context.directory, "changed");
    const response = await context.client
      .destinations({ id: destination.id })
      .put({ downloadPath: newPath, name: "Anime" });
    expect(response.status).toBe(200);
    expect(expectSuccess(await context.client.torrents({ id }).host.get()).savePath).toBe(path);
    const { id: newId } = expectSuccess(
      await context.client.torrents.post({
        destinationId: destination.id,
        paused: false,
        source: other.magnet,
      })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.state.get({ query: { selected: newId } })),
      (value) => value.detail?.status === "seeding"
    );
    expect(expectSuccess(await context.client.torrents({ id: newId }).host.get()).savePath).toBe(
      newPath
    );
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const restartedClient = treaty(
      await createTestApi(() => restarted as TorrentEngine, context.sync.options)
    ).api;
    const state = expectSuccess(await restartedClient.state.get({ query: { selected: id } }));
    const host = expectSuccess(await restartedClient.host.get());
    expect(host.destinations.find((item) => item.id === destination.id)).toEqual({
      autoAddTorrentFilesSince: null,
      deleteTorrentFileAfterAdd: null,
      downloadPath: newPath,
      icon: "folder",
      id: destination.id,
      name: "Anime",
      pinned: false,
    });
    expect(state.detail?.destinationId).toBe(destination.id);
    expect(expectSuccess(await restartedClient.torrents({ id }).host.get()).savePath).toBe(path);
    expect(Bun.SHA256.hash(await Bun.file(join(path, "source.bin")).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await restarted?.close();
    await Promise.all([context.close(), other.close()]);
  }
});
test("torrents with overlapping files do not overwrite an existing download", async () => {
  const context = await fixture(65_536, []);
  const other = await fixture(65_536, []);
  let reopened: TorrentEngine | null = null;
  let { client } = context;
  try {
    const first = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    const read = async (id: string) =>
      expectSuccess(await client.state.get({ query: { selected: id } })) as LibraryState;
    await waitFor(
      () => read(first.id),
      (state) => state.detail?.status === "seeding"
    );
    const second = expectSuccess(
      await context.client.torrents.post({ paused: false, source: other.magnet })
    ) as { id: string };
    const collision = await waitFor(
      () => read(second.id),
      (state) => state.detail?.status === "error" || state.detail?.status === "seeding"
    );
    expect(collision.detail?.status).toBe("error");
    expect(collision.detail?.error).toContain("source.bin");
    expect(
      Bun.SHA256.hash(
        await Bun.file(join(context.directory, "downloads/source.bin")).arrayBuffer(),
        "hex"
      )
    ).toBe(Bun.SHA256.hash(context.bytes, "hex"));
    await context.engine.close();
    reopened = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const engine = reopened;
    const app = await createTestApi(() => engine, context.sync.options);
    client = treaty(app).api;
    const restored = await waitFor(
      () => read(first.id),
      (state) => state.detail?.status === "error" || state.detail?.status === "seeding"
    );
    expect(restored.detail?.status).toBe("seeding");
    await waitFor(
      () => read(second.id),
      (state) => state.detail?.status === "error"
    );
    const content = await client.torrents({ id: first.id }).files({ index: "0" }).content.get();
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    const removed = await client.torrents({ id: second.id }).delete({ deleteFiles: true });
    expect(removed.status).toBe(200);
    expect(await Bun.file(join(context.directory, "downloads/source.bin")).exists()).toBe(true);
  } finally {
    await reopened?.close();
    await Promise.all([context.close(), other.close()]);
  }
});
