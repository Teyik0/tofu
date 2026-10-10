import { expect, test } from "bun:test";
import { join } from "node:path";
import { resolveAniListClient } from "../src/api/modules/anilist/client";
import { AutomationService } from "../src/api/modules/automation/service";
import { DesktopUrlOpener } from "../src/api/modules/desktop/opening";
import type { AniListClient, AniListState, AutomationState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, json } from "./helpers";

async function oauthFixture(client?: AniListClient) {
  const context = await fixture(1024, []);
  const provider = Bun.serve({
    async fetch(incoming) {
      const body = (await incoming.json()) as { query: string };
      if (incoming.headers.get("authorization") !== "Bearer account-token") {
        return Response.json({ errors: [{ message: "Invalid token" }] }, { status: 401 });
      }
      return Response.json({
        data: body.query.includes("Viewer")
          ? { Viewer: { id: 42, name: "ExampleUser" } }
          : {
              MediaListCollection: {
                hasNextChunk: false,
                lists: [
                  {
                    entries: [
                      {
                        media: { id: 10, synonyms: [], title: { romaji: "Example" } },
                        progress: 1,
                        status: "CURRENT",
                      },
                    ],
                  },
                ],
              },
            },
      });
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const reserved = Bun.serve({ fetch: () => new Response(), hostname: "127.0.0.1", port: 0 });
  const callback = `http://127.0.0.1:${reserved.port}/callback`;
  reserved.stop(true);
  const base = `http://127.0.0.1:${provider.port}`;
  const options = {
    anilistClient: client,
    dataDir: join(context.directory, "feeds"),
    endpoints: { anilist: base, c411: base, jev: base, nyaa: base, tsundere: base },
    engine: () => context.engine,
    now: Date.now,
  };
  let service = await AutomationService.open(options);
  const opening = new DesktopUrlOpener({
    authorize: (url) => service.anilist.receiveAuthorizationUrl(url),
    engine: () => context.engine,
    show: () => undefined,
  });
  opening.ready();
  let api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const request = (path: string, init: RequestInit | undefined) =>
    api.handle(new Request(`http://localhost/api${path}`, init));
  return {
    callback,
    async close() {
      await service.close();
      provider.stop(true);
      await context.close();
    },
    opening,
    request,
    async restart() {
      await service.close();
      service = await AutomationService.open(options);
      api = await createTestApi(
        () => context.engine,
        context.sync.options,
        () => service
      );
    },
  };
}

test("AniList connects through a native callback without opening a local HTTP port", async () => {
  const context = await oauthFixture();
  try {
    const configured = await context.request("/anilist", {
      ...json({ redirectUri: "tofu://oauth/anilist", userName: "" }),
      method: "PUT",
    });
    expect(configured.status).toBe(200);
    const started = await context.request("/anilist/connect", json({}));
    expect(started.status).toBe(200);
    const authorize = new URL(((await started.json()) as { url: string }).url);
    const oauthState = authorize.searchParams.get("state");
    if (!oauthState) {
      throw new Error("Missing OAuth state");
    }
    const callback = new URL("tofu://oauth/anilist");
    callback.hash = new URLSearchParams({
      access_token: "account-token",
      state: oauthState,
    }).toString();
    await Promise.all(
      [
        callback.href.replace("tofu:", "tofu-dev:"),
        callback.href.replace("/anilist", "/other"),
        callback.href.replace(oauthState, "wrong-state"),
      ].map(async (invalid) => {
        expect((await context.request("/anilist/callback", json({ url: invalid }))).status).toBe(
          400
        );
      })
    );
    await context.opening.open(callback.href);
    const state = (await (await context.request("/anilist", undefined)).json()) as AniListState;
    expect(state.connectedUser).toBe("ExampleUser");
    expect(state.entries).toHaveLength(1);
    expect(state.authorizationPending).toBe(false);
    expect(state.authenticated).toBe(true);
    expect(JSON.stringify(state)).not.toContain("account-token");
    expect((await context.request("/anilist/callback", json({ url: callback.href }))).status).toBe(
      400
    );
  } finally {
    await context.close();
  }
});

test("development uses a separate AniList client and never falls back to the production client", async () => {
  const context = await oauthFixture({ clientId: "", redirectUri: "tofu-dev://oauth/anilist" });
  try {
    const state = (await (await context.request("/anilist", undefined)).json()) as AniListState;
    expect(state.clientId).toBe("");
    expect(state.redirectUri).toBe("tofu-dev://oauth/anilist");
    expect((await context.request("/anilist/connect", json({}))).status).toBe(409);
    await context.restart();
    expect((await context.request("/anilist/connect", json({}))).status).toBe(409);
  } finally {
    await context.close();
  }
});

test("the production AniList client cannot authorize a development callback", async () => {
  const context = await oauthFixture({ clientId: "9037", redirectUri: "tofu-dev://oauth/anilist" });
  try {
    expect((await context.request("/anilist/connect", json({}))).status).toBe(409);
  } finally {
    await context.close();
  }
});

test("the built-in localhost callback migrates to the native callback while preserving the account name", async () => {
  const context = await oauthFixture();
  try {
    const saved = await context.request("/anilist", {
      ...json({ redirectUri: "http://localhost:3000/", userName: "ExampleUser" }),
      method: "PUT",
    });
    expect(saved.status).toBe(200);
    await context.restart();
    const state = (await (await context.request("/anilist", undefined)).json()) as AniListState;
    expect(state.redirectUri).toBe("tofu://oauth/anilist");
    expect(state.userName).toBe("ExampleUser");
  } finally {
    await context.close();
  }
});

test("native development authorization uses its own client and cancellation invalidates its callback", async () => {
  const context = await oauthFixture(resolveAniListClient("dev", undefined));
  try {
    const response = await context.request("/anilist/connect", json({}));
    expect(response.status).toBe(200);
    const authorize = new URL(((await response.json()) as { url: string }).url);
    expect(authorize.searchParams.get("client_id")).toBe("52735");
    const configuration = (await (
      await context.request("/anilist", undefined)
    ).json()) as AniListState;
    expect(configuration.redirectUri).toBe("tofu-dev://oauth/anilist");
    const oauthState = authorize.searchParams.get("state");
    if (!oauthState) {
      throw new Error("Missing OAuth state");
    }
    const callback = `tofu-dev://oauth/anilist#${new URLSearchParams({ access_token: "account-token", state: oauthState })}`;
    await context.request("/anilist/connect", { method: "DELETE" });
    expect((await context.request("/anilist/callback", json({ url: callback }))).status).toBe(400);
    const state = (await (await context.request("/anilist", undefined)).json()) as AniListState;
    expect(state.authenticated).toBe(false);
  } finally {
    await context.close();
  }
});

test("AniList connects with Tofu's client ID, verifies the token and loads the account without a client secret", async () => {
  const context = await oauthFixture(resolveAniListClient("release", "52735"));
  try {
    const initial = (await (await context.request("/anilist", undefined)).json()) as AniListState;
    expect(initial.clientId).toBe("9037");
    expect(initial.redirectUri).toBe("tofu://oauth/anilist");
    const configured = await context.request("/anilist", {
      ...json({ redirectUri: context.callback, userName: "" }),
      method: "PUT",
    });
    expect(configured.status).toBe(200);
    const started = await context.request("/anilist/connect", json({}));
    expect(started.status).toBe(200);
    const authorize = new URL(((await started.json()) as { url: string }).url);
    expect(authorize.searchParams.get("client_id")).toBe("9037");
    expect(authorize.searchParams.get("response_type")).toBe("token");
    expect(authorize.searchParams.get("redirect_uri")).toBeNull();
    expect(authorize.searchParams.get("client_secret")).toBeNull();
    const page = await fetch(context.callback);
    expect(page.status).toBe(200);
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(await page.text()).toContain("location.hash");
    const completed = await fetch(context.callback, {
      ...json({ access_token: "account-token", state: authorize.searchParams.get("state") }),
      headers: { "content-type": "application/json", origin: new URL(context.callback).origin },
    });
    expect(completed.status).toBe(200);
    const connected = (await (await context.request("/anilist", undefined)).json()) as AniListState;
    expect(connected.connectedUser).toBe("ExampleUser");
    expect(connected.entries).toHaveLength(1);
    const state = (await (
      await context.request("/automation", undefined)
    ).json()) as AutomationState;
    expect(state.plugins.find((plugin) => plugin.id === "anilist")).toMatchObject({
      enabled: true,
      hasApiKey: true,
    });
    expect(JSON.stringify({ connected, state })).not.toContain("account-token");
    expect(connected.authorizationPending).toBe(false);
    const replay = await fetch(context.callback, {
      ...json({ access_token: "account-token", state: authorize.searchParams.get("state") }),
      headers: { "content-type": "application/json", origin: new URL(context.callback).origin },
    });
    expect(replay.status).toBe(400);
    await context.restart();
    const restored = (await (await context.request("/anilist", undefined)).json()) as AniListState;
    expect(restored.authenticated).toBe(true);
    expect(restored.authorizationPending).toBe(false);
    expect((await context.request("/anilist/list", json({}))).status).toBe(200);
  } finally {
    await context.close();
  }
});

test("AniList rejects untrusted callbacks and invalid tokens without connecting the account", async () => {
  const context = await oauthFixture();
  try {
    await context.request("/anilist", {
      ...json({ redirectUri: context.callback, userName: "" }),
      method: "PUT",
    });
    const started = await context.request("/anilist/connect", json({}));
    const authorize = new URL(((await started.json()) as { url: string }).url);
    const state = authorize.searchParams.get("state");
    const send = (body: object, origin: string) =>
      fetch(context.callback, {
        ...json(body),
        headers: { "content-type": "application/json", origin },
      });
    expect(
      (await send({ access_token: "account-token", state }, "https://example.com")).status
    ).toBe(403);
    expect(
      (
        await send(
          { access_token: "account-token", state: "wrong" },
          new URL(context.callback).origin
        )
      ).status
    ).toBe(400);
    const pending = (await (await context.request("/anilist", undefined)).json()) as AniListState;
    expect(pending.authorizationPending).toBe(true);
    expect(pending.authenticated).toBe(false);
    expect(
      (await send({ access_token: "invalid-token", state }, new URL(context.callback).origin))
        .status
    ).toBe(502);
    const rejected = (await (await context.request("/anilist", undefined)).json()) as AniListState;
    expect(rejected.authenticated).toBe(false);
    expect(rejected.connectedUser).toBeNull();
    expect(rejected.authorizationPending).toBe(false);
    expect(rejected.authorizationError).toBeTruthy();
    expect(
      (await send({ access_token: "account-token", state }, new URL(context.callback).origin))
        .status
    ).toBe(400);
  } finally {
    await context.close();
  }
});

test("AniList cancellation releases the callback port and rejects the previous authorization after reconnecting", async () => {
  const context = await oauthFixture();
  try {
    await context.request("/anilist", {
      ...json({ redirectUri: context.callback, userName: "" }),
      method: "PUT",
    });
    const first = new URL(
      ((await (await context.request("/anilist/connect", json({}))).json()) as { url: string }).url
    );
    const cancelled = (await (
      await context.request("/anilist/connect", { method: "DELETE" })
    ).json()) as AniListState;
    expect(cancelled.authorizationPending).toBe(false);
    const second = new URL(
      ((await (await context.request("/anilist/connect", json({}))).json()) as { url: string }).url
    );
    expect(first.searchParams.get("state")).not.toBe(second.searchParams.get("state"));
    const send = (body: object) =>
      fetch(context.callback, {
        ...json(body),
        headers: { "content-type": "application/json", origin: new URL(context.callback).origin },
      });
    expect(
      (await send({ access_token: "account-token", state: first.searchParams.get("state") })).status
    ).toBe(400);
    expect(
      (await send({ error: "access_denied", state: second.searchParams.get("state") })).status
    ).toBe(400);
    const declined = (await (await context.request("/anilist", undefined)).json()) as AniListState;
    expect(declined.authenticated).toBe(false);
    expect(declined.authorizationPending).toBe(false);
    expect(declined.authorizationError).toContain("declined");
  } finally {
    await context.close();
  }
});
