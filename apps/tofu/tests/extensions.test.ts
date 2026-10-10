import { expect, test } from "bun:test";
import { definePlugin } from "@tofu/plugins";
import type { PluginCore } from "@tofu/plugins/server";
import { Elysia } from "elysia";
import { Type } from "typebox";
import { createApi } from "../src/api";
import { fixture, json, waitFor } from "./helpers";

test("installed plugins retain settings and credentials across disable and restart without deleting real downloads", async () => {
  const context = await fixture(65_536, []);
  let disposed = 0;
  const load = (core: PluginCore) =>
    Promise.resolve([
      definePlugin({
        api: ({ settings, auth }) =>
          new Elysia({ name: "example" }).use(core).get("/state", ({ core: capabilities }) => ({
            connected: auth?.status().authenticated ?? false,
            count: capabilities.dashboard().torrents.length,
            settings: settings.get(),
          })),
        auth: { kind: "api-key", label: "Provider API key" },
        id: "example",
        name: "Example",
        settings: {
          defaults: { active: false, label: "Initial" },
          schema: Type.Object(
            { active: Type.Boolean(), label: Type.String() },
            { additionalProperties: false }
          ),
        },
        setup({ scope }) {
          scope.onDispose(() => {
            disposed += 1;
          });
        },
        ui: {
          pages: [
            {
              id: "library",
              path: "/untrusted-path",
              pinnable: true,
              route: () => null,
              title: "Example library",
            },
          ],
        },
        version: "0.0.0",
      }),
    ]);
  const open = () =>
    createApi(() => context.engine, context.sync.options, undefined, undefined, { load });
  let api = open();
  const request = (path: string, init?: RequestInit) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  try {
    const added = await request("/torrents", json({ paused: false, source: context.magnet }));
    expect(added.status).toBe(200);
    const { id } = (await added.json()) as { id: string };
    await waitFor(
      () => context.engine.file(id, 0).catch(() => null),
      (available) => available !== null
    );
    const file = await context.engine.file(id, 0);
    expect(new Uint8Array(await Bun.file(file.path).arrayBuffer())).toEqual(
      new Uint8Array(context.bytes)
    );
    expect((await request("/plugins/example/state")).status).toBe(200);
    expect(
      (
        await request("/extensions/example/settings", {
          ...json({ patch: { active: true, label: "Saved" } }),
          method: "PATCH",
        })
      ).status
    ).toBe(200);
    expect(
      (
        await request("/extensions/example/settings", {
          ...json({ patch: { active: "invalid" } }),
          method: "PATCH",
        })
      ).status
    ).toBe(400);
    expect(
      (
        await request("/extensions/example/settings", {
          ...json({ patch: { label: "Thread" }, threadId: "default" }),
          method: "PATCH",
        })
      ).status
    ).toBe(200);
    expect(
      (await request("/extensions/example/auth", json({ apiKey: "private-provider-key" }))).status
    ).toBe(200);
    expect(
      (await request("/extensions/example/pages/library", json({ pinned: true }))).status
    ).toBe(200);
    const state = await (await request("/extensions")).json();
    expect(JSON.stringify(state)).not.toContain("private-provider-key");
    expect(
      state.plugins.find((plugin: { id: string }) => plugin.id === "example").pages[0]
    ).toEqual({
      available: true,
      created: true,
      id: "library",
      path: "/extensions/example/library",
      pinnable: true,
      pinned: true,
      title: "Example library",
    });
    expect(
      (
        await request("/extensions/example/enabled", {
          ...json({ enabled: false }),
          method: "PATCH",
        })
      ).status
    ).toBe(200);
    expect(disposed).toBe(1);
    expect((await request("/plugins/example/state")).status).toBe(404);
    expect(await Bun.file(file.path).exists()).toBe(true);
    await api.closePlugins();
    api = open();
    expect((await request("/plugins/example/state")).status).toBe(404);
    expect(
      (
        await request("/extensions/example/enabled", {
          ...json({ enabled: true }),
          method: "PATCH",
        })
      ).status
    ).toBe(200);
    expect(await (await request("/plugins/example/state")).json()).toEqual({
      connected: true,
      count: 1,
      settings: { active: true, label: "Saved" },
    });
    const scoped = await (await request("/extensions?threadId=default")).json();
    expect(
      scoped.plugins.find((plugin: { id: string }) => plugin.id === "example").settings
    ).toEqual({ active: true, label: "Thread" });
    expect(await Bun.file(file.path).exists()).toBe(true);
  } finally {
    await api.closePlugins();
    await context.close();
  }
});

