import { expect, test } from "bun:test";
import { join } from "node:path";
import { createClient } from "@teyik0/furin/client";
import { createBaseContext, Elysia } from "elysia";
import { apiPlugin } from "../src/api";
import { ApplicationHost } from "../src/api/lib/application-host";
import { assertApplicationReady } from "../src/api/lib/lifecycle";
import { ApiRequestError, readData } from "../src/lib/api-data";
import type { DashboardState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json, waitFor } from "./helpers";

test("the API does not report readiness before the application has started", async () => {
  const app = new Elysia().use(apiPlugin);
  const response = await app.handle("http://localhost/api/health");
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Tofu is temporarily unavailable" });
});

test("requests are refused during shutdown and receive the new engine after restart", async () => {
  const first = await fixture(65_536, []);
  const second = await fixture(4096, []);
  const firstHost = new (createBaseContext(first.api))().store.applicationHost;
  const secondHost = new (createBaseContext(second.api))().store.applicationHost;
  const firstCore = await firstHost.core;
  const secondCore = await secondHost.core;
  const closing = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const host = new ApplicationHost();
  const core = {
    ...firstCore,
    async close() {
      closing.resolve();
      await release.promise;
      await firstCore.close();
      await first.engine.close();
    },
  };
  const app = new Elysia().use(apiPlugin).state((store) => ({ ...store, applicationHost: host }));
  try {
    await host.prepare(() => Promise.resolve(core), new AbortController().signal);
    host.activate(core, { kind: "server" });
    const added = await app.handle(
      new Request("http://localhost/api/torrents", json({ paused: false, source: first.magnet }))
    );
    expect(added.status).toBe(200);
    const { id } = await added.json();
    const completed = await waitFor(
      async () => first.engine.detail(id),
      (torrent) => torrent.status === "seeding"
    );
    const stopping = host.stop();
    await closing.promise;
    expect((await app.handle("http://localhost/api/health")).status).toBe(503);
    expect(
      (await app.handle(new Request(`http://localhost/api/torrents/${id}/pause`, json({})))).status
    ).toBe(503);
    release.resolve();
    await stopping;
    expect((await app.handle("http://localhost/api/health")).status).toBe(503);
    await host.prepare(() => Promise.resolve(secondCore), new AbortController().signal);
    host.activate(secondCore, { kind: "server" });
    const response = await app.handle("http://localhost/api/state?detail=false");
    const dashboard: DashboardState = await response.json();
    expect(response.status).toBe(200);
    expect(dashboard.settings.downloadPath).toBe(second.engine.settings.downloadPath);
    expect(dashboard.torrents).toEqual([]);
    expect(await Bun.file(join(completed.savePath, first.seed.name)).bytes()).toEqual(first.bytes);
  } finally {
    release.resolve();
    await host.stop();
    await Promise.all([first.close(), second.close()]);
  }
});

test("failed startup never publishes an application or successful health response", async () => {
  const context = await fixture(4096, []);
  const host = new ApplicationHost();
  const core = await new (createBaseContext(context.api))().store.applicationHost.core;
  const app = new Elysia().use(apiPlugin).state((store) => ({ ...store, applicationHost: host }));
  try {
    await context.engine.close();
    await expect(
      host.prepare(async () => {
        await assertApplicationReady(core);
        return core;
      }, new AbortController().signal)
    ).rejects.toThrow();
    const response = await app.handle("http://localhost/api/health");
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "Tofu is temporarily unavailable" });
  } finally {
    await host.stop();
    await context.close();
  }
});

test("the typed client keeps API failures outside success data and preserves their HTTP status", async () => {
  const context = await fixture(4096, []);
  const client = createClient(await createTestApi(() => context.engine, context.sync.options)).api;
  try {
    const result = await client.state.get({ query: { detail: "false" } });
    const dashboard: DashboardState = readData(result);
    expect(dashboard.settings).toEqual(context.engine.settings);
    const missing = await client.torrents({ id: "missing" }).get();
    expect(missing.data).toBeNull();
    expect(missing.error?.status).toBe(404);
    try {
      readData(missing);
      throw new Error("The missing torrent was treated as successful data");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiRequestError);
      expect(error).toHaveProperty("status", 404);
    }
  } finally {
    await context.close();
  }
});
