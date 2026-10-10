import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { openDatabase } from "../src/api/lib/db";
import { sync } from "../src/sync";

export async function openTestDatabase(directory: string) {
  const db = await openDatabase(directory);
  return {
    close() {
      db.$client.close();
    },
    db,
    options: { ...sync, adapter: drizzleSyncAdapter({ db, namespace: "tofu" }), db },
  };
}

export type TestSyncOptions = Awaited<ReturnType<typeof openTestDatabase>>["options"];
