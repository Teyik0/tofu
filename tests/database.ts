import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { openDatabase } from "../src/api/lib/db";
import { sync } from "../src/sync";

export async function openTestDatabase(directory: string) {
  const db = await openDatabase(directory);
  const resources = new AsyncDisposableStack();
  resources.defer(() => db.$client.close(true));
  return {
    close: () => resources.disposeAsync(),
    db,
    options: {
      ...sync,
      adapter: drizzleSyncAdapter({ db, namespace: "tofu" }),
      db,
      directory,
      resources,
    },
  };
}

export type TestSyncOptions = Awaited<ReturnType<typeof openTestDatabase>>["options"];
