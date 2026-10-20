import { expect, test } from "bun:test";
import { join } from "node:path";
import type { LibraryState } from "../src/types";
import { expectSuccess } from "./helpers/problem";
import { fixture, waitFor } from "./helpers/torrent";

test("removing a torrent keeps its files unless deleting the data is explicitly requested", async () => {
  const context = await fixture(65_536, []);
  try {
    const add = async () =>
      expectSuccess(await context.client.torrents.post({ paused: false, source: context.magnet }));
    const { id } = await add();
    const read = async () =>
      expectSuccess(await context.client.state.get({ query: { selected: id } })) as LibraryState;
    await waitFor(read, (state) => state.detail?.status === "seeding");
    const { savePath } = expectSuccess(await context.client.torrents({ id }).host.get());
    const path = join(savePath, "source.bin");
    const unrelated = join(savePath, "notes.txt");
    await Bun.write(unrelated, "Keep this file");
    const keep = await context.client.torrents({ id }).delete({ deleteFiles: false });
    expect(keep.status).toBe(200);
    expect((await read()).torrents).toHaveLength(0);
    expect(await Bun.file(path).exists()).toBe(true);
    await add();
    await waitFor(read, (state) => state.detail?.status === "seeding");
    const remove = await context.client.torrents({ id }).delete({ deleteFiles: true });
    expect(remove.status).toBe(200);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await Bun.file(unrelated).text()).toBe("Keep this file");
    expect((await read()).torrents).toHaveLength(0);
  } finally {
    await context.close();
  }
}, 30_000);
