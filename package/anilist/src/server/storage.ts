import { sqliteTable, text } from "drizzle-orm/sqlite-core";

export type TofuDatabase = ReturnType<typeof import("drizzle-orm/bun-sqlite").drizzle>;
export type DatabaseTransaction = Parameters<Parameters<TofuDatabase["transaction"]>[0]>[0];
export type DatabaseConnection = TofuDatabase | DatabaseTransaction;

export const anilistState = sqliteTable("anilist", {
  id: text().primaryKey(),
  value: text().notNull(),
});
