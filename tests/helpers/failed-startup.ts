import assert from "node:assert/strict";
import { lockDataDirectory } from "../../src/api/lib/instance-lock";

// Import failure must release resources without relying on process termination.
const [startup] = await Promise.allSettled([import("../../src/server")]);
assert.equal(startup?.status, "rejected");
if (startup.status === "rejected") {
  assert.match(String(startup.reason), /JSON|Parse/i);
}

const { db, instance } = await import("../../src/api/lib/database-plugin");
assert.throws(() => db.$client.query("SELECT 1").get());
using cleanup = new DisposableStack();
const lease = await lockDataDirectory(instance.dataDir);
cleanup.defer(lease.close.bind(lease));
console.log("Failed startup released the database and instance lock");
