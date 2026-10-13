import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Destination } from "../types";

export const torrentConfig = sqliteTable("config", {
  key: text().primaryKey(),
  value: text().notNull(),
});

export const torrentRecords = sqliteTable("torrents", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const torrentDestinations = sqliteTable("destinations", {
  downloadPath: text().notNull(),
  icon: text().$type<Destination["icon"]>().notNull().default("folder"),
  id: text().primaryKey(),
  name: text().notNull(),
  pinned: integer({ mode: "boolean" }).notNull().default(false),
});

export const automationPlugins = sqliteTable("plugins", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const automationRules = sqliteTable("automations", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const automationDecisions = sqliteTable("decisions", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const automationJudgements = sqliteTable("judgements", {
  createdAt: integer().notNull(),
  id: text().primaryKey(),
  value: text().notNull(),
});

export const automationReleases = sqliteTable("releases", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const automationPreferences = sqliteTable("preferences", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const anilistState = sqliteTable("anilist", {
  id: text().primaryKey(),
  value: text().notNull(),
});

export const schema = {
  anilistState,
  automationDecisions,
  automationJudgements,
  automationPlugins,
  automationPreferences,
  automationReleases,
  automationRules,
  torrentConfig,
  torrentDestinations,
  torrentRecords,
};
