import { join, resolve } from "node:path";
import { defineConfig } from "drizzle-kit";
import { instance } from "@/api/lib/instance";

export const databasePath = resolve(
  process.env.DATABASE_URL ?? join(instance.dataDir, "tofu.sqlite")
);

export default defineConfig({
  dbCredentials: {
    url: databasePath,
  },
  dialect: "sqlite",
  out: "./src/db/drizzle",
  schema: "./src/db/schema.ts",
  tablesFilter: ["!furin_sync_*"],
});
