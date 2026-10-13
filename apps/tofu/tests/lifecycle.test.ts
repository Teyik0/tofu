import { expect, test } from "bun:test";
import type { DashboardState } from "../src/types";
import { expectSuccess } from "./helpers/problem";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

test("pause stops network traffic and resume preserves the verified file bytes", async () => {
  const context = await fixture(1024 * 1024, []);
  try {
    expectSuccess(await context.client.settings.patch({ downloadLimit: 256 * 1024 }));
    const { id }: { id: string } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const state = () =>
      context.client.state
        .get({ query: { selected: id } })
        .then((response) => expectSuccess(response) as DashboardState);
    await waitFor(state, (value) => (value.detail?.received ?? 0) > 0);
    const paused = await context.client.torrents({ id }).pause.post({});
    expect(paused.status).toBe(200);
    const before = await state();
    expect(before.detail?.status).toBe("paused");
    expect(before.detail?.peers).toBe(0);
    await Bun.sleep(200);
    expect((await state()).detail?.received).toBe(before.detail?.received);
    expect((await context.client.torrents({ id }).resume.post({})).status).toBe(200);
    await waitFor(state, (value) => value.detail?.status === "seeding");
    const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
}, 30_000);
