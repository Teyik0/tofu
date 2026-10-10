import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "../src/api/lib/db";
import { TorrentEngine } from "../src/api/modules/torrents/service";
import { fixture, json, network } from "./helpers";

test("legacy torrents migrate into the shared database without modifying their source", async () => {
  const context = await fixture(4096, []);
  const directory = join(context.directory, "migration");
  const legacyPath = join(directory, "tofu.sqlite");
  let reopened: TorrentEngine | undefined;
  let database: Awaited<ReturnType<typeof openDatabase>> | undefined;
  try {
    const { id } = await (
      await context.request("/torrents", json({ paused: true, source: context.magnet }))
    ).json();
    await context.engine.close();
    await mkdir(directory);
    const sharedPath = join(context.directory, "state", "feeds.sqlite");
    const source = new Database(
      (await Bun.file(sharedPath).exists())
        ? sharedPath
        : join(context.directory, "state", "tofu.sqlite")
    );
    source.run("VACUUM INTO ?", [legacyPath]);
    source.close();
    const legacy = new Database(legacyPath);
    expect(legacy.query("SELECT id FROM torrents").all()).toEqual([{ id }]);
    legacy.close();
    const original = await Bun.file(legacyPath).bytes();
    database = await openDatabase(directory);
    expect(database.$client.query("SELECT id FROM torrents").all()).toEqual([{ id }]);
    reopened = await TorrentEngine.open({
      dataDir: directory,
      downloadPath: join(context.directory, "downloads"),
      network,
    });
    expect(reopened.detail(id).status).toBe("paused");
    await reopened.close();
    expect(await Bun.file(legacyPath).bytes()).toEqual(original);
    database.$client.close();
    database = await openDatabase(directory);
    expect(database.$client.query("SELECT id FROM torrents").all()).toEqual([{ id }]);
  } finally {
    await reopened?.close();
    database?.$client.close();
    await context.close();
  }
});
