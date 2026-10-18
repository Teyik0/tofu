import { afterAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/api/lib/db";
import type {
  AutomationDraft,
  AutomationPreferences,
  AutomationState,
  FeedRelease,
} from "../src/types";
import { automationFixture } from "./helpers/automation";
import { expectSuccess } from "./helpers/problem";
import { fixture } from "./helpers/torrent";

const upstream = Bun.serve({
  fetch: () => new Response("<rss><channel></channel></rss>"),
  hostname: "127.0.0.1",
  port: 0,
});
afterAll(() => upstream.stop(true));
const preferences: AutomationPreferences = {
  automatic: false,
  codecs: ["H.265"],
  deleteReplacedFiles: true,
  excludePacks: false,
  intervalMinutes: 30,
  languages: ["VOSTFR"],
  paused: true,
  priority: ["resolution", "language", "codec", "source"],
  resolutions: ["1080p", "720p"],
  sources: ["nyaa", "tsundere"],
  waitMinutes: 45,
};
test("legacy automation and AniList settings survive opening and updating the existing database", async () => {
  const context = await fixture(1024, []);
  const dataDir = join(context.directory, "feeds");
  await mkdir(dataDir);
  const legacy = createDatabase(join(dataDir, "feeds.sqlite"));
  try {
    legacy.run(sql`CREATE TABLE preferences (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    legacy.run(sql`CREATE TABLE plugins (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    legacy.run(sql`CREATE TABLE anilist (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    legacy.run(sql`INSERT INTO preferences VALUES ('automation', ${JSON.stringify(preferences)})`);
    legacy.run(
      sql`INSERT INTO plugins VALUES ('jev', ${JSON.stringify({ apiKey: "legacy-key", dailyLimit: 73, enabled: false })})`
    );
    legacy.run(
      sql`INSERT INTO anilist VALUES ('config', ${JSON.stringify({ userName: "Archive's preferred name" })})`
    );
    legacy.run(
      sql`INSERT INTO anilist VALUES ('preferences', ${JSON.stringify(["CURRENT", "COMPLETED"])})`
    );
  } finally {
    legacy.$client.close(true);
  }
  let { client, service } = await automationFixture(context.directory, context, upstream.url.href);
  try {
    const initial = expectSuccess(await client.automation.get()) as AutomationState;
    expect(initial.preferences).toEqual(preferences);
    expect(initial.plugins.find((plugin) => plugin.id === "jev")).toMatchObject({
      dailyLimit: 73,
      enabled: false,
      hasApiKey: true,
    });
    expect(JSON.stringify(initial)).not.toContain("legacy-key");
    expect(expectSuccess(await client.anilist.get())).toMatchObject({
      userName: "Archive's preferred name",
      visibleStatuses: ["CURRENT", "COMPLETED"],
    });
    const updated = { ...preferences, paused: false, waitMinutes: 60 };
    expect((await client.automation.preferences.put(updated)).status).toBe(200);
    expect((await client.anilist.preferences.put({ visibleStatuses: ["PLANNING"] })).status).toBe(
      200
    );
    await service.close();
    ({ client, service } = await automationFixture(context.directory, context, upstream.url.href));
    expect(expectSuccess(await client.automation.get())).toMatchObject({ preferences: updated });
    expect(expectSuccess(await client.anilist.get())).toMatchObject({
      userName: "Archive's preferred name",
      visibleStatuses: ["PLANNING"],
    });
  } finally {
    await service.close();
    await context.close();
  }
});
test("general preferences shape new rules, explicit requests override them, and they persist", async () => {
  const context = await fixture(1024, []);
  let { client, service } = await automationFixture(context.directory, context, upstream.url.href);
  try {
    const initial = expectSuccess(await client.automation.get()) as AutomationState;
    expect(initial.preferences).toEqual({
      automatic: true,
      codecs: ["H.265", "H.264"],
      deleteReplacedFiles: false,
      excludePacks: true,
      intervalMinutes: 15,
      languages: ["VOSTFR", "MULTI"],
      paused: false,
      priority: ["language", "resolution", "source", "codec"],
      resolutions: ["1080p", "720p"],
      sources: ["tsundere", "nyaa", "c411"],
      waitMinutes: 0,
    });
    const firstDraft = expectSuccess(
      await client.automations.interpret.post({ destinationId: "default", query: "Example" })
    ) as AutomationDraft;
    expect(firstDraft).toMatchObject({ ...initial.preferences, title: "Example" });
    const saved = await client.automation.preferences.put(preferences);
    expect(saved.status).toBe(200);
    expect(expectSuccess(saved)).toEqual(preferences);
    const interpret = async (query: string) =>
      expectSuccess(
        await client.automations.interpret.post({ destinationId: "default", query })
      ) as AutomationDraft;
    const plain = await interpret("Example");
    expect(plain).toMatchObject({ ...preferences, title: "Example" });
    const explicit = await interpret("Example in VF 2160p with H.264 on Tsundere-Raws");
    expect(explicit.codecs).toEqual(["H.264"]);
    expect(explicit.languages).toEqual(["VF"]);
    expect(explicit.resolutions).toEqual(["2160p"]);
    expect(explicit.sources).toEqual(["tsundere"]);
    expect(explicit.waitMinutes).toBe(45);
    const bareCodec = await interpret("download Frieren x265");
    expect(bareCodec).toMatchObject({ codecs: ["H.265"], title: "Frieren" });
    const codecRequests = await Promise.all(
      ["x264", "h 264", "AVC", "AV1", "HEVC", "x265", "h265"].map((codec) =>
        interpret(`Example in ${codec}`)
      )
    );
    expect(codecRequests.map((draft) => ({ codecs: draft.codecs, title: draft.title }))).toEqual([
      { codecs: ["H.264"], title: "Example" },
      { codecs: ["H.264"], title: "Example" },
      { codecs: ["H.264"], title: "Example" },
      { codecs: ["AV1"], title: "Example" },
      { codecs: ["H.265"], title: "Example" },
      { codecs: ["H.265"], title: "Example" },
      { codecs: ["H.265"], title: "Example" },
    ]);
    await service.close();
    ({ client, service } = await automationFixture(context.directory, context, upstream.url.href));
    const reopened = expectSuccess(await client.automation.get()) as AutomationState;
    expect(reopened.preferences).toEqual(preferences);
  } finally {
    await service.close();
    await context.close();
  }
});
test("preferences reject sources and languages outside the supported set", async () => {
  const context = await fixture(1024, []);
  const { client, service } = await automationFixture(
    context.directory,
    context,
    upstream.url.href
  );
  try {
    const invalid = await client.automation.preferences.put({
      ...preferences,
      languages: ["DE"] as never,
      sources: [],
    });
    expect(invalid.status).toBe(422);
    const state = expectSuccess(await client.automation.get()) as AutomationState;
    expect(state.preferences.sources).toEqual(["tsundere", "nyaa", "c411"]);
  } finally {
    await service.close();
    await context.close();
  }
});

test("Jev retains inherited formats and season-zero rules save and match specials", async () => {
  const context = await fixture(1024, []);
  const provider = Bun.serve({
    async fetch(incoming) {
      if (incoming.method === "POST") {
        const body = (await incoming.json()) as {
          questions: Record<string, { type: string; criteria?: Record<string, string> }>;
        };
        return Response.json({
          answers: Object.fromEntries(
            Object.entries(body.questions).map(([id, question]) => [
              id,
              question.type === "noul"
                ? { noul: 0.99, type: "noul" }
                : {
                    choice:
                      id === "languages" || id === "resolutions"
                        ? "1"
                        : Object.keys(question.criteria ?? {})[0],
                    confidence: 0.99,
                    type: "choice",
                  },
            ])
          ),
          model: "test-jev",
        });
      }
      return Response.json({
        entries: [0, 1].map((season) => ({
          episode: 1,
          id: `season-${season}`,
          language: "VOSTFR",
          quality: "1080p",
          season,
          title: `Kaijuu no 8 S0${season}E01 VOSTFR 1080p x264 Narumi`,
          torrentUrl: context.magnet,
        })),
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const { client, service } = await automationFixture(
    context.directory,
    context,
    provider.url.href
  );
  try {
    const configured = {
      ...preferences,
      codecs: ["H.265", "H.264"],
      languages: ["VOSTFR", "MULTI"] as AutomationPreferences["languages"],
      sources: ["tsundere"],
    };
    expectSuccess(await client.automation.preferences.put(configured));
    const requests = [
      ["New episode of Kaijuu no 8 s00 Narumi", "Kaijuu no 8", 0],
      ["New episodes of Example season 2 in VF", "Example", 2],
      ["The Apothecary Diaries", "The Apothecary Diaries", null],
    ] as const;
    await Promise.all(
      requests.map(async ([query, title, season]) => {
        const local = expectSuccess(
          await client.automations.interpret.post({ destinationId: "default", query })
        );
        expect(local).toMatchObject({ season, title });
      })
    );
    expectSuccess(await client.plugins({ id: "tsundere" }).put({ enabled: true }));
    expectSuccess(await client.plugins({ id: "jev" }).put({ apiKey: "test-jev", enabled: true }));
    const draft = expectSuccess(
      await client.automations.interpret.post({
        destinationId: "default",
        query: "New episode of Kaijuu no 8 s00 Narumi",
      })
    );
    expect(draft).toMatchObject({
      languages: configured.languages,
      matchMode: "jev",
      resolutions: configured.resolutions,
      season: 0,
      title: "Kaijuu no 8",
    });
    const input = { ...draft, includeExisting: true };
    const rule = expectSuccess(await client.automations.post(input));
    expect(rule).toMatchObject(input);
    const preview = expectSuccess(await client.automations.preview.post(input)) as {
      candidates: { release: FeedRelease }[];
    };
    expect(preview.candidates.map((candidate) => candidate.release.season)).toEqual([0]);
    const checked = expectSuccess(await client.automations({ id: rule.id }).run.post());
    expect(checked.decisions).toHaveLength(1);
    expect(checked.decisions[0]).toMatchObject({ release: { season: 0 }, status: "review" });
    const edited = {
      ...input,
      languages: ["VF"] as AutomationDraft["languages"],
      resolutions: ["720p"],
    };
    expect(expectSuccess(await client.automations({ id: rule.id }).put(edited))).toMatchObject(
      edited
    );
    expect(expectSuccess(await client.automation.get()).automations[0]).toMatchObject(edited);
    const unrestricted = expectSuccess(
      await client.automations.interpret.post({
        destinationId: "default",
        query: "Follow Example with any language and any resolution",
      })
    );
    expect(unrestricted.languages).toEqual([]);
    expect(unrestricted.resolutions).toEqual([]);
  } finally {
    await service.close();
    provider.stop(true);
    await context.close();
  }
});
