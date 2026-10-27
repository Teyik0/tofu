import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { defaultAutomationPreferences } from "../../../../package/plugins/src/automation-rules";

export async function seedLegacyJev(directory: string) {
  await mkdir(join(directory, "state"), { recursive: true });
  using db = new Database(join(directory, "state/tofu.sqlite"));
  const migrations = readMigrationFiles({
    migrationsFolder: join(import.meta.dir, "../../src/db/drizzle"),
  });
  migrate(drizzle({ client: db }), {
    migrationsJournal: migrations
      .filter((migration) => migration.name !== "20261026165938_remove_jev")
      .map((migration) => ({
        name: migration.name,
        sql: migration.sql.join("--> statement-breakpoint"),
        timestamp: migration.folderMillis,
      })),
  });
  const template = {
    ...defaultAutomationPreferences,
    destinationId: "default",
    enabled: false,
    includeExisting: true,
    matchMode: "jev",
    query: "Example",
    season: null,
    title: "Example",
  };
  db.run("INSERT INTO plugins (id, value) VALUES (?, ?)", [
    "jev",
    JSON.stringify({ apiKey: "legacy-key", enabled: true }),
  ]);
  db.run("INSERT INTO judgements (id, createdAt, value) VALUES (?, ?, ?)", [
    "legacy-evaluation",
    Date.now(),
    "{}",
  ]);
  db.run("INSERT INTO automations (id, value) VALUES (?, ?)", [
    "legacy-rule",
    JSON.stringify({
      ...template,
      createdAt: Date.now(),
      error: null,
      id: "legacy-rule",
      lastRunAt: null,
      nextRunAt: null,
      revision: 1,
      status: "paused",
    }),
  ]);
  db.run("INSERT INTO anilist (id, value) VALUES (?, ?)", [
    "legacy-subscription",
    JSON.stringify({
      bindings: [],
      enabled: false,
      error: null,
      id: "legacy-subscription",
      intervalMinutes: 15,
      lastSyncAt: null,
      nextSyncAt: null,
      statuses: ["CURRENT"],
      template,
    }),
  ]);
}
