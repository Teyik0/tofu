import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// Furin owns these tables; only the column needed by the startup check is declared here.
export const furinSyncSchema = {
  changes: sqliteTable("furin_sync_changes", {
    namespace: text().notNull(),
  }),
  mutations: sqliteTable("furin_sync_mutations", {
    namespace: text().notNull(),
  }),
  streams: sqliteTable("furin_sync_streams", {
    namespace: text().notNull(),
  }),
};
