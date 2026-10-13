import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";

// Both a host database and its active transaction satisfy this small SQL port.
export type DatabaseConnection = Pick<BunSQLiteDatabase, "select" | "insert" | "update" | "delete">;

export const anilistState = sqliteTable("anilist", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export type TofuDatabase = DatabaseConnection & {
  transaction: <T>(task: (transaction: DatabaseConnection) => T) => T;
};
