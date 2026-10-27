import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { provider } from "../helpers/provider";

test("AniList catalog browsing and list edits use the provider and retain saved changes", async () => {
  await using upstream = provider();
  await using app = await application({
    provider: upstream.url,
  });
  const { client, url } = await app.start();
  const page = await fetch(`${url}/anilist`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("AniList — Tofu");
  expect(html).toContain("anilist-page-header");
  const catalog = success(await client.anilist.catalog.post({ search: "Example" }));
  expect(catalog.media).toHaveLength(1);
  expect(catalog.media[0]).toMatchObject({ mediaId: 10, title: "Example" });
  success(
    await client.plugins({ id: "anilist" }).put({ apiKey: "test-anilist-token", enabled: true })
  );
  success(await client.anilist.list.post({}));
  const editor = success(await client.anilist.entries({ mediaId: "10" }).editor.get());
  expect(editor.entry?.notes).toBe("");
  const saved = success(
    await client.anilist
      .entries({ mediaId: "10" })
      .editor.put({ notes: "Watch this weekend", status: "PAUSED" })
  );
  expect(saved.entries[0]?.status).toBe("PAUSED");
  expect(upstream.state.writes).toEqual([
    {
      token: "Bearer test-anilist-token",
      variables: expect.objectContaining({
        mediaId: 10,
        notes: "Watch this weekend",
        status: "PAUSED",
      }),
    },
  ]);
  const reopened = success(await client.anilist.entries({ mediaId: "10" }).editor.get());
  expect(reopened.entry?.notes).toBe("Watch this weekend");
  expect(reopened.entry?.status).toBe("PAUSED");
});
