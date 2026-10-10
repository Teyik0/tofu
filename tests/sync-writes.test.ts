import { expect, test } from "bun:test";
import { join } from "node:path";
import { createSyncChangesPlugin } from "@teyik0/furin/sync";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { sql } from "drizzle-orm";
import { AutomationService } from "../src/api/modules/automation/service";
import { pluginEndpoints } from "../src/api/modules/plugins/service";
import type { AutomationPreferences, AutomationState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json } from "./helpers";

test("a failed preferences write leaves persisted state, live state and the journal unchanged", async () => {
  const context = await fixture(1024, []);
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: pluginEndpoints,
    engine: () => context.engine,
    now: Date.now,
  });
  const api = (
    await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    )
  ).use(
    createSyncChangesPlugin({
      adapter: drizzleSyncAdapter({ db: service.db, namespace: "tofu" }),
      principal: () => "local",
    })
  );
  const initial = service.snapshot().preferences;
  const changed = { ...initial, waitMinutes: 35 };
  const save = () =>
    api.handle(
      new Request("http://localhost/api/automation/preferences", {
        ...json(changed),
        headers: { "content-type": "application/json", "idempotency-key": "retry-preferences" },
        method: "PUT",
      })
    );
  try {
    service.db.run(sql`CREATE TRIGGER reject_preferences BEFORE INSERT ON preferences
      BEGIN SELECT RAISE(ABORT, 'Write rejected'); END`);
    expect((await save()).status).toBe(500);
    expect(service.snapshot().preferences).toEqual(initial);
    const page = await (await api.handle("http://localhost/_furin/sync/changes?after=0")).json();
    expect(page.cursor).toBe("0");
    service.db.run(sql`DROP TRIGGER reject_preferences`);
    expect((await save()).status).toBe(200);
    expect(service.snapshot().preferences).toEqual(changed);
  } finally {
    await service.close();
    await context.close();
  }
});

test("saved automation preferences replay their original response without overwriting a newer change", async () => {
  const context = await fixture(1024, []);
  let clock = Date.now();
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: pluginEndpoints,
    engine: () => context.engine,
    now: () => clock,
  });
  const api = (
    await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    )
  ).use(
    createSyncChangesPlugin({
      adapter: drizzleSyncAdapter({ db: service.db, namespace: "tofu" }),
      principal: () => "local",
    })
  );
  const initial = service.snapshot().preferences;
  const first = { ...initial, waitMinutes: 20 };
  const newer = { ...initial, waitMinutes: 60 };
  const save = (preferences: AutomationPreferences, key: string) =>
    api.handle(
      new Request("http://localhost/api/automation/preferences", {
        ...json(preferences),
        headers: { "content-type": "application/json", "idempotency-key": key },
        method: "PUT",
      })
    );
  try {
    const response = await save(first, "first-preferences");
    if (response.status !== 200) {
      throw new Error(await response.text());
    }
    expect(response.status).toBe(200);
    const result = await response.json();
    const page = await (await api.handle("http://localhost/_furin/sync/changes?after=0")).json();
    expect(page.cursor).not.toBe("0");
    clock += 1000;
    expect((await save(newer, "newer-preferences")).status).toBe(200);
    const replay = await save(first, "first-preferences");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(result);
    const state = (await (
      await api.handle("http://localhost/api/automation")
    ).json()) as AutomationState;
    expect(state.preferences).toEqual(newer);
  } finally {
    await service.close();
    await context.close();
  }
});

test("creating and deleting an automation can be replayed without creating a second rule or restoring a deleted rule", async () => {
  const context = await fixture(1024, []);
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: pluginEndpoints,
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const draft = { ...(await service.interpret("Example", "default")), includeExisting: true };
  const request = (path: string, method: string, key: string, body: object | undefined) =>
    api.handle(
      new Request(`http://localhost/api${path}`, {
        body: body ? JSON.stringify(body) : undefined,
        headers: { "content-type": "application/json", "idempotency-key": key },
        method,
      })
    );
  try {
    const created = await request("/automations", "POST", "create-rule", draft);
    expect(created.status).toBe(200);
    const rule = (await created.json()) as { id: string };
    const replay = await request("/automations", "POST", "create-rule", draft);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(rule);
    expect(service.snapshot().automations).toHaveLength(1);
    expect(
      (await request(`/automations/${rule.id}`, "DELETE", "delete-rule", undefined)).status
    ).toBe(200);
    expect(
      (await request(`/automations/${rule.id}`, "DELETE", "delete-rule", undefined)).status
    ).toBe(200);
    expect((await request("/automations", "POST", "create-rule", draft)).status).toBe(200);
    expect(service.snapshot().automations).toHaveLength(0);
  } finally {
    await service.close();
    await context.close();
  }
});
