import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createApi } from "../src/api";
import { TorrentEngine } from "../src/api/engine";
import type { DashboardState, Destination } from "../src/types";
import { fixture, json, network, waitFor } from "./helpers";

test("pinned threads retain their selected icon after restart without changing downloaded data", async () => {
  const context = await fixture(8192, []);
  let restarted: TorrentEngine | null = null;
  try {
    const response = await context.request(
      "/destinations",
      json({
        downloadPath: join(context.directory, "series"),
        icon: "film",
        name: "Series",
        pinned: true,
      })
    );
    expect(response.status).toBe(200);
    const destination = (await response.json()) as Destination;
    expect(destination).toMatchObject({ icon: "film", name: "Series", pinned: true });
    const { id } = (await (
      await context.request(
        "/torrents",
        json({ destinationId: destination.id, paused: false, source: context.magnet })
      )
    ).json()) as { id: string };
    await waitFor(
      async () =>
        (
          await context.request(`/state?selected=${id}`, undefined)
        ).json() as Promise<DashboardState>,
      (snapshot) => snapshot.detail?.status === "seeding"
    );
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const restored = restarted;
    const api = createApi(() => restored, context.sync.options);
    const state = await waitFor(
      async () =>
        (await (
          await api.handle(new Request(`http://localhost/api/state?selected=${id}`))
        ).json()) as DashboardState,
      (snapshot) => snapshot.detail?.status === "seeding"
    );
    expect(state.destinations.find((item) => item.id === destination.id)).toEqual(destination);
    const content = await api.handle(
      new Request(`http://localhost/api/torrents/${id}/files/0/content`)
    );
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
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
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    const read = async () =>
      (await context.request(`/state?selected=${id}`, undefined)).json() as Promise<DashboardState>;
    await waitFor(read, (state) => state.detail?.status === "seeding");
    const updated = await context.request("/destinations/default", {
      ...json({ icon: "tv", pinned: true }),
      method: "PATCH",
    });
    expect(updated.status).toBe(200);
    const destination = (await updated.json()) as Destination;
    expect(destination).toMatchObject({ icon: "tv", pinned: true });
    const older = await context.request("/destinations/default", {
      ...json({ downloadPath: destination.downloadPath, name: "Saved thread" }),
      method: "PUT",
    });
    expect(await older.json()).toMatchObject({ icon: "tv", name: "Saved thread", pinned: true });
    const invalid = await context.request("/destinations/default", {
      ...json({ icon: "unsupported", pinned: false }),
      method: "PATCH",
    });
    expect(invalid.status).toBe(422);
    expect((await read()).destinations[0]).toMatchObject({ icon: "tv", pinned: true });
    expect((await read()).detail?.status).toBe("seeding");
    const unpinned = await context.request("/destinations/default", {
      ...json({ pinned: false }),
      method: "PATCH",
    });
    expect(await unpinned.json()).toMatchObject({ icon: "tv", pinned: false });
    const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
});

test("legacy thread databases gain unpinned folder icons without rewriting names, folders or transfers", async () => {
  const context = await fixture(8192, []);
  let restarted: TorrentEngine | null = null;
  try {
    const destination = (await (
      await context.request(
        "/destinations",
        json({ downloadPath: join(context.directory, "saved"), name: "My saved thread" })
      )
    ).json()) as Destination;
    const { id } = (await (
      await context.request(
        "/torrents",
        json({ destinationId: destination.id, paused: false, source: context.magnet })
      )
    ).json()) as { id: string };
    await waitFor(
      async () =>
        (
          await context.request(`/state?selected=${id}`, undefined)
        ).json() as Promise<DashboardState>,
      (state) => state.detail?.status === "seeding"
    );
    await context.engine.close();
    const database = new Database(join(context.directory, "state/tofu.sqlite"));
    try {
      database.exec(
        "ALTER TABLE destinations DROP COLUMN pinned; ALTER TABLE destinations DROP COLUMN icon"
      );
    } finally {
      database.close();
    }
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const restored = restarted;
    const api = createApi(() => restored, context.sync.options);
    const read = async () =>
      (await (
        await api.handle(new Request(`http://localhost/api/state?selected=${id}`))
      ).json()) as DashboardState;
    const snapshot = await waitFor(read, (state) => state.detail?.status === "seeding");
    expect(snapshot.destinations.find((item) => item.id === destination.id)).toEqual(destination);
    const response = await api.handle(
      new Request(`http://localhost/api/torrents/${id}/files/0/content`)
    );
    expect(response.status).toBe(200);
    expect(Bun.SHA256.hash(await response.arrayBuffer(), "hex")).toBe(
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
    const destination = (await (
      await context.request("/destinations", json({ downloadPath: path, name: "Series" }))
    ).json()) as { id: string };
    const { id } = (await (
      await context.request(
        "/torrents",
        json({ destinationId: destination.id, paused: false, source: context.magnet })
      )
    ).json()) as { id: string };
    await waitFor(
      async () => context.engine.detail(id),
      (detail) => detail.status === "seeding"
    );
    const response = await context.request(`/destinations/${destination.id}`, { method: "DELETE" });
    expect(response.status).toBe(200);
    const state = (await (
      await context.request(`/state?selected=${id}`, undefined)
    ).json()) as DashboardState;
    expect(state.destinations.some((item) => item.id === destination.id)).toBe(false);
    expect(state.detail).toMatchObject({
      destinationId: "default",
      savePath: path,
      status: "seeding",
    });
    expect(
      new Uint8Array(
        await (await context.request(`/torrents/${id}/files/0/content`, undefined)).arrayBuffer()
      )
    ).toEqual(context.bytes);
    await context.request(`/torrents/${id}/pause`, json({}));
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    expect(restarted.snapshot(id).destinations.some((item) => item.id === destination.id)).toBe(
      false
    );
    expect(restarted.detail(id)).toMatchObject({
      destinationId: "default",
      savePath: path,
      status: "paused",
    });
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
    expect((await context.request("/destinations/default", { method: "DELETE" })).status).toBe(409);
    expect((await context.request("/destinations/unknown", { method: "DELETE" })).status).toBe(404);
    const destination = (await (
      await context.request(
        "/destinations",
        json({ downloadPath: join(context.directory, "empty"), name: "Empty" })
      )
    ).json()) as { id: string };
    expect(
      (await context.request(`/destinations/${destination.id}`, { method: "DELETE" })).status
    ).toBe(200);
    expect(
      (await context.request(`/destinations/${destination.id}`, { method: "DELETE" })).status
    ).toBe(404);
    expect(context.engine.snapshot(null).destinations.map((item) => item.id)).toEqual(["default"]);
  } finally {
    await context.close();
  }
});

test.each(["default", "saved"])(
  "a failed %s tab deletion preserves destinations, settings and real transfers",
  async (tab) => {
    const context = await fixture(8192, []);
    const database = new Database(join(context.directory, "state/tofu.sqlite"));
    try {
      const destination = (await (
        await context.request(
          "/destinations",
          json({ downloadPath: join(context.directory, "series"), name: "Series" })
        )
      ).json()) as Destination;
      const { id } = (await (
        await context.request(
          "/torrents",
          json({ destinationId: destination.id, paused: false, source: context.magnet })
        )
      ).json()) as { id: string };
      const read = async () =>
        (
          await context.request(`/state?selected=${id}`, undefined)
        ).json() as Promise<DashboardState>;
      const before = await waitFor(read, (state) => state.detail?.status === "seeding");
      database.exec(
        "CREATE TRIGGER reject_destination_delete BEFORE DELETE ON destinations BEGIN SELECT RAISE(ABORT, 'Destination deletion failed'); END"
      );
      const target = tab === "default" ? "default" : destination.id;
      const response = await context.request(`/destinations/${target}`, { method: "DELETE" });
      expect(response.status).toBe(500);
      const after = await read();
      expect(after.destinations).toEqual(before.destinations);
      expect(after.settings.downloadPath).toBe(before.settings.downloadPath);
      expect(after.detail).toMatchObject({ destinationId: destination.id, status: "seeding" });
      const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
      expect(new Uint8Array(await content.arrayBuffer())).toEqual(context.bytes);
      database.exec("DROP TRIGGER reject_destination_delete");
      expect((await context.request(`/destinations/${target}`, { method: "DELETE" })).status).toBe(
        200
      );
      expect((await read()).detail?.destinationId).toBe("default");
    } finally {
      database.close();
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
    const destination = (await (
      await context.request(
        "/destinations",
        json({ downloadPath: series, icon: "tv", name: "Series", pinned: true })
      )
    ).json()) as Destination;
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    await waitFor(
      async () => context.engine.detail(id),
      (detail) => detail.status === "seeding"
    );
    const response = await context.request("/destinations/default", { method: "DELETE" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, removed: destination.id });
    const state = (await (
      await context.request(`/state?selected=${id}`, undefined)
    ).json()) as DashboardState;
    expect(state.destinations).toEqual([
      { downloadPath: series, icon: "tv", id: "default", name: "Series", pinned: true },
    ]);
    expect(state.settings.downloadPath).toBe(series);
    expect(state.detail).toMatchObject({
      destinationId: "default",
      savePath: downloads,
      status: "seeding",
    });
    expect(
      new Uint8Array(
        await (await context.request(`/torrents/${id}/files/0/content`, undefined)).arrayBuffer()
      )
    ).toEqual(context.bytes);
    expect((await context.request("/destinations/default", { method: "DELETE" })).status).toBe(409);
    await context.request(`/torrents/${id}/pause`, json({}));
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: downloads,
      network,
    });
    expect(restarted.snapshot(id).destinations).toEqual(state.destinations);
    expect(restarted.detail(id)).toMatchObject({
      destinationId: "default",
      savePath: downloads,
      status: "paused",
    });
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
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    const read = async () =>
      (await context.request(`/state?selected=${id}`, undefined)).json() as Promise<DashboardState>;
    const completed = await waitFor(read, (state) => state.detail?.status === "seeding");
    await context.request(`/torrents/${id}/pause`, json({}));
    await context.request(`/torrents/${id}/files/0`, {
      ...json({ priority: "high" }),
      method: "PUT",
    });
    const newPath = join(context.directory, "moved");
    const presentation = await context.request("/destinations/default", {
      ...json({ icon: "music", pinned: true }),
      method: "PATCH",
    });
    expect(presentation.status).toBe(200);
    const response = await context.request("/destinations/default", {
      ...json({ downloadPath: newPath, moveFiles: true, name: "Moved" }),
      method: "PUT",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ icon: "music", pinned: true });
    const moved = (await read()).detail;
    expect(moved?.savePath).toBe(newPath);
    expect(moved?.status).toBe("paused");
    expect(moved?.files[0]?.priority).toBe("high");
    expect(await Bun.file(join(completed.detail?.savePath ?? "", "source.bin")).exists()).toBe(
      false
    );
    const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    expect(restarted.detail(id).savePath).toBe(newPath);
    expect(restarted.detail(id).status).toBe("paused");
    expect(restarted.snapshot(null).destinations[0]).toMatchObject({ icon: "music", pinned: true });
    await restarted.resume(id);
    const restoredEngine = restarted;
    await waitFor(
      async () => restoredEngine.detail(id),
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
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    const completed = await waitFor(
      async () => context.engine.detail(id),
      (detail) => detail.status === "seeding"
    );
    await context.request(`/torrents/${id}/pause`, json({}));
    await rm(join(completed.savePath, "source.bin"));
    const response = await context.request("/destinations/default", {
      ...json({
        downloadPath: join(context.directory, "missing"),
        moveFiles: true,
        name: "Moved",
      }),
      method: "PUT",
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain("is no longer present");
    const state = context.engine.snapshot(id);
    expect(state.detail?.savePath).toBe(completed.savePath);
    expect(state.destinations[0]?.downloadPath).toBe(completed.savePath);
    expect(state.detail?.status).toBe("paused");
  } finally {
    await context.close();
  }
});

test("a destination collision preserves existing files and running downloads", async () => {
  const context = await fixture(65_536, []);
  try {
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    const completed = await waitFor(
      async () => context.engine.detail(id),
      (detail) => detail.status === "seeding"
    );
    const originalPath = completed.savePath;
    const newPath = join(context.directory, "occupied");
    await Bun.write(join(newPath, "source.bin"), "Do not overwrite");
    const response = await context.request("/destinations/default", {
      ...json({ downloadPath: newPath, moveFiles: true, name: "Moved" }),
      method: "PUT",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("already exists");
    expect(context.engine.detail(id).savePath).toBe(originalPath);
    expect(await Bun.file(join(newPath, "source.bin")).text()).toBe("Do not overwrite");
    expect(
      Bun.SHA256.hash(await Bun.file(join(originalPath, "source.bin")).arrayBuffer(), "hex")
    ).toBe(Bun.SHA256.hash(context.bytes, "hex"));
    await waitFor(
      async () => context.engine.detail(id),
      (detail) => detail.status === "seeding"
    );
  } finally {
    await context.close();
  }
});

test("moving the default folder from preferences resumes a partial transfer in its new location", async () => {
  const context = await fixture(1024 * 1024, []);
  try {
    const { settings } = context.engine.snapshot(null);
    await context.request("/settings", {
      ...json({ ...settings, downloadLimit: 32_768 }),
      method: "PUT",
    });
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    const read = async () =>
      (await context.request(`/state?selected=${id}`, undefined)).json() as Promise<DashboardState>;
    await waitFor(read, (state) => (state.detail?.downloaded ?? 0) > 0);
    const before = await read();
    expect(before.detail?.progress).toBeLessThan(1);
    const newPath = join(context.directory, "partial");
    const response = await context.request("/settings", {
      ...json({ ...settings, downloadLimit: -1, downloadPath: newPath, moveFiles: true }),
      method: "PUT",
    });
    expect(response.status).toBe(200);
    const completed = await waitFor(read, (state) => state.detail?.status === "seeding");
    expect(completed.detail?.savePath).toBe(newPath);
    expect(completed.settings.downloadPath).toBe(newPath);
    expect(completed.settings).not.toHaveProperty("moveFiles");
    const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    expect(await Bun.file(join(before.detail?.savePath ?? "", "source.bin")).exists()).toBe(false);
  } finally {
    await context.close();
  }
});

test("distinct destination tabs may share a folder and an add uses its chosen tab", async () => {
  const context = await fixture(65_536, []);
  try {
    const path = join(context.directory, "shared-output");
    const first = await context.request(
      "/destinations",
      json({ downloadPath: path, name: "Series" })
    );
    expect(first.status).toBe(200);
    const a = (await first.json()) as { id: string };
    const second = await context.request(
      "/destinations",
      json({ downloadPath: path, name: "Following" })
    );
    expect(second.status).toBe(200);
    const b = (await second.json()) as { id: string };
    expect(a.id).not.toBe(b.id);
    const response = await context.request(
      "/torrents",
      json({ destinationId: b.id, paused: false, source: context.magnet })
    );
    expect(response.status).toBe(200);
    const { id } = (await response.json()) as { id: string };
    const state = await waitFor(
      async () =>
        (
          await context.request(`/state?selected=${id}`, undefined)
        ).json() as Promise<DashboardState>,
      (value) => value.detail?.status === "seeding"
    );
    expect(state.detail?.savePath).toBe(path);
    expect(Bun.SHA256.hash(await Bun.file(join(path, "source.bin")).arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    expect((state.detail as typeof state.detail & { destinationId: string })?.destinationId).toBe(
      b.id
    );
    const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
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
    const a = (await (
      await first.request("/torrents", json({ paused: false, source: first.magnet }))
    ).json()) as { id: string };
    const b = (await (
      await first.request("/torrents", json({ paused: false, source: second.magnet }))
    ).json()) as { id: string };
    const response = await first.request("/bulk", json({ action: "pause", ids: [a.id] }));
    expect(response.status).toBe(200);
    const state = first.engine.snapshot(b.id);
    expect(state.torrents.find((t) => t.id === a.id)?.status).toBe("paused");
    expect(state.torrents.find((t) => t.id === b.id)?.status).not.toBe("paused");
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
});

test("editing a destination persists its identity and changes future adds without moving files", async () => {
  const context = await fixture(65_536, []);
  const other = await fixture(65_536, []);
  let restarted: import("../src/api/engine").TorrentEngine | null = null;
  try {
    const path = join(context.directory, "original");
    const destination = (await (
      await context.request("/destinations", json({ downloadPath: path, name: "Series" }))
    ).json()) as import("../src/types").Destination;
    const { id } = (await (
      await context.request(
        "/torrents",
        json({ destinationId: destination.id, paused: false, source: context.magnet })
      )
    ).json()) as { id: string };
    await waitFor(
      async () => context.engine.snapshot(id),
      (value) => value.detail?.status === "seeding"
    );
    const newPath = join(context.directory, "changed");
    const response = await context.request(`/destinations/${destination.id}`, {
      ...json({ downloadPath: newPath, name: "Anime" }),
      method: "PUT",
    });
    expect(response.status).toBe(200);
    expect(context.engine.detail(id).savePath).toBe(path);
    const { id: newId } = (await (
      await context.request(
        "/torrents",
        json({ destinationId: destination.id, paused: false, source: other.magnet })
      )
    ).json()) as { id: string };
    await waitFor(
      async () => context.engine.snapshot(newId),
      (value) => value.detail?.status === "seeding"
    );
    expect(context.engine.detail(newId).savePath).toBe(newPath);
    await context.engine.close();
    restarted = await TorrentEngine.open({
      dataDir: join(context.directory, "state"),
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    const state = restarted.snapshot(id);
    expect(state.destinations.find((item) => item.id === destination.id)).toEqual({
      downloadPath: newPath,
      icon: "folder",
      id: destination.id,
      name: "Anime",
      pinned: false,
    });
    expect(state.detail?.destinationId).toBe(destination.id);
    expect(state.detail?.savePath).toBe(path);
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
  let { request } = context;
  try {
    const first = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    const read = async (id: string) =>
      (await request(`/state?selected=${id}`, undefined)).json() as Promise<DashboardState>;
    await waitFor(
      () => read(first.id),
      (state) => state.detail?.status === "seeding"
    );
    const second = (await (
      await context.request("/torrents", json({ paused: false, source: other.magnet }))
    ).json()) as { id: string };
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
    const app = createApi(() => engine, context.sync.options);
    request = (path, init) => app.handle(new Request(`http://localhost/api${path}`, init));
    const restored = await waitFor(
      () => read(first.id),
      (state) => state.detail?.status === "error" || state.detail?.status === "seeding"
    );
    expect(restored.detail?.status).toBe("seeding");
    await waitFor(
      () => read(second.id),
      (state) => state.detail?.status === "error"
    );
    const content = await request(`/torrents/${first.id}/files/0/content`, undefined);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    const removed = await request(`/torrents/${second.id}`, {
      ...json({ deleteFiles: true }),
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    expect(await Bun.file(join(context.directory, "downloads/source.bin")).exists()).toBe(true);
  } finally {
    await reopened?.close();
    await Promise.all([context.close(), other.close()]);
  }
});
