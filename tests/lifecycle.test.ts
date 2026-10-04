import { expect, test } from "bun:test";
import type { DashboardState } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test("pause stops network traffic and resume preserves the verified file bytes", async () => {
  const context = await fixture(1024 * 1024, []);
  context.engine.client.throttleDownload(256 * 1024);
  try {
    const { id }: { id: string } = await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json();
    const state = () =>
      context
        .request(`/state?selected=${id}`, undefined)
        .then((response) => response.json() as Promise<DashboardState>);
    await waitFor(state, (value) => (value.detail?.received ?? 0) > 0);
    const paused = await context.request(`/torrents/${id}/pause`, json({}));
    expect(paused.status).toBe(200);
    const before = await state();
    expect(before.detail?.status).toBe("paused");
    expect(before.detail?.peers).toBe(0);
    await Bun.sleep(200);
    expect((await state()).detail?.received).toBe(before.detail?.received);
    expect((await context.request(`/torrents/${id}/resume`, json({}))).status).toBe(200);
    await waitFor(state, (value) => value.detail?.status === "seeding");
    const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(content.status).toBe(200);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
}, 30_000);
