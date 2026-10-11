import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebTorrent, { type Torrent } from "webtorrent";
import type { DashboardState, Settings } from "../src/types";
import { expectSuccess } from "./helpers/problem";
import { settingsFixture } from "./helpers/settings";
import { fixture, network, torrentBytes, waitFor } from "./helpers/torrent";

test("seeding connection settings survive legacy PUT requests and an application restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-seeding-settings-"));
  let context = await settingsFixture(directory);
  try {
    const initial = expectSuccess(await context.client.settings.get());
    expect(initial).toMatchObject({ seedingConnectionMode: "balanced" });
    const patch = await context.client.settings.patch({ seedingConnectionMode: "incoming-only" });
    expect(patch.status).toBe(200);
    expect(expectSuccess(patch)).toMatchObject({ seedingConnectionMode: "incoming-only" });
    const legacy = await context.client.settings.put({
      downloadLimit: initial.downloadLimit,
      downloadPath: initial.downloadPath,
      uploadLimit: initial.uploadLimit,
    });
    expect(legacy.status).toBe(200);
    expect(expectSuccess(legacy)).toMatchObject({ seedingConnectionMode: "incoming-only" });
    await context.close();
    context = await settingsFixture(directory);
    const restored: Settings = expectSuccess(await context.client.settings.get());
    expect(restored).toMatchObject({ seedingConnectionMode: "incoming-only" });
    const balanced = await context.client.settings.patch({ seedingConnectionMode: "balanced" });
    expect(balanced.status).toBe(200);
    expect(expectSuccess(balanced)).toMatchObject({ seedingConnectionMode: "balanced" });
  } finally {
    await context.close();
    await rm(directory, { force: true, recursive: true });
  }
});
test("incoming-only seeding still downloads outgoing and uploads verified bytes to an incoming peer", async () => {
  const context = await fixture(65_536, []);
  const leecher = new WebTorrent(network);
  try {
    const settings = await context.client.settings.patch({
      seedingConnectionMode: "incoming-only",
    });
    expect(settings.status).toBe(200);
    const added = await context.client.torrents.post({ paused: false, source: context.magnet });
    expect(added.status).toBe(200);
    const { id }: { id: string } = expectSuccess(added);
    const read = () =>
      context.client.state
        .get({ query: { selected: id } })
        .then((response) => expectSuccess(response) as DashboardState);
    const completed = await waitFor(read, (state) => state.detail?.status === "seeding");
    const received = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(Bun.SHA256.hash(torrentBytes(received), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
    const download = await new Promise<Torrent>((resolve, reject) => {
      leecher.once("error", reject);
      leecher.add(
        context.seed.torrentFile,
        { announce: [], path: join(context.directory, "incoming-download") },
        resolve
      );
    });
    expect(download.addPeer(`127.0.0.1:${completed.session.port}`)).toBe(true);
    await waitFor(
      async () => download.done,
      (done) => done
    );
    const [file] = download.files;
    if (!file) {
      throw new Error("The incoming peer did not receive a file");
    }
    expect(
      Bun.SHA256.hash(await Bun.file(join(download.path, file.path)).arrayBuffer(), "hex")
    ).toBe(Bun.SHA256.hash(context.bytes, "hex"));
    const uploaded = await waitFor(
      read,
      (state) => (state.detail?.uploaded ?? 0) >= context.bytes.length
    );
    expect(uploaded.settings).toMatchObject({ seedingConnectionMode: "incoming-only" });
  } finally {
    await new Promise<void>((resolve) => leecher.destroy(() => resolve()));
    await context.close();
  }
}, 30_000);
test("completed torrents reject manual outgoing peers in incoming-only mode and resume sharing in balanced mode", async () => {
  const context = await fixture(65_536, []);
  const leecher = new WebTorrent(network);
  try {
    const { id }: { id: string } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    await waitFor(
      () =>
        context.client.state
          .get({ query: { selected: id } })
          .then((response) => expectSuccess(response) as DashboardState),
      (state) => state.detail?.status === "seeding"
    );
    const download = await new Promise<Torrent>((resolve, reject) => {
      leecher.once("error", reject);
      leecher.add(
        context.seed.torrentFile,
        { announce: [], path: join(context.directory, "outgoing-download") },
        resolve
      );
    });
    await context.client.settings.patch({ seedingConnectionMode: "incoming-only" });
    const peer = `127.0.0.1:${leecher.torrentPort}`;
    const rejected = await context.client.torrents({ id }).peers.post({ peer });
    expect(rejected.status).toBe(409);
    expect(JSON.stringify(rejected.error?.value ?? rejected.data)).toContain("Balanced");
    expect(download.done).toBe(false);
    const balanced = await context.client.settings.patch({ seedingConnectionMode: "balanced" });
    expect(balanced.status).toBe(200);
    expect((await context.client.torrents({ id }).peers.post({ peer })).status).toBe(200);
    await waitFor(
      async () => download.done,
      (done) => done,
      30_000
    );
    const [file] = download.files;
    if (!file) {
      throw new Error("The outgoing peer did not receive a file");
    }
    expect(
      Bun.SHA256.hash(await Bun.file(join(download.path, file.path)).arrayBuffer(), "hex")
    ).toBe(Bun.SHA256.hash(context.bytes, "hex"));
  } finally {
    await new Promise<void>((resolve) => leecher.destroy(() => resolve()));
    await context.close();
  }
}, 45_000);