test("a failing plugin disposer still closes real transfer resources through ordered application shutdown", async () => {
  const context = await fixture(65_536, []);
  const { shutdownServices } = await import("../src/api/shutdown");
  const api = createApi(() => context.engine, context.sync.options, undefined, undefined, {
    load: () =>
      Promise.resolve([
        definePlugin({
          api: new Elysia().get("/status", () => "ready"),
          id: "faulty",
          name: "Faulty",
          setup({ scope }) {
            scope.onDispose(() => {
              throw new Error("Plugin cleanup failed");
            });
          },
          version: "0.0.0",
        }),
      ]),
  });
  try {
    const added = await api.handle(
      new Request("http://localhost/api/torrents", json({ paused: false, source: context.magnet }))
    );
    const { id } = (await added.json()) as { id: string };
    await waitFor(
      () => context.engine.file(id, 0).catch(() => null),
      (available) => available !== null
    );
    const file = await context.engine.file(id, 0);
    expect((await api.handle("http://localhost/api/plugins/faulty/status")).status).toBe(200);
    await expect(
      shutdownServices([() => api.closePlugins(), () => context.engine.close()])
    ).rejects.toThrow("Application shutdown failed");
    expect(context.engine.client.destroyed).toBe(true);
    expect(new Uint8Array(await Bun.file(file.path).arrayBuffer())).toEqual(
      new Uint8Array(context.bytes)
    );
  } finally {
    await context.close();
  }
});

test("plugin OAuth uses a scoped loopback callback and never requires the private desktop session cookie", async () => {
  const context = await fixture(1024, []);
  const provider = Bun.serve({
    fetch: () => Response.json({ access_token: "private-oauth-token", token_type: "Bearer" }),
    hostname: "127.0.0.1",
    port: 0,
  });
  const api = createApi(() => context.engine, context.sync.options, undefined, undefined, {
    load: () =>
      Promise.resolve([
        definePlugin({
          api: new Elysia().get("/status", () => "ready"),
          auth: {
            authorizationUrl: new URL("/authorize", provider.url).href,
            clientId: "public-client",
            kind: "oauth2",
            pkce: true,
            scopes: [],
            tokenUrl: new URL("/token", provider.url).href,
          },
          id: "oauth-example",
          name: "OAuth example",
          version: "0.0.0",
        }),
      ]),
  });
  try {
    const started = await api.handle(
      new Request("http://localhost/api/extensions/oauth-example/auth", json({}))
    );
    expect(started.status).toBe(200);
    const { url } = (await started.json()) as { url: string };
    const authorization = new URL(url);
    const redirectUri = authorization.searchParams.get("redirect_uri");
    const oauthState = authorization.searchParams.get("state");
    if (!(redirectUri && oauthState)) {
      throw new Error("OAuth authorization URL is missing its callback or state");
    }
    const callback = new URL(redirectUri);
    expect(callback.origin).not.toBe("http://localhost");
    callback.searchParams.set("code", "provider-code");
    callback.searchParams.set("state", oauthState);
    const response = await fetch(callback, {
      headers: {
        referer: new URL("/authorize", provider.url).href,
        "sec-fetch-site": "cross-site",
      },
    });
    expect(response.status).toBe(200);
    expect((await fetch(callback)).status).toBe(400);
    const state = await (await api.handle("http://localhost/api/extensions")).text();
    expect(state).toContain('"connected":true');
    expect(state).not.toContain("private-oauth-token");
    await api.handle(
      new Request("http://localhost/api/extensions/oauth-example/enabled", {
        ...json({ enabled: false }),
        method: "PATCH",
      })
    );
    await expect(fetch(callback)).rejects.toThrow();
  } finally {
    await api.closePlugins();
    provider.stop(true);
    await context.close();
  }
});

test("a plugin startup failure leaves healthy plugins and management available for recovery", async () => {
  const context = await fixture(1024, []);
  let fail = true;
  const api = createApi(() => context.engine, context.sync.options, undefined, undefined, {
    load: () =>
      Promise.resolve([
        definePlugin({
          api: new Elysia().get("/status", () => "ready"),
          id: "healthy",
          name: "Healthy",
          version: "0.0.0",
        }),
        definePlugin({
          api: new Elysia().get("/status", () => "ready"),
          id: "recoverable",
          name: "Recoverable",
          setup() {
            if (fail) {
              throw new Error("private-internal-failure");
            }
          },
          version: "0.0.0",
        }),
      ]),
  });
  try {
    expect((await api.handle("http://localhost/api/plugins/healthy/status")).status).toBe(200);
    const state = await api.handle("http://localhost/api/extensions");
    expect(state.status).toBe(200);
    const body = await state.text();
    expect(body).toContain("Plugin startup failed");
    expect(body).not.toContain("private-internal-failure");
    expect((await api.handle("http://localhost/api/plugins/recoverable/status")).status).toBe(404);
    expect(
      (
        await api.handle(
          new Request("http://localhost/api/extensions/recoverable/enabled", {
            ...json({ enabled: false }),
            method: "PATCH",
          })
        )
      ).status
    ).toBe(200);
    fail = false;
    expect(
      (
        await api.handle(
          new Request("http://localhost/api/extensions/recoverable/enabled", {
            ...json({ enabled: true }),
            method: "PATCH",
          })
        )
      ).status
    ).toBe(200);
    expect((await api.handle("http://localhost/api/plugins/recoverable/status")).status).toBe(200);
  } finally {
    await api.closePlugins();
    await context.close();
  }
});
