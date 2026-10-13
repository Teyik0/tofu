import { afterAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/api/lib/db";
import type { AutomationDraft, AutomationPreferences, AutomationState } from "../src/types";
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
