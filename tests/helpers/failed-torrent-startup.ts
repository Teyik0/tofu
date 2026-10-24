import assert from "node:assert/strict";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createContext } from "elysia";
import { db } from "../../src/api/lib/db";
import { lifecyclePlugin } from "../../src/api/lib/lifecycle-plugin";
import { torrentRecords } from "../../src/db/schema";

await using cleanup = new AsyncDisposableStack();
const { resources } = createContext(lifecyclePlugin).prototype;
cleanup.defer(() => db.$client.close());
cleanup.defer(() => resources.disposeAsync());
migrate(db, { migrationsFolder: join(import.meta.dir, "../../src/db/drizzle") });
// Restoration reads this record after the worker has allocated its torrent client.
db.insert(torrentRecords)
  .values({ id: "a".repeat(40), value: "{" })
  .run();

const [startup] = await Promise.allSettled([import("../../src/api/modules/torrents/plugin")]);
assert.equal(startup?.status, "rejected");
if (startup.status === "rejected") {
  assert.match(String(startup.reason), /JSON|Parse/i);
}
console.log("Failed torrent startup released its resources");
