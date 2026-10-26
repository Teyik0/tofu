import { expect, test } from "bun:test";
import { defaultAutomationPreferences } from "../../src/api/modules/automation/rules";
import { application } from "../helpers/app";
import { success } from "../helpers/assert";
import { releaseProvider } from "../helpers/release-provider";

test("generic automations support an optional episode starting point and non-episodic release patterns without replacing rule history", async () => {
  await using upstream = releaseProvider();
  upstream.state.entries = [
    { id: "earlier", title: "Example S02E04 VOSTFR 1080p x264" },
    { id: "wanted", title: "Example S02E05 VOSTFR 1080p x264" },
    { id: "other-season", title: "Example S03E05 VOSTFR 1080p x264" },
    { id: "guide", title: "Field Guide 2026 MULTI 1080p x264" },
  ];
  await using app = await application({
    entry: "tests/helpers/providers-server.ts",
    provider: upstream.url,
  });
  const { client } = await app.start();
  success(await client.plugins({ id: "nyaa" }).put({ enabled: true }));
  const draft = {
    ...defaultAutomationPreferences,
    afterEpisode: 4,
    automatic: false,
    destinationId: "default",
    enabled: true,
    includeExisting: true,
    matchMode: "exact" as const,
    query: "Example",
    season: 2,
    sources: ["nyaa"],
    title: "Example",
    waitMinutes: 0,
  };
  const preview = success(await client.automations.preview.post(draft));
  expect(preview.errors).toEqual([]);
  expect(
    preview.candidates
      .filter((candidate) => !candidate.reason)
      .map((candidate) => candidate.release.title)
  ).toEqual(["Example S02E05 VOSTFR 1080p x264"]);
  const rule = success(await client.automations.post(draft));
  const checked = success(await client.automations({ id: rule.id }).run.post({}));
  const decision = checked.decisions.find(
    (item) => item.automationId === rule.id && item.status === "review"
  );
  expect(decision?.release.episode).toBe(5);
  expect(decision?.release.season).toBe(2);

  const generic = {
    ...draft,
    afterEpisode: 0,
    excludePacks: false,
    matchMode: "pattern" as const,
    query: "^Field Guide",
    season: null,
    title: "^Field Guide",
  };
  const unfiltered = success(await client.automations.preview.post(generic));
  expect(
    unfiltered.candidates
      .filter((candidate) => !candidate.reason)
      .map((candidate) => candidate.release.title)
  ).toEqual(["Field Guide 2026 MULTI 1080p x264"]);
  const saved = success(await client.automations({ id: rule.id }).put(generic));
  expect(saved.id).toBe(rule.id);
  expect(saved.afterEpisode).toBe(0);
  expect(saved.season).toBeNull();
  const updated = success(await client.automations({ id: rule.id }).run.post({}));
  expect(updated.automations).toHaveLength(1);
  expect(updated.decisions).toContainEqual(expect.objectContaining({ id: decision?.id }));
  expect(updated.decisions).toContainEqual(
    expect.objectContaining({
      release: expect.objectContaining({ title: "Field Guide 2026 MULTI 1080p x264" }),
      status: "review",
    })
  );
  expect(success(await client.state.get()).torrents).toHaveLength(0);
});
