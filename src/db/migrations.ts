import { sql } from "drizzle-orm";
import type { TofuDatabase } from "../api/lib/db";

export async function migrateLegacyTorrents(db: TofuDatabase, legacyPath: string) {
  migrateTorrentDatabase(db);
  const migrated = db.get<{ id: string }>(
    sql`SELECT id FROM tofu_migrations WHERE id = 'torrents-in-feeds'`
  );
  if (migrated) {
    return;
  }
  const legacyExists = await Bun.file(legacyPath).exists();
  if (legacyExists) {
    db.run(sql`ATTACH DATABASE ${legacyPath} AS legacy_torrents`);
  }
  try {
    db.transaction((tx) => {
      if (legacyExists) {
        const tables = tx.all<{ name: string }>(
          sql`SELECT name FROM legacy_torrents.sqlite_schema WHERE type = 'table'`
        );
        for (const table of ["config", "torrents"]) {
          if (tables.some(({ name }) => name === table)) {
            tx.run(sql`INSERT OR IGNORE INTO ${sql.identifier(table)}
              SELECT * FROM legacy_torrents.${sql.identifier(table)}`);
          }
        }
        if (tables.some(({ name }) => name === "destinations")) {
          const columns = tx.all<{ name: string }>(
            sql`PRAGMA legacy_torrents.table_info(destinations)`
          );
          const pinned = columns.some(({ name }) => name === "pinned") ? sql`pinned` : sql`0`;
          const icon = columns.some(({ name }) => name === "icon") ? sql`icon` : sql`'folder'`;
          tx.run(sql`INSERT OR IGNORE INTO destinations (id, name, downloadPath, pinned, icon)
            SELECT id, name, downloadPath, ${pinned}, ${icon} FROM legacy_torrents.destinations`);
        }
      }
      tx.run(sql`INSERT INTO tofu_migrations (id) VALUES ('torrents-in-feeds')`);
    });
  } finally {
    if (legacyExists) {
      db.run(sql`DETACH DATABASE legacy_torrents`);
    }
  }
}

// Move the legacy journal once; business writes and replay records must share one database.
export async function migrateSyncDatabase(db: TofuDatabase, legacyPath: string) {
  migrateSqliteSync(db.$client);
  db.run(sql`CREATE TABLE IF NOT EXISTS tofu_migrations (id TEXT PRIMARY KEY)`);
  const migrated = db.get<{ id: string }>(
    sql`SELECT id FROM tofu_migrations WHERE id = 'sync-in-feeds'`
  );
  if (migrated) {
    return;
  }
  const legacyExists = await Bun.file(legacyPath).exists();
  if (legacyExists) {
    db.run(sql`ATTACH DATABASE ${legacyPath} AS legacy_sync`);
  }
  try {
    db.transaction((tx) => {
      if (legacyExists) {
        const tables = tx.all<{ name: string }>(
          sql`SELECT name FROM legacy_sync.sqlite_schema WHERE type = 'table'`
        );
        for (const table of ["furin_sync_mutations", "furin_sync_streams", "furin_sync_changes"]) {
          if (tables.some(({ name }) => name === table)) {
            tx.run(sql`INSERT OR IGNORE INTO ${sql.identifier(table)}
              SELECT * FROM legacy_sync.${sql.identifier(table)}`);
          }
        }
      }
      tx.run(sql`INSERT INTO tofu_migrations (id) VALUES ('sync-in-feeds')`);
    });
  } finally {
    if (legacyExists) {
      db.run(sql`DETACH DATABASE legacy_sync`);
    }
  }
}

// Keep the existing files and table layouts; older installations have no migration journal.
export function migrateTorrentDatabase(db: TofuDatabase) {
  db.run(sql`PRAGMA journal_mode = WAL`);
  db.transaction((tx) => {
    tx.run(sql`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    tx.run(sql`CREATE TABLE IF NOT EXISTS torrents (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    tx.run(sql`CREATE TABLE IF NOT EXISTS destinations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, downloadPath TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0, icon TEXT NOT NULL DEFAULT 'folder'
    )`);
    const columns = tx.all<{ name: string }>(sql`PRAGMA table_info(destinations)`);
    if (!columns.some((column) => column.name === "pinned")) {
      tx.run(sql`ALTER TABLE destinations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
    }
    if (!columns.some((column) => column.name === "icon")) {
      tx.run(sql`ALTER TABLE destinations ADD COLUMN icon TEXT NOT NULL DEFAULT 'folder'`);
    }
  });
}

export function migrateAutomationDatabase(db: TofuDatabase) {
  db.run(sql`PRAGMA journal_mode = WAL`);
  db.transaction((tx) => {
    tx.run(sql`CREATE TABLE IF NOT EXISTS plugins (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    tx.run(sql`CREATE TABLE IF NOT EXISTS automations (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    tx.run(sql`CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    tx.run(sql`CREATE TABLE IF NOT EXISTS judgements (
      id TEXT PRIMARY KEY, value TEXT NOT NULL, createdAt INTEGER NOT NULL
    )`);
    tx.run(sql`CREATE TABLE IF NOT EXISTS releases (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    tx.run(sql`CREATE TABLE IF NOT EXISTS preferences (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    tx.run(sql`CREATE TABLE IF NOT EXISTS anilist (id TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  });
}

import { migrateSqliteSync } from "@teyik0/furin/sync/sqlite";
