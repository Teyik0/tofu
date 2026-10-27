import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { provider } from "../helpers/provider";

test("AniList notifications retain unread state, filter and paginate, and mark the account as read", async () => {
  await using upstream = provider();
  upstream.state.notifications.push(
    {
      __typename: "MediaDataChangeNotification",
      context: "received a data update.",
      createdAt: 1_793_016_000,
      id: 600,
      media: { episodes: 13, id: 11, title: { english: "Updated anime" }, type: "ANIME" },
      reason: "The episode count changed.",
      type: "MEDIA_DATA_CHANGE",
    },
    {
      __typename: "MediaDeletionNotification",
      context: "was removed from AniList.",
      createdAt: 1_793_016_000,
      deletedMediaTitle: "Removed anime",
      id: 601,
      reason: "Duplicate entry.",
      type: "MEDIA_DELETION",
    }
  );
  await using app = await application({
    provider: upstream.url,
  });
  const { client, url } = await app.start();
  const extensions = success(await client.extensions.get());
  expect(extensions.plugins.find((plugin) => plugin.id === "anilist")?.pages).toEqual([
    expect.objectContaining({ id: "library", path: "/anilist" }),
    expect.objectContaining({ id: "notifications", path: "/anilist/notifications" }),
  ]);
  success(
    await client
      .extensions({ id: "anilist" })
      .pages({ pageId: "notifications" })
      .post({ pinned: true })
  );
  const pinned = success(await client.extensions.get());
  expect(pinned.plugins.find((plugin) => plugin.id === "anilist")?.pages).toContainEqual(
    expect.objectContaining({ id: "notifications", path: "/anilist/notifications", pinned: true })
  );
  const page = await fetch(`${url}/anilist/notifications`);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Notifications · AniList — Tofu");
  expect(html).toContain("anilist-page-header");
  expect((await client.anilist.notifications.get()).status).toBe(409);
  expect(upstream.state.notificationRequests).toEqual([]);
  success(
    await client.plugins({ id: "anilist" }).put({ apiKey: "test-anilist-token", enabled: true })
  );
  success(await client.anilist.list.post({}));

  const inbox = success(await client.anilist.notifications.get());
  expect(inbox).toMatchObject({ hasNextPage: true, page: 1, unreadCount: 2 });
  expect(inbox.notifications).toHaveLength(30);
  expect(inbox.notifications[0]).toMatchObject({
    anime: { mediaId: 10, title: "Example" },
    episode: 1,
    id: 500,
  });
  expect(inbox.notifications.every((item) => item.type === "AIRING")).toBe(true);
  expect(upstream.state.notificationRequests.at(-1)).toEqual({
    token: "Bearer test-anilist-token",
    variables: {
      page: 1,
      reset: false,
      types: [
        "AIRING",
        "MEDIA_DATA_CHANGE",
        "MEDIA_DELETION",
        "MEDIA_MERGE",
        "RELATED_MEDIA_ADDITION",
      ],
    },
  });
  expect(upstream.state.unreadCount).toBe(2);
  const older = success(await client.anilist.notifications.get({ query: { page: 2 } }));
  expect(older).toMatchObject({ hasNextPage: false, page: 2 });
  expect(older.notifications).toHaveLength(3);
  expect(older.notifications.map((item) => item.type)).toEqual([
    "AIRING",
    "MEDIA_DATA_CHANGE",
    "MEDIA_DELETION",
  ]);
  expect(
    [...inbox.notifications, ...older.notifications].some(
      (item) => String(item.type) === "FOLLOWING"
    )
  ).toBe(false);
  const airing = success(await client.anilist.notifications.get({ query: { category: "airing" } }));
  expect(airing.notifications).toHaveLength(30);
  expect(airing.notifications.every((item) => item.type === "AIRING")).toBe(true);
  expect(upstream.state.notificationRequests.at(-1)?.variables.types).toEqual(["AIRING"]);
  const media = success(await client.anilist.notifications.get({ query: { category: "media" } }));
  expect(media.notifications).toHaveLength(2);
  expect(media.notifications[0]).toMatchObject({
    anime: { mediaId: 11 },
    episode: null,
    reason: "The episode count changed.",
    title: "Updated anime",
  });
  expect(media.notifications[1]).toMatchObject({
    anime: null,
    episode: null,
    reason: "Duplicate entry.",
    title: "Removed anime",
  });
  expect(upstream.state.notificationRequests.at(-1)).toEqual({
    token: "Bearer test-anilist-token",
    variables: {
      page: 1,
      reset: false,
      types: ["MEDIA_DATA_CHANGE", "MEDIA_DELETION", "MEDIA_MERGE", "RELATED_MEDIA_ADDITION"],
    },
  });
  const empty = success(
    await client.anilist.notifications.get({ query: { category: "media", page: 2 } })
  );
  expect(empty.notifications).toEqual([]);

  success(await client.anilist.notifications.read.post({}));
  expect(upstream.state.unreadCount).toBe(0);
  expect(success(await client.anilist.notifications.get()).unreadCount).toBe(0);
  expect(upstream.state.notificationRequests.filter((item) => item.variables.reset)).toHaveLength(
    1
  );

  expect((await client.anilist.notifications.get({ query: { page: 0 } })).status).toBe(422);
  expect((await client.anilist.notifications.get({ query: { page: 167 } })).status).toBe(422);
  upstream.state.anilistStatus = 503;
  const failed = await client.anilist.notifications.get();
  expect(failed.status).toBe(502);
  expect(JSON.stringify(failed.error?.value)).not.toContain("Private provider diagnostics");
  expect(JSON.stringify(failed.error?.value)).not.toContain("test-anilist-token");
  upstream.state.anilistStatus = 200;
  success(await client.plugins({ id: "anilist" }).put({ enabled: false }));
  expect((await client.anilist.notifications.get()).status).toBe(409);
  expect((await client.anilist.notifications.read.post({})).status).toBe(409);
});
