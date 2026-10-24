import assert from "node:assert/strict";
import { treaty } from "@elysia/eden";
import { furin } from "@teyik0/furin";
import { Elysia } from "elysia";
import { initLogger, toLoggerConfig, toMiddlewareOptions } from "evlog";
import { config } from "../../evlog.config";
import { closeResources } from "../../src/api/lib/lifecycle-plugin";

await using resources = new AsyncDisposableStack();
resources.defer(closeResources);
initLogger(toLoggerConfig(config));

const { apiPlugin } = await import("../../src/api");
await apiPlugin.modules;
const direct = treaty(apiPlugin).api;
const [health, missing] = await Promise.all([
  direct.health.get(),
  direct.torrents({ id: "missing-torrent" }).get(),
]);
assert.equal(health.status, 200);
assert.equal(health.data?.ready, true);
assert.equal(missing.status, 404);

const invalid = await direct.auth.pair.post({
  kind: "desktop",
  label: "",
  nonce: "test-request-nonce-123456",
  secret: "private-logging-test-secret",
});
assert.equal(invalid.status, 422);

const { sync } = await import("../../src/sync");
const app = new Elysia().use(apiPlugin).use(
  await furin({
    logger: { ...toMiddlewareOptions(config), exclude: ["/api/**"], include: ["/**"] },
    pagesDir: "./src/pages",
    sync,
  })
);
await app.modules;
app.listen({ hostname: "127.0.0.1", port: 0 });
resources.defer(async () => {
  await app.stop(true);
});
assert.ok(app.server);
const network = treaty<typeof apiPlugin>(app.server.url.href);
assert.equal((await network.api.health.get()).status, 200);
assert.equal((await network[".well-known"].tofu.get()).status, 200);
const page = await fetch(new URL("/missing-logging-page", app.server.url));
assert.equal(page.status, 404);
assert.ok(!(await page.text()).includes("outside of an evlog plugin context"));

const { logs } = await import("../../src/api/lib/database-plugin");
await logs.flush();
console.log("API request logging verified through direct Eden and HTTP");
