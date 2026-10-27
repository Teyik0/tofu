import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { defaultAutomationPreferences } from "../../../../package/plugins/src/automation-rules";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";
import { provider } from "../helpers/provider";

test("an automation downloads a new matching release into its destination exactly once", async () => {
  await using source = await peer();
  await using upstream = provider(source);
  upstream.state.published = false;
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const server = await app.start();
  const { client } = server;
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const destination = success(
    await client.destinations.post({
      downloadPath: join(app.directory, "automated"),
      name: "Anime",
    })
  );
  const draft = {
    ...defaultAutomationPreferences,
    destinationId: destination.id,
    enabled: true,
    includeExisting: false,
    matchMode: "exact" as const,
    query: "Example",
    season: null,
    title: "Example",
  };
  const rule = success(
    await client.automations.post({
      ...draft,
      automatic: true,
      enabled: true,
      includeExisting: false,
      languages: ["VOSTFR"],
      matchMode: "exact",
      paused: false,
      sources: ["nyaa"],
      title: "Example",
      waitMinutes: 0,
    })
  );
  success(await client.automations({ id: rule.id }).run.post({}));
  expect(success(await client.state.get()).torrents).toHaveLength(0);
  upstream.state.published = true;
  const detected = success(await client.automations({ id: rule.id }).run.post({}));
  expect(detected.decisions).toContainEqual(
    expect.objectContaining({ status: "added", torrentId: source.id })
  );
  const completed = await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  expect(completed.destinationId).toBe(destination.id);
  expectBytes(
    await client.torrents({ id: source.id }).files({ index: "0" }).content.get(),
    source.bytes
  );
  const repeated = success(await client.automations({ id: rule.id }).run.post({}));
  expect(repeated.decisions.filter((decision) => decision.status === "added")).toHaveLength(1);
  expect(success(await client.state.get()).torrents).toHaveLength(1);
  await server.stop();
  {
    using db = new Database(join(app.directory, "state/tofu.sqlite"));
    db.run("UPDATE automations SET value = json_remove(value, '$.revision') WHERE id = ?", [
      rule.id,
    ]);
  }
  const restarted = await app.start();
  const restored = success(await restarted.client.automation.get());
  expect(restored.automations).toContainEqual(
    expect.objectContaining({ id: rule.id, revision: 0 })
  );
  expect(restored.decisions).toContainEqual(
    expect.objectContaining({ status: "added", torrentId: source.id })
  );
});
