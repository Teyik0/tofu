import { expect, test } from "bun:test";
import { editorFixture } from "../helpers/anilist/editor";
import { expectSuccess } from "../helpers/problem";
import { torrentBytes, waitFor } from "../helpers/torrent";

test("AniList editor loads account options and saves list fields into the library", async () => {
  const context = await editorFixture();
  try {
    const response = await context.client.anilist.entries({ mediaId: "10" }).editor.get();
    expect(response.status).toBe(200);
    const editor = expectSuccess(response);
    expect(editor.options).toEqual({
      advancedScoring: ["Story", "Animation"],
      advancedScoringEnabled: true,
      customLists: ["Weekend"],
      scoreFormat: "POINT_3",
    });
    expect(editor.entry).toMatchObject({
      customLists: ["Weekend"],
      id: 100,
      score: 3,
      startedAt: { day: null, month: 10, year: 2026 },
    });
    const saved = await context.client.anilist.entries({ mediaId: "10" }).editor.put({
      advancedScores: [85, 90],
      completedAt: { day: 11, month: 10, year: 2026 },
      customLists: ["Weekend"],
      hiddenFromStatusLists: true,
      notes: "Updated notes",
      priority: 2,
      private: true,
      progress: 12,
      repeat: 1,
      score: 2,
      startedAt: { day: null, month: 10, year: 2026 },
      status: "COMPLETED",
    });
    expect(saved.status).toBe(200);
    const state = expectSuccess(saved);
    expect(state.entries[0]).toMatchObject({ mediaId: 10, progress: 12, status: "COMPLETED" });
    expect(state.entries[0]?.completedEpisodes).toHaveLength(12);
  } finally {
    await context.close();
  }
});
test("favourites can be added and removed without duplicating a repeated request", async () => {
  const context = await editorFixture();
  try {
    const set = (enabled: boolean) =>
      context.client.anilist.entries({ mediaId: "10" }).favourite.put({ enabled });
    expect((await set(true)).status).toBe(200);
    expect(expectSuccess(await set(true))).toEqual({ isFavourite: true });
    expect(context.remote.favouriteWrites).toBe(1);
    expect(expectSuccess(await set(false))).toEqual({ isFavourite: false });
    context.remote.reject = true;
    expect((await set(true)).status).toBe(502);
    context.remote.reject = false;
    expect(
      expectSuccess(await context.client.anilist.entries({ mediaId: "10" }).editor.get())
        .isFavourite
    ).toBe(false);
  } finally {
    await context.close();
  }
});
test("removing an anime list entry preserves downloaded files and allows adding it again", async () => {
  const context = await editorFixture();
  try {
    const torrent = await context.client.torrents.post({ paused: false, source: context.magnet });
    expect(torrent.status).toBe(200);
    const { id } = expectSuccess(torrent);
    await waitFor(
      async () => expectSuccess(await context.client.state.get({ query: { selected: id } })),
      (state) => state.detail?.status === "seeding"
    );
    context.remote.reject = true;
    expect((await context.client.anilist.entries({ mediaId: "10" }).editor.delete({})).status).toBe(
      502
    );
    expect(expectSuccess(await context.client.anilist.get()).entries).toHaveLength(1);
    context.remote.reject = false;
    expect((await context.client.anilist.entries({ mediaId: "10" }).editor.delete({})).status).toBe(
      200
    );
    expect(expectSuccess(await context.client.anilist.get()).entries).toHaveLength(0);
    const editor = expectSuccess(
      await context.client.anilist.entries({ mediaId: "10" }).editor.get()
    );
    expect(editor.entry).toBeNull();
    const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(content.status).toBe(200);
    expect(new Uint8Array(torrentBytes(content))).toEqual(context.bytes);
    const added = await context.client.anilist
      .entries({ mediaId: "10" })
      .editor.put({ status: "PLANNING" });
    expect(added.status).toBe(200);
    expect(expectSuccess(added).entries[0]?.status).toBe("PLANNING");
  } finally {
    await context.close();
  }
});
test("invalid editor values and rejected writes leave the library unchanged", async () => {
  const context = await editorFixture();
  try {
    const save = (body: object) =>
      context.client.anilist.entries({ mediaId: "10" }).editor.put(body);
    expect((await save({ score: 4 })).status).toBe(400);
    expect((await save({ progress: 13 })).status).toBe(400);
    expect((await save({ customLists: ["Unknown"] })).status).toBe(400);
    expect((await save({ advancedScores: [50] })).status).toBe(400);
    const date = await save({ completedAt: { day: 30, month: 2, year: 2026 } });
    expect([400, 422]).toContain(date.status);
    expect(context.remote.saves).toBe(0);
    context.remote.reject = true;
    expect((await save({ progress: 12, status: "COMPLETED" })).status).toBe(502);
    expect(expectSuccess(await context.client.anilist.get()).entries[0]).toMatchObject({
      progress: 2,
      status: "CURRENT",
    });
    await context.client.plugins({ id: "anilist" }).put({ apiKey: "", enabled: true });
    expect((await save({ status: "COMPLETED" })).status).toBe(409);
    expect(
      (await context.client.anilist.entries({ mediaId: "10" }).favourite.put({ enabled: true }))
        .status
    ).toBe(409);
    expect((await context.client.anilist.entries({ mediaId: "10" }).editor.delete({})).status).toBe(
      409
    );
  } finally {
    await context.close();
  }
});
