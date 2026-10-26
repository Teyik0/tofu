import assert from "node:assert/strict";
import { ManagedRuntime } from "effect";
import { Database, databaseLayer } from "../../src/api/lib/db";
import { torrentRecords } from "../../src/db/schema";

const seedRuntime = ManagedRuntime.make(databaseLayer);
const db = await seedRuntime.runPromise(Database);
// Restoration reads this record after the worker has allocated its torrent client.
db.insert(torrentRecords)
  .values({ id: "a".repeat(40), value: "{" })
  .run();
await seedRuntime.dispose();

const [startup] = await Promise.allSettled([import("../../src/api/modules/torrents/plugin")]);
assert.equal(startup?.status, "rejected");
if (startup.status === "rejected") {
  assert.match(String(startup.reason), /JSON|Parse/i);
}
console.log("Failed torrent startup released its resources");
