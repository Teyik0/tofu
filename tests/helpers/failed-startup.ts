import { Database } from "bun:sqlite";
import { spyOn } from "bun:test";
import assert from "node:assert/strict";
import { inspect } from "node:util";
import { databasePath } from "../../drizzle.config";

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
  assert.match(diagnostic, /SyntaxError/);
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
