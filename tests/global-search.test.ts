import { expect, test } from "bun:test";
import { groupSearchReleases, searchTorrents } from "../src/lib/global-search";
import type { DashboardState, FeedRelease } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test("global search finds a completed torrent in another thread using all query words", async () => {
  const context = await fixture(1024, [], "Tougen Anki S02E02.bin");
  try {
    const destination = await context.request(
      "/destinations",
      json({ downloadPath: `${context.directory}/anime`, name: "Anime" })
    );
    const { id: destinationId } = (await destination.json()) as { id: string };
    const added = await context.request(
      "/torrents",
      json({ destinationId, paused: false, source: context.magnet })
    );
    const { id } = (await added.json()) as { id: string };
    const dashboard = await waitFor(
      async () =>
        (await (await context.request("/state?detail=false", undefined)).json()) as DashboardState,
      (state) => state.torrents[0]?.progress === 1
    );
    expect(searchTorrents(dashboard.torrents, "  ANKI tougen  ").map((item) => item.id)).toEqual([
      id,
    ]);
    expect(searchTorrents(dashboard.torrents, "anki missing")).toEqual([]);
    expect(searchTorrents(dashboard.torrents, "")[0]?.destinationId).toBe(destinationId);
  } finally {
    await context.close();
  }
});

function release(
  id: string,
  infoHash: string | null,
  sourceId: FeedRelease["sourceId"]
): FeedRelease {
  return {
    codec: null,
    downloadUrl: "magnet:?xt=urn:btih:example",
    episode: null,
    id,
    infoHash,
    language: null,
    pack: false,
    pageUrl: null,
    publishedAt: null,
    resolution: null,
    season: null,
    seeders: null,
    size: null,
    sourceId,
    title: "The same title",
    workTitle: "The same title",
  };
}

test("source search groups matching hashes but keeps unknown hashes and equal titles separate", () => {
  const hash = "a".repeat(40);
  const releases = [
    release("nyaa-result", hash, "nyaa"),
    release("tsundere-result", hash.toUpperCase(), "tsundere"),
    release("unknown-1", null, "nyaa"),
    release("unknown-2", null, "tsundere"),
    release("other-hash", "b".repeat(40), "nyaa"),
  ];
  const grouped = groupSearchReleases(releases);
  expect(grouped).toHaveLength(4);
  expect(grouped[0]?.releases.map((item) => item.sourceId)).toEqual(["nyaa", "tsundere"]);
  expect(grouped[0]?.key).toBe(hash);
  expect(grouped.slice(1).map((item) => item.releases[0]?.id)).toEqual([
    "unknown-1",
    "unknown-2",
    "other-hash",
  ]);
});
