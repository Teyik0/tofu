import { expect, test } from "bun:test";
import type { DashboardState, TorrentDetail } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test("dashboard reads send summaries while a selected torrent exposes its own details", async () => {
  const context = await fixture(65_536, []);
  try {
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    await waitFor(
      async () => context.engine.snapshot(id),
      (state) => state.detail?.progress === 1
    );
    const overview = (await (
      await context.request("/state?detail=false", undefined)
    ).json()) as DashboardState;
    expect(overview.detail).toBeNull();
    expect(overview.torrents).toHaveLength(1);
    expect(overview.torrents[0]?.progress).toBe(1);
    const response = await context.request(`/torrents/${id}`, undefined);
    expect(response.status).toBe(200);
    expect(JSON.parse(response.headers.get("x-furin-query") ?? "null").id).toBe("tofu.torrent");
    const detail = (await response.json()) as TorrentDetail;
    expect(detail.id).toBe(id);
    expect(detail.files).toHaveLength(1);
    expect(detail.verifiedPieces).toBe(detail.pieces);
    expect((await context.request("/torrents/unknown", undefined)).status).toBe(404);
  } finally {
    await context.close();
  }
});
