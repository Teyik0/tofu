import { expect, test } from "bun:test";
import { application } from "../helpers/app";
import { expectBytes, success } from "../helpers/assert";
import { peer } from "../helpers/peer";
import { waitFor } from "../helpers/poll";
import { provider } from "../helpers/provider";

test("notification automation keeps one anime rule, its preferences and download history through edits and pause", async () => {
  await using source = await peer();
  await using upstream = provider(source);
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(
    await client.plugins({ id: "anilist" }).put({ apiKey: "test-anilist-token", enabled: true })
  );
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  success(await client.anilist.list.post({}));
  const inbox = success(await client.anilist.notifications.get());
  const mediaId = inbox.notifications[0]?.anime?.mediaId;
  if (!mediaId) {
    throw new Error("Expected an anime notification");
  }
  const draft = success(
    await client.automations.interpret.post({
      destinationId: "default",
      query: 'Download "Example"',
    })
  );
  const rule = success(
    await client.anilist.entries({ mediaId }).automation.put({
      ...draft,
      automatic: true,
      includeExisting: true,
      languages: ["VOSTFR", "MULTI"],
      resolutions: ["1080p", "720p"],
      sources: ["nyaa"],
      waitMinutes: 0,
    })
  );
  expect(rule).toMatchObject({
    enabled: true,
    key: `anime-rule:42:${mediaId}`,
    ownerId: "tofu.anilist",
  });
  expect(success(await client.anilist.get()).entries[0]?.automationId).toBe(rule.id);
  success(await client.automations({ id: rule.id }).run.post());
  await waitFor(
    async () => success(await client.torrents({ id: source.id }).get()),
    (torrent) => torrent.status === "seeding"
  );
  expectBytes(
    await client.torrents({ id: source.id }).files({ index: "0" }).content.get(),
    source.bytes
  );
  const changed = success(
    await client.anilist
      .entries({ mediaId })
      .automation.put({ ...rule, resolutions: ["720p", "1080p"] })
  );
  expect(changed.id).toBe(rule.id);
  expect(changed.languages).toEqual(["VOSTFR", "MULTI"]);
  expect(changed.codecs).toEqual(rule.codecs);
  const paused = success(
    await client.anilist.entries({ mediaId }).automation.put({ ...changed, enabled: false })
  );
  expect(paused).toMatchObject({ enabled: false, id: rule.id, paused: false });
  expect(success(await client.automation.get()).automations).toContainEqual(
    expect.objectContaining({ id: rule.id, status: "paused" })
  );
  const resumed = success(
    await client.anilist.entries({ mediaId }).automation.put({ ...paused, enabled: true })
  );
  expect(resumed.id).toBe(rule.id);
  const state = success(await client.automation.get());
  expect(state.automations).toHaveLength(1);
  expect(state.decisions).toContainEqual(
    expect.objectContaining({ automationId: rule.id, status: "added", torrentId: source.id })
  );
  expect(success(await client.state.get()).torrents).toHaveLength(1);
});

test("an anime notification can be added to Watching before enabling its automation", async () => {
  await using upstream = provider();
  upstream.state.listed = false;
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(
    await client.plugins({ id: "anilist" }).put({ apiKey: "test-anilist-token", enabled: true })
  );
  success(await client.anilist.list.post({}));
  expect(success(await client.anilist.get()).entries).toHaveLength(0);
  const inbox = success(await client.anilist.notifications.get());
  const mediaId = inbox.notifications[0]?.anime?.mediaId;
  if (!mediaId) {
    throw new Error("Expected an anime notification");
  }
  success(await client.anilist.entries({ mediaId }).editor.put({ status: "CURRENT" }));
  const draft = success(
    await client.automations.interpret.post({
      destinationId: "default",
      query: 'Download "Example"',
    })
  );
  const rule = success(
    await client.anilist
      .entries({ mediaId })
      .automation.put({ ...draft, includeExisting: true, sources: ["nyaa"] })
  );
  expect(rule.enabled).toBe(true);
  expect(success(await client.anilist.get()).entries[0]).toMatchObject({
    automationId: rule.id,
    mediaId,
    status: "CURRENT",
  });
});
