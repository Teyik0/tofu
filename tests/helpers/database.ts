import { mkdir } from "node:fs/promises";
import { drizzleSyncAdapter } from "@teyik0/furin/sync/drizzle";
import { openDatabase } from "../../src/api/lib/db";
import { lockDataDirectory } from "../../src/api/lib/instance-lock";
export async function openTestDatabase(directory: string) {
  const resources = new AsyncDisposableStack();
  try {
    await mkdir(directory, { recursive: true });
    const lock = await lockDataDirectory(directory);
    // The API and fixture cleanup share ownership of the same native lock.
    const lease = new AsyncDisposableStack();
    lease.defer(lock.close.bind(lock));
    resources.defer(lease.disposeAsync.bind(lease));
    const db = await openDatabase(directory);
    resources.defer(db.$client.close.bind(db.$client, true));
    return {
      close: resources.disposeAsync.bind(resources),
      db,
      options: {
        adapter: drizzleSyncAdapter({ db, namespace: "tofu" }),
        db,
        directory,
        lease: { close: lease.disposeAsync.bind(lease) },
        principal: () => "local",
        resources,
      },
    };
  } catch (error) {
    await resources.disposeAsync();
    throw error;
  }
}
export type TestSyncOptions = Awaited<ReturnType<typeof openTestDatabase>>["options"];
