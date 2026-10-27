import { Database } from "bun:sqlite";
import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { ManagedRuntime } from "effect";
import { databasePath } from "../../drizzle.config";
import { Database as ApplicationDatabase, databaseLayer } from "../../src/api/lib/db";
import { automationReleases } from "../../src/db/schema";

// Discovery restores this cache only after acquiring the database and torrent worker.
const seedRuntime = ManagedRuntime.make(databaseLayer);
const db = await seedRuntime.runPromise(ApplicationDatabase);
db.insert(automationReleases).values({ id: "failed-startup", value: "{" }).run();
await seedRuntime.dispose();

const close = spyOn(Database.prototype, "close");
const terminate = spyOn(Worker.prototype, "terminate");
using cleanup = new DisposableStack();
cleanup.defer(() => close.mockRestore());
cleanup.defer(() => terminate.mockRestore());

// Import failure must release resources without relying on process termination.
const [startup] = await Promise.allSettled([import("../../src/server")]);
assert.equal(startup?.status, "rejected");
if (startup.status === "rejected") {
  const diagnostic = inspect(startup.reason, { depth: null });
  assert.match(diagnostic, /SchemaError/);
  assert.match(diagnostic, /JSON|Parse/i);
  console.error(diagnostic);
}

const database = close.mock.contexts.find(
  (connection): connection is Database =>
    connection instanceof Database && connection.filename === databasePath
);
assert.ok(database, "Startup must acquire and close the application database");
assert.throws(() => database.query("SELECT 1").get());
assert.ok(terminate.mock.calls.length > 0, "Startup must terminate the acquired torrent worker");
console.log("Failed startup released the database and torrent worker");
