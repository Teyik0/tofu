import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Torrent } from "webtorrent";
import type { LibraryState } from "../src/types";
import { expectSuccess } from "./helpers/problem";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

test("skipping a file preserves the shared pieces needed by the preceding selected file", async () => {
  const context = await fixture(8192, []);
  try {
    const source = join(context.directory, "collection");
    await Bun.write(join(source, "first.bin"), context.bytes);
    await Bun.write(join(source, "second.bin"), context.bytes);
    const seedOptions = { announce: [], pieceLength: 16_384 };
    const seed = await new Promise<Torrent>((resolve) =>
      context.seeder.seed(source, seedOptions, resolve)
    );
    const body = {
      file: new File([new Uint8Array(seed.torrentFile)], "collection.torrent"),
      paused: "true" as const,
    };
    const { id } = expectSuccess(await context.client.torrents.file.post(body)) as { id: string };
    expect(
      (await context.client.torrents({ id }).files({ index: "1" }).put({ priority: "skip" })).status
    ).toBe(200);
    expectSuccess(await context.client.torrents({ id }).resume.post({}));
    expectSuccess(
      await context.client
        .torrents({ id })
        .peers.post({ peer: `127.0.0.1:${context.seeder.torrentPort}` })
    );
    const detail = await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (value) => value.status === "seeding"
    );
    expect(detail.files[1]?.priority).toBe("skip");
    const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(content.status).toBe(200);
    expect(new Uint8Array(torrentBytes(content))).toEqual(new Uint8Array(context.bytes));
  } finally {
    await context.close();
  }
});
test("file access returns a useful error when downloaded data has disappeared", async () => {
  const context = await fixture(65_536, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    await waitFor(
      async () => expectSuccess(await context.client.torrents({ id }).get()),
      (value) => value.status === "seeding"
    );
    const { savePath } = expectSuccess(await context.client.torrents({ id }).host.get());
    await context.client.torrents({ id }).pause.post({});
    await rm(join(savePath, "source.bin"));
    await Promise.all(
      ["availability", "content"].map(async (endpoint) => {
        const response = await context.client
          .torrents({ id })
          .files({ index: "0" })
          [endpoint as "availability" | "content"].get();
        expect(response.status).toBe(404);
        expect(response.error?.value).toMatchObject({
          detail: expect.stringContaining("is no longer present"),
        });
      })
    );
  } finally {
    await context.close();
  }
});
test("a .torrent upload can skip and prioritize a file, and bandwidth settings are applied", async () => {
  const context = await fixture(65_536, []);
  try {
    const added = await context.client.torrents.file.post({
      file: new File([new Uint8Array(context.seed.torrentFile)], "source.torrent"),
      paused: "true",
    });
    expect(added.status).toBe(200);
    const { id }: { id: string } = expectSuccess(added);
    const read = async () =>
      expectSuccess(await context.client.state.get({ query: { selected: id } })) as LibraryState;
    expect((await read()).detail?.files).toHaveLength(1);
    const skip = await context.client
      .torrents({ id })
      .files({ index: "0" })
      .put({ priority: "skip" });
    expect(skip.status).toBe(200);
    expectSuccess(await context.client.torrents({ id }).resume.post({}));
    expectSuccess(
      await context.client
        .torrents({ id })
        .peers.post({ peer: `127.0.0.1:${context.seeder.torrentPort}` })
    );
    await waitFor(read, (state) => (state.detail?.peers ?? 0) > 0);
    await Bun.sleep(150);
    expect((await read()).detail?.downloaded).toBe(0);
    const high = await context.client
      .torrents({ id })
      .files({ index: "0" })
      .put({ priority: "high" });
    expect(high.status).toBe(200);
    const complete = await waitFor(read, (state) => state.detail?.status === "seeding");
    expect(complete.detail?.files[0]?.priority).toBe("high");
    const setting = {
      ...expectSuccess(await context.client.host.get()).settings,
      downloadLimit: 1_048_576,
      uploadLimit: 524_288,
    };
    expect((await context.client.settings.put(setting)).status).toBe(200);
    expect(expectSuccess(await context.client.host.get()).settings).toEqual(setting);
  } finally {
    await context.close();
  }
}, 30_000);
