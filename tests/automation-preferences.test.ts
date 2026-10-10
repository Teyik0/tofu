import { afterAll, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { createDatabase } from "../src/api/lib/db";
import { AutomationService } from "../src/api/modules/automation/service";
import type { AutomationDraft, AutomationPreferences, AutomationState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json } from "./helpers";

const upstream = Bun.serve({
  fetch: () => new Response("<rss><channel></channel></rss>"),
  hostname: "127.0.0.1",
  port: 0,
});
afterAll(() => upstream.stop(true));

async function open(directory: string, context: Awaited<ReturnType<typeof fixture>>) {
  const base = upstream.url.href;
  const service = await AutomationService.open({
    dataDir: join(directory, "feeds"),
    endpoints: { anilist: base, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  return { request, service };
}

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
    legacy.$client.close();
  }
  let { request, service } = await open(context.directory, context);
  try {
    const initial = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(initial.preferences).toEqual(preferences);
    expect(initial.plugins.find((plugin) => plugin.id === "jev")).toMatchObject({
      dailyLimit: 73,
      enabled: false,
      hasApiKey: true,
    });
    expect(JSON.stringify(initial)).not.toContain("legacy-key");
    expect(await (await request("/anilist", undefined)).json()).toMatchObject({
      userName: "Archive's preferred name",
      visibleStatuses: ["CURRENT", "COMPLETED"],
    });
    const updated = { ...preferences, paused: false, waitMinutes: 60 };
    expect(
      (await request("/automation/preferences", { ...json(updated), method: "PUT" })).status
    ).toBe(200);
    expect(
      (
        await request("/anilist/preferences", {
          ...json({ visibleStatuses: ["PLANNING"] }),
          method: "PUT",
        })
      ).status
    ).toBe(200);
    await service.close();
    ({ request, service } = await open(context.directory, context));
    expect(await (await request("/automation", undefined)).json()).toMatchObject({
      preferences: updated,
    });
    expect(await (await request("/anilist", undefined)).json()).toMatchObject({
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
  let { request, service } = await open(context.directory, context);
  try {
    const initial = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(initial.preferences).toEqual({
      automatic: true,
      codecs: [],
      deleteReplacedFiles: false,
      excludePacks: true,
      intervalMinutes: 15,
      languages: [],
      paused: false,
      priority: ["language", "resolution", "source", "codec"],
      resolutions: [],
      sources: ["tsundere", "nyaa", "c411"],
      waitMinutes: 0,
    });

    const saved = await request("/automation/preferences", {
      ...json(preferences),
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual(preferences);

    const interpret = async (query: string) =>
      (await (
        await request("/automations/interpret", json({ destinationId: "default", query }))
      ).json()) as AutomationDraft;
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
    ({ request, service } = await open(context.directory, context));
    const reopened = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(reopened.preferences).toEqual(preferences);
  } finally {
    await service.close();
    await context.close();
  }
});

test("preferences reject sources and languages outside the supported set", async () => {
  const context = await fixture(1024, []);
  const { request, service } = await open(context.directory, context);
  try {
    const invalid = await request("/automation/preferences", {
      ...json({ ...preferences, languages: ["DE"], sources: [] }),
      method: "PUT",
    });
    expect(invalid.status).toBe(422);
    const state = (await (await request("/automation", undefined)).json()) as AutomationState;
    expect(state.preferences.sources).toEqual(["tsundere", "nyaa", "c411"]);
  } finally {
    await service.close();
    await context.close();
  }
});
