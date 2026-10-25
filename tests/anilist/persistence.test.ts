import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { provider } from "../helpers/provider";

test("AniList restores validated state and recalculates an invalid list cache", async () => {
  await using upstream = provider();
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  let server = await app.start();
  success(
    await server.client
      .plugins({ id: "anilist" })
      .put({ apiKey: "test-anilist-token", enabled: true })
  );
  success(await server.client.anilist.preferences.put({ visibleStatuses: ["PAUSED"] }));
  success(await server.client.anilist.list.post({}));
  await server.stop();
  server = await app.start();
  const restored = success(await server.client.anilist.get());
  expect(restored.visibleStatuses).toEqual(["PAUSED"]);
  expect(restored.entries[0]?.mediaId).toBe(10);
  expect(restored.accountId).toBe(42);
  await server.stop();
  {
    using db = new Database(join(app.directory, "state/tofu.sqlite"));
    db.run("UPDATE anilist SET value = ? WHERE id = 'list-cache'", [
      JSON.stringify({ entries: "invalid" }),
    ]);
  }
  server = await app.start();
  const refreshed = success(await server.client.anilist.list.post({}));
  expect(refreshed.entries[0]?.mediaId).toBe(10);
  expect(refreshed.visibleStatuses).toEqual(["PAUSED"]);
});

test("AniList refuses an invalid persisted configuration instead of defaulting it", async () => {
  await using app = await application({ entry: "tests/helpers/providers-server.ts" });
  const server = await app.start();
  success(await server.client.anilist.put({ userName: "ExampleUser" }));
  await server.stop();
  {
    using db = new Database(join(app.directory, "state/tofu.sqlite"));
    db.run("UPDATE anilist SET value = ? WHERE id = 'config'", [JSON.stringify({ clientId: 123 })]);
  }
  await expect(app.start()).rejects.toThrow("clientId");
});
