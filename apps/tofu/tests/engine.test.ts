import { expect, test } from "bun:test";
import { expectSuccess } from "./helpers/problem";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

test("a magnet added through the API downloads real bytes and exposes its files and statistics", async () => {
  const context = await fixture(65_536, []);
  const { client } = context;
  try {
    const { id } = expectSuccess(
      await client.torrents.post({ paused: false, source: context.magnet })
    );
    const state = await waitFor(
      async () => expectSuccess(await client.state.get({ query: { selected: id } })),
      (value) => value.detail?.status === "seeding"
    );
    expect(state.detail?.progress).toBe(1);
    expect(state.detail?.downloaded).toBe(context.bytes.length);
    expect(state.detail?.files).toHaveLength(1);
    const content = await client.torrents({ id }).files({ index: "0" }).content.get();
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
});
