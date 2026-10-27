import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { seedLegacyJev } from "../helpers/legacy-jev";
import { peer } from "../helpers/peer";
import { provider } from "../helpers/provider";

test("removing Jev migrates saved rules and AniList tracking to local matching", async () => {
  await using source = await peer();
  await using upstream = provider(source);
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  await seedLegacyJev(app.directory);
  const { client } = await app.start();
  const state = success(await client.automation.get());
  expect(state.plugins.map((plugin) => plugin.id)).toEqual(["anilist", "nyaa", "tsundere", "c411"]);
  expect((await client.plugins({ id: "jev" }).put({ enabled: true })).status).toBe(404);
  expect((await client.plugins({ id: "jev" }).test.post()).status).toBe(404);
  expect(state.automations).toContainEqual(
    expect.objectContaining({ id: "legacy-rule", matchMode: "exact", title: "Example" })
  );
  const anilist = success(await client.anilist.get());
  expect(anilist.subscriptions).toContainEqual(
    expect.objectContaining({
      id: "legacy-subscription",
      template: expect.objectContaining({ matchMode: "exact", title: "Example" }),
    })
  );
  const interpreted = success(
    await client.automations.interpret.post({
      destinationId: "default",
      query: "New episodes of Example season 2 in VF, 1080p on Nyaa",
    })
  );
  expect(interpreted).toMatchObject({
    languages: ["VF"],
    matchMode: "exact",
    resolutions: ["1080p"],
    season: 2,
    sources: ["nyaa"],
    title: "Example",
  });
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const [rule] = state.automations;
  if (!rule) {
    throw new Error("The migrated automation is missing");
  }
  const matching = success(await client.automations.preview.post({ ...rule, sources: ["nyaa"] }));
  expect(matching.candidates).toHaveLength(1);
  const unrelated = success(
    await client.automations.preview.post({ ...rule, sources: ["nyaa"], title: "Another show" })
  );
  expect(unrelated.candidates).toEqual([]);
  using db = new Database(join(app.directory, "state/tofu.sqlite"), { readonly: true });
  expect(db.query("SELECT id FROM plugins WHERE id = 'jev'").all()).toEqual([]);
  expect(db.query("SELECT name FROM sqlite_master WHERE name = 'judgements'").all()).toEqual([]);
});
