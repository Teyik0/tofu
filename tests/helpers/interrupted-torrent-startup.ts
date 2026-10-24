import assert from "node:assert/strict";
import { join } from "node:path";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import { createContext } from "elysia";
import { db } from "../../src/api/lib/db";
import { lifecyclePlugin } from "../../src/api/lib/lifecycle-plugin";

await using cleanup = new AsyncDisposableStack();
const { resources } = createContext(lifecyclePlugin).prototype;
cleanup.defer(() => db.$client.close());
cleanup.defer(() => resources.disposeAsync());
migrate(db, { migrationsFolder: join(import.meta.dir, "../../src/db/drizzle") });

const NativeWorker = globalThis.Worker;
cleanup.defer(() => {
  globalThis.Worker = NativeWorker;
});
let shutdown: Promise<void> | undefined;
// Trigger shutdown at the native boundary while the real worker is still starting.
globalThis.Worker = class extends NativeWorker {
  constructor(...args: ConstructorParameters<typeof NativeWorker>) {
    super(...args);
    queueMicrotask(() => {
      shutdown = resources.disposeAsync();
    });
  }
};

const [startup] = await Promise.allSettled([import("../../src/api/modules/torrents/plugin")]);
assert.ok(shutdown, "Startup must reach the native worker before shutdown");
await shutdown;
assert.equal(startup?.status, "rejected");
console.log("Interrupted torrent startup released its resources");
