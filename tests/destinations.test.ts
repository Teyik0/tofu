import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createApi } from "../src/server/api";
import { TorrentEngine } from "../src/server/engine";
import type { DashboardState } from "../src/types";
import { fixture, json, network, waitFor } from "./helpers";

test("moving a destination relocates downloaded bytes and preserves paused torrents after restart", async () => {
  const context = await fixture(65_536, []);
  let restarted: TorrentEngine | null = null;
  try {
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    const read = async () =>
      (await context.request(`/state?selected=${id}`, undefined)).json() as Promise<DashboardState>;
    const completed = await waitFor(read, (state) => state.detail?.progress === 1);
    await context.request(`/torrents/${id}/pause`, json({}));
    await context.request(`/torrents/${id}/files/0`, {
      ...json({ priority: "high" }),
      method: "PUT",
    });
    const newPath = join(context.directory, "moved");
    const response = await context.request("/destinations/default", {
      ...json({ downloadPath: newPath, moveFiles: true, name: "Déplacés" }),
      method: "PUT",
    });
    expect(response.status).toBe(200);
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
      (detail) => detail.progress === 1
    );
    await context.request(`/torrents/${id}/pause`, json({}));
    await rm(join(completed.savePath, "source.bin"));
    const response = await context.request("/destinations/default", {
      ...json({
        downloadPath: join(context.directory, "missing"),
        moveFiles: true,
        name: "Déplacés",
      }),
      method: "PUT",
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error).toContain("n’est plus présent");
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
      (detail) => detail.progress === 1
    );
    const originalPath = completed.savePath;
    const newPath = join(context.directory, "occupied");
    await Bun.write(join(newPath, "source.bin"), "Do not overwrite");
    const response = await context.request("/destinations/default", {
      ...json({ downloadPath: newPath, moveFiles: true, name: "Déplacés" }),
      method: "PUT",
    });
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("existe déjà");
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
      json({ downloadPath: path, name: "Séries" })
    );
    expect(first.status).toBe(200);
    const a = (await first.json()) as { id: string };
    const second = await context.request(
      "/destinations",
      json({ downloadPath: path, name: "À suivre" })
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
      (value) => value.detail?.progress === 1
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
  let restarted: import("../src/server/engine").TorrentEngine | null = null;
  try {
    const path = join(context.directory, "original");
    const destination = (await (
      await context.request("/destinations", json({ downloadPath: path, name: "Séries" }))
    ).json()) as import("../src/types").Destination;
    const { id } = (await (
      await context.request(
        "/torrents",
        json({ destinationId: destination.id, paused: false, source: context.magnet })
      )
    ).json()) as { id: string };
    await waitFor(
      async () => context.engine.snapshot(id),
      (value) => value.detail?.progress === 1
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
      (value) => value.detail?.progress === 1
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
      id: destination.id,
      name: "Anime",
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
      (state) => state.detail?.progress === 1
    );
    const second = (await (
      await context.request("/torrents", json({ paused: false, source: other.magnet }))
    ).json()) as { id: string };
    const collision = await waitFor(
      () => read(second.id),
      (state) => state.detail?.status === "error" || state.detail?.progress === 1
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
