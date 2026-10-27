import assert from "node:assert/strict";
import { Layer, ManagedRuntime } from "effect";
import { databaseLayer } from "../../src/api/lib/db";
import { TorrentClient, torrentClientLayer } from "../../src/api/modules/torrents/layer";

await using cleanup = new AsyncDisposableStack();
const runtime = cleanup.use(
  ManagedRuntime.make(torrentClientLayer.pipe(Layer.provide(databaseLayer)))
);

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
      shutdown = runtime.dispose();
    });
  }
};

const [startup] = await Promise.allSettled([runtime.runPromise(TorrentClient)]);
assert.ok(shutdown, "Startup must reach the native worker before shutdown");
await shutdown;
assert.equal(startup?.status, "rejected");
console.log("Interrupted torrent startup released its resources");
