import { expect, test } from "bun:test";
import { join } from "node:path";
import type { DashboardState } from "../src/types";
import { fixture, json, waitFor } from "./helpers";

test("verification reports conflicts for file access, another verification and destination moves", async () => {
  const context = await fixture(8 * 1024 * 1024, []);
  try {
    const { id } = (await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json()) as { id: string };
    const read = async () =>
      (await context.request(`/state?selected=${id}`, undefined)).json() as Promise<DashboardState>;
    await waitFor(read, (state) => state.detail?.progress === 1);
    await context.request(`/torrents/${id}/pause`, json({}));
    const checking = context.engine.verify(id);
    const [during, content, move, duplicate] = await Promise.all([
      read(),
      context.request(`/torrents/${id}/files/0/content`, undefined),
      context.request("/destinations/default", {
        ...json({
          downloadPath: join(context.directory, "checking"),
          moveFiles: true,
          name: "Vérification",
        }),
        method: "PUT",
      }),
      context.request(`/torrents/${id}/verify`, json({})),
    ]);
    expect(during.detail?.status).toBe("checking");
    expect(content.status).toBe(409);
    expect((await content.json()).error).toContain("vérification");
    expect(move.status).toBe(409);
    expect((await move.json()).error).toContain("vérification");
    expect(duplicate.status).toBe(409);
    expect((await checking).ok).toBe(true);
    expect((await read()).detail?.status).toBe("paused");
  } finally {
    await context.close();
  }
});

test("force verification detects damaged data while paused and resume repairs it", async () => {
  const context = await fixture(65_536, []);
  try {
    const { id }: { id: string } = await (
      await context.request("/torrents", json({ paused: false, source: context.magnet }))
    ).json();
    const read = () =>
      context
        .request(`/state?selected=${id}`, undefined)
        .then((response) => response.json() as Promise<DashboardState>);
    const completed = await waitFor(read, (state) => state.detail?.status === "seeding");
    await context.request(`/torrents/${id}/pause`, json({}));
    await Bun.write(join(completed.detail?.savePath ?? "", "source.bin"), new Uint8Array(65_536));
    expect((await context.request(`/torrents/${id}/verify`, json({}))).status).toBe(200);
    const checked = await read();
    expect(checked.detail?.status).toBe("paused");
    expect(checked.detail?.progress).toBe(0);
    await context.request(`/torrents/${id}/resume`, json({}));
    await waitFor(read, (state) => state.detail?.status === "seeding");
    const content = await context.request(`/torrents/${id}/files/0/content`, undefined);
    expect(Bun.SHA256.hash(await content.arrayBuffer(), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
}, 30_000);
