import { expect, test } from "bun:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Server as Tracker } from "bittorrent-tracker";
import { DesktopTorrentOpener } from "../src/server/desktop-opening";
import type { DashboardState } from "../src/types";
import { fixture, waitFor } from "./helpers";

test("opening a torrent file from the desktop downloads real bytes to the saved destination", async () => {
  const tracker = new Tracker({ http: true, stats: false, udp: false, ws: false });
  await new Promise<void>((resolve) => tracker.listen(0, "127.0.0.1", resolve));
  const address = tracker.http.address();
  if (!address || typeof address === "string") {
    throw new Error("Tracker not started");
  }
  const context = await fixture(
    65_536,
    [`http://127.0.0.1:${address.port}/announce`],
    "Desktop source.bin"
  );
  try {
    const path = join(context.directory, "A torrent #1.torrent");
    await Bun.write(path, context.seed.torrentFile);
    let opened = 0;
    const opener = new DesktopTorrentOpener({
      engine: () => context.engine,
      show: () => {
        opened += 1;
      },
    });
    opener.ready();
    const result = await opener.open(pathToFileURL(path).href);
    const state = await waitFor(
      async () =>
        (
          await context.request(`/state?selected=${result.id}`, undefined)
        ).json() as Promise<DashboardState>,
      (value) => value.detail?.status === "seeding"
    );
    expect(opened).toBe(1);
    expect(state.detail?.savePath).toBe(context.engine.settings.downloadPath);
    const content = await context.request(`/torrents/${result.id}/files/0/content`, undefined);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    expect(await Bun.file(path).exists()).toBe(true);
  } finally {
    await context.close();
    await new Promise<void>((resolve) => tracker.close(resolve));
  }
});

test("desktop magnet events wait for startup and repeated opens preserve a paused torrent", async () => {
  const context = await fixture(65_536, []);
  try {
    let engineReads = 0;
    let opened = 0;
    const opener = new DesktopTorrentOpener({
      engine: () => {
        engineReads += 1;
        return context.engine;
      },
      show: () => {
        opened += 1;
      },
    });
    const pending = opener.open(context.magnet);
    await Bun.sleep(20);
    expect(opened).toBe(0);
    expect(engineReads).toBe(0);
    opener.ready();
    const result = await pending;
    await waitFor(
      async () =>
        (
          await context.request(`/state?selected=${result.id}`, undefined)
        ).json() as Promise<DashboardState>,
      (value) => value.detail?.status === "seeding"
    );
    await context.request(`/torrents/${result.id}/pause`, { method: "POST" });
    await Promise.all([opener.open(context.magnet), opener.open(context.magnet)]);
    const state: DashboardState = await (
      await context.request(`/state?selected=${result.id}`, undefined)
    ).json();
    expect(state.torrents).toHaveLength(1);
    expect(state.detail?.status).toBe("paused");
    expect(opened).toBe(3);
    expect(
      await Bun.file(join(context.engine.settings.downloadPath, "source.bin")).bytes()
    ).toEqual(new Uint8Array(context.bytes));
  } finally {
    await context.close();
  }
});

test("a rejected desktop URL does not block the next torrent event", async () => {
  const context = await fixture(1024, []);
  try {
    const opener = new DesktopTorrentOpener({
      engine: () => context.engine,
      show: () => undefined,
    });
    opener.ready();
    await expect(opener.open("https://example.com/file.torrent")).rejects.toThrow(
      "Only magnet links and .torrent files can be opened"
    );
    const textPath = join(context.directory, "notes.txt");
    await Bun.write(textPath, context.seed.torrentFile);
    await expect(opener.open(pathToFileURL(textPath).href)).rejects.toThrow(
      "Only .torrent files can be opened"
    );
    const result = await opener.open(context.magnet);
    expect(result.id).toBe(context.seed.infoHash);
  } finally {
    await context.close();
  }
});
