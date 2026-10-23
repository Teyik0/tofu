import { expect, test } from "bun:test";
import { join } from "node:path";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";
import { provider } from "../helpers/provider";

test("an automation downloads a new matching release into its destination exactly once", async () => {
  await using source = await peer();
  await using upstream = provider(source);
  upstream.state.published = false;
  await using app = await application({ provider: upstream.url });
  const { client } = await app.start();
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const destination = success(
    await client.destinations.post({
      downloadPath: join(app.directory, "automated"),
      name: "Anime",
    })
  );
  const draft = success(
    await client.automations.interpret.post({ destinationId: destination.id, query: "Example" })
  );
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
});

test("an automation preserves the evaluator's quota failure instead of returning success", async () => {
  await using source = await peer();
  await using upstream = provider(source);
  await using app = await application({ provider: upstream.url });
  const { client } = await app.start();
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const draft = success(
    await client.automations.interpret.post({ destinationId: "default", query: "Example" })
  );
  const rule = success(
    await client.automations.post({
      ...draft,
      enabled: true,
      includeExisting: true,
      languages: ["VOSTFR"],
      matchMode: "jev",
      sources: ["nyaa"],
      title: "Example",
    })
  );
  success(
    await client.plugins({ id: "jev" }).put({
      apiKey: "test-jev-key",
      dailyLimit: 1,
      enabled: true,
    })
  );
  // The failed HTTP call still consumes the daily quota.
  expect((await client.plugins({ id: "jev" }).test.post()).status).toBe(503);
  const preview = await client.automations.preview.post(rule);
  expect(preview.status).toBe(429);
  const runs = await Promise.all([
    client.automations({ id: rule.id }).run.post({}),
    client.automations({ id: rule.id }).run.post({}),
  ]);
  for (const run of runs) {
    expect(run.status).toBe(429);
    expect(run.error?.value).toMatchObject({ detail: "Jev daily limit reached" });
  }
  const state = success(await client.automation.get());
  expect(state.automations.find((entry) => entry.id === rule.id)?.error).toBe(
    "Check interrupted; retry scheduled"
  );
  expect(success(await client.state.get()).torrents).toEqual([]);
});
