import assert from "node:assert/strict";

// Import failure must release resources without relying on process termination.
const [startup] = await Promise.allSettled([import("../../src/server")]);
assert.equal(startup?.status, "rejected");
if (startup.status === "rejected") {
  assert.match(String(startup.reason), /JSON|Parse/i);
}

const { db } = await import("../../src/api/lib/db");
assert.throws(() => db.$client.query("SELECT 1").get());
console.log("Failed startup released the database");
