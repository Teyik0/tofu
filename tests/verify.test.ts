import { expect, test } from "bun:test";
import { join } from "node:path";
import type { DashboardState } from "../src/types";
import { expectSuccess } from "./helpers/problem";
import { fixture, torrentBytes, waitFor } from "./helpers/torrent";

test("verification reports conflicts for file access, another verification and destination moves", async () => {
  const context = await fixture(8 * 1024 * 1024, []);
  try {
    const { id } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    ) as { id: string };
    const read = async () =>
      expectSuccess(await context.client.state.get({ query: { selected: id } })) as DashboardState;
    await waitFor(read, (state) => state.detail?.status === "seeding");
    await context.client.torrents({ id }).pause.post({});
    const checking = context.client.torrents({ id }).verify.post({});
    await waitFor(read, (state) => state.detail?.status === "checking");
    const [during, content, move, duplicate] = await Promise.all([
      read(),
      context.client.torrents({ id }).files({ index: "0" }).content.get(),
      context.client.destinations({ id: "default" }).put({
        downloadPath: join(context.directory, "checking"),
        moveFiles: true,
        name: "Verification",
      }),
      context.client.torrents({ id }).verify.post({}),
    ]);
    expect(during.detail?.status).toBe("checking");
    expect(content.status).toBe(409);
    expect(content.error?.value).toMatchObject({ detail: expect.stringContaining("verification") });
    expect(move.status).toBe(409);
    expect(move.error?.value).toMatchObject({ detail: expect.stringContaining("verification") });
    expect(duplicate.status).toBe(409);
    expect(expectSuccess(await checking).ok).toBe(true);
    expect((await read()).detail?.status).toBe("paused");
  } finally {
    await context.close();
  }
});
test("force verification detects damaged data while paused and explicit repair enables resuming", async () => {
  const context = await fixture(65_536, []);
  try {
    const { id }: { id: string } = expectSuccess(
      await context.client.torrents.post({ paused: false, source: context.magnet })
    );
    const read = () =>
      context.client.state
        .get({ query: { selected: id } })
        .then((response) => expectSuccess(response) as DashboardState);
    const completed = await waitFor(read, (state) => state.detail?.status === "seeding");
    await context.client.torrents({ id }).pause.post({});
    await Bun.write(join(completed.detail?.savePath ?? "", "source.bin"), new Uint8Array(65_536));
    expect((await context.client.torrents({ id }).verify.post({})).status).toBe(200);
    const checked = await read();
    expect(checked.detail?.status).toBe("paused");
    expect(checked.detail?.progress).toBe(0);
    expect(checked.detail?.storageIssue?.kind).toBe("modified-files");
    expect((await context.client.torrents({ id }).repair.post({})).status).toBe(200);
    await context.client.torrents({ id }).resume.post({});
    await waitFor(read, (state) => state.detail?.status === "seeding");
    const content = await context.client.torrents({ id }).files({ index: "0" }).content.get();
    expect(Bun.SHA256.hash(torrentBytes(content), "hex")).toBe(
      Bun.SHA256.hash(context.bytes, "hex")
    );
  } finally {
    await context.close();
  }
}, 30_000);
