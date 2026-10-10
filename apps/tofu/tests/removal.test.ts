import { expect, test } from "bun:test";
import { join } from "node:path";
import type { DashboardState } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test("removing a torrent keeps its files unless deleting the data is explicitly requested", async () => {
  const context = await fixture(65_536, []);
  try {
    const add = () =>
      context
        .request("/torrents", json({ paused: false, source: context.magnet }))
        .then((response) => response.json() as Promise<{ id: string }>);
    const { id } = await add();
    const read = () =>
      context
        .request(`/state?selected=${id}`, undefined)
        .then((response) => response.json() as Promise<DashboardState>);
    const downloaded = await waitFor(read, (state) => state.detail?.status === "seeding");
    const path = join(downloaded.detail?.savePath ?? "", "source.bin");
    const unrelated = join(downloaded.detail?.savePath ?? "", "notes.txt");
    await Bun.write(unrelated, "Keep this file");
    const keep = await context.request(`/torrents/${id}`, {
      ...json({ deleteFiles: false }),
      method: "DELETE",
    });
    expect(keep.status).toBe(200);
    expect((await read()).torrents).toHaveLength(0);
    expect(await Bun.file(path).exists()).toBe(true);
    await add();
    await waitFor(read, (state) => state.detail?.status === "seeding");
    const remove = await context.request(`/torrents/${id}`, {
      ...json({ deleteFiles: true }),
      method: "DELETE",
    });
    expect(remove.status).toBe(200);
    expect(await Bun.file(path).exists()).toBe(false);
    expect(await Bun.file(unrelated).text()).toBe("Keep this file");
    expect((await read()).torrents).toHaveLength(0);
  } finally {
    await context.close();
  }
}, 30_000);
