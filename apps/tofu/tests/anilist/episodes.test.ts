import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";
import { provider } from "../helpers/provider";

test("an anime episode downloads from a real peer and its watched progress syncs to AniList", async () => {
  await using source = await peer();
  await using upstream = provider(source);
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(
    await client.plugins({ id: "anilist" }).put({ apiKey: "test-anilist-token", enabled: true })
  );
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  success(await client.anilist.list.post({}));
  const inbox = success(await client.anilist.notifications.get({ query: { category: "airing" } }));
  const [notification] = inbox.notifications;
  expect(notification?.anime?.mediaId).toBe(10);
  expect(notification?.episode).toBe(1);
  const mediaId = String(notification?.anime?.mediaId);
  const releases = success(await client.anilist.entries({ mediaId }).releases.post({}));
  expect(releases.errors).toEqual([]);
  expect(releases.releases).toHaveLength(1);
  expect(releases.releases[0]).toMatchObject({
    episode: notification?.episode,
    id: "episode-1",
    sourceId: "nyaa",
  });
  success(
    await client.discover.add.post({
      destinationId: "default",
      id: "episode-1",
      paused: false,
      sourceId: "nyaa",
    })
  );
  await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  expectBytes(
    await client.torrents({ id: source.id }).files({ index: "0" }).content.get(),
    source.bytes
  );
  const downloaded = success(await client.anilist.entries({ mediaId: "10" }).releases.post({}));
  expect(downloaded.torrents[0]?.id).toBe(source.id);
  expect(success(await client.anilist.get()).entries[0]?.progress).toBe(0);
  upstream.state.published = false;
  upstream.state.notifications.unshift({
    __typename: "AiringNotification",
    animeId: 20,
    createdAt: Math.floor(Date.now() / 1000),
    episode: 1,
    id: 700,
    media: { id: 20, synonyms: [], title: { english: "Example 2nd Season" }, type: "ANIME" },
    type: "AIRING",
  });
  const downloadedInbox = success(await client.anilist.notifications.get());
  expect(downloadedInbox.notifications.find((item) => item.id === 500)?.sources).toEqual([
    expect.objectContaining({
      episode: 1,
      fileIndex: 0,
      progress: 1,
      status: "playable",
      torrentId: source.id,
    }),
  ]);
  expect(downloadedInbox.notifications.find((item) => item.id === 700)?.sources).toEqual([]);
  expect(downloadedInbox.notifications.find((item) => item.episode === 2)?.sources).toEqual([]);

  success(
    await client.anilist
      .entries({ mediaId: "10" })
      .episodes({ episode: 1 })
      .put({ completed: true })
  );
  expect(upstream.state.writes).toEqual([
    {
      token: "Bearer test-anilist-token",
      variables: { mediaId: 10, progress: 1 },
    },
  ]);
  const tracked = success(await client.anilist.get());
  expect(tracked.entries[0]?.progress).toBe(1);
  expect(tracked.entries[0]?.completedEpisodes).toEqual([1]);
});
