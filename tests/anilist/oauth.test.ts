import { expect, test } from "bun:test";
import { resolveAniListClient } from "../../src/api/modules/anilist/client";
import type { AniListState, AutomationState } from "../../src/types";
import { oauthFixture } from "../helpers/anilist/oauth";
import { expectSuccess } from "../helpers/problem";
import { json } from "../helpers/torrent";

test("AniList connects through a native callback without opening a local HTTP port", async () => {
  const context = await oauthFixture();
  try {
    const configured = await context.client.anilist.put({
      redirectUri: "tofu://oauth/anilist",
      userName: "",
    });
    expect(configured.status).toBe(200);
    const started = await context.client.anilist.connect.post({});
    expect(started.status).toBe(200);
    const authorize = new URL((expectSuccess(started) as { url: string }).url);
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
        expect((await context.client.anilist.callback.post({ url: invalid })).status).toBe(400);
      })
    );
    expect((await context.client.anilist.callback.post({ url: callback.href })).status).toBe(200);
    const state = expectSuccess(await context.client.anilist.get()) as AniListState;
    expect(state.connectedUser).toBe("ExampleUser");
    expect(state.entries).toHaveLength(1);
    expect(state.authorizationPending).toBe(false);
    expect(state.authenticated).toBe(true);
    expect(JSON.stringify(state)).not.toContain("account-token");
    expect((await context.client.anilist.callback.post({ url: callback.href })).status).toBe(400);
  } finally {
    await context.close();
  }
});
test("development uses a separate AniList client and never falls back to the production client", async () => {
  const context = await oauthFixture({ clientId: "", redirectUri: "tofu-dev://oauth/anilist" });
  try {
    const state = expectSuccess(await context.client.anilist.get()) as AniListState;
    expect(state.clientId).toBe("");
    expect(state.redirectUri).toBe("tofu-dev://oauth/anilist");
    expect((await context.client.anilist.connect.post({})).status).toBe(409);
    await context.restart();
    expect((await context.client.anilist.connect.post({})).status).toBe(409);
  } finally {
    await context.close();
  }
});
test("the production AniList client cannot authorize a development callback", async () => {
  const context = await oauthFixture({ clientId: "9037", redirectUri: "tofu-dev://oauth/anilist" });
  try {
    expect((await context.client.anilist.connect.post({})).status).toBe(409);
  } finally {
    await context.close();
  }
});
test("the built-in localhost callback migrates to the native callback while preserving the account name", async () => {
  const context = await oauthFixture();
  try {
    const saved = await context.client.anilist.put({
      redirectUri: "http://localhost:3000/",
      userName: "ExampleUser",
    });
    expect(saved.status).toBe(200);
    await context.restart();
    const state = expectSuccess(await context.client.anilist.get()) as AniListState;
    expect(state.redirectUri).toBe("tofu://oauth/anilist");
    expect(state.userName).toBe("ExampleUser");
  } finally {
    await context.close();
  }
});
test("native development authorization uses its own client and cancellation invalidates its callback", async () => {
  const context = await oauthFixture(resolveAniListClient("dev", undefined));
  try {
    const response = await context.client.anilist.connect.post({});
    expect(response.status).toBe(200);
    const authorize = new URL((expectSuccess(response) as { url: string }).url);
    expect(authorize.searchParams.get("client_id")).toBe("52735");
    const configuration = expectSuccess(await context.client.anilist.get()) as AniListState;
    expect(configuration.redirectUri).toBe("tofu-dev://oauth/anilist");
    const oauthState = authorize.searchParams.get("state");
    if (!oauthState) {
      throw new Error("Missing OAuth state");
    }
    const callback = `tofu-dev://oauth/anilist#${new URLSearchParams({ access_token: "account-token", state: oauthState })}`;
    await context.client.anilist.connect.delete({});
    expect((await context.client.anilist.callback.post({ url: callback })).status).toBe(400);
    const state = expectSuccess(await context.client.anilist.get()) as AniListState;
    expect(state.authenticated).toBe(false);
  } finally {
    await context.close();
  }
});
test("AniList connects with Tofu's client ID, verifies the token and loads the account without a client secret", async () => {
  const context = await oauthFixture(resolveAniListClient("release", "52735"));
  try {
    const initial = expectSuccess(await context.client.anilist.get()) as AniListState;
    expect(initial.clientId).toBe("9037");
    expect(initial.redirectUri).toBe("tofu://oauth/anilist");
    const configured = await context.client.anilist.put({
      redirectUri: context.callback,
      userName: "",
    });
    expect(configured.status).toBe(200);
    const started = await context.client.anilist.connect.post({});
    expect(started.status).toBe(200);
    const authorize = new URL((expectSuccess(started) as { url: string }).url);
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
    const connected = expectSuccess(await context.client.anilist.get()) as AniListState;
    expect(connected.connectedUser).toBe("ExampleUser");
    expect(connected.entries).toHaveLength(1);
    const state = expectSuccess(await context.client.automation.get()) as AutomationState;
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
    const restored = expectSuccess(await context.client.anilist.get()) as AniListState;
    expect(restored.authenticated).toBe(true);
    expect(restored.authorizationPending).toBe(false);
    expect((await context.client.anilist.list.post({})).status).toBe(200);
  } finally {
    await context.close();
  }
});
test("AniList rejects untrusted callbacks and invalid tokens without connecting the account", async () => {
  const context = await oauthFixture();
  try {
    await context.client.anilist.put({ redirectUri: context.callback, userName: "" });
    const started = await context.client.anilist.connect.post({});
    const authorize = new URL((expectSuccess(started) as { url: string }).url);
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
    const pending = expectSuccess(await context.client.anilist.get()) as AniListState;
    expect(pending.authorizationPending).toBe(true);
    expect(pending.authenticated).toBe(false);
    expect(
      (await send({ access_token: "invalid-token", state }, new URL(context.callback).origin))
        .status
    ).toBe(502);
    const rejected = expectSuccess(await context.client.anilist.get()) as AniListState;
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
    await context.client.anilist.put({ redirectUri: context.callback, userName: "" });
    const first = new URL(
      (expectSuccess(await context.client.anilist.connect.post({})) as { url: string }).url
    );
    const cancelled = expectSuccess(
      await context.client.anilist.connect.delete({})
    ) as AniListState;
    expect(cancelled.authorizationPending).toBe(false);
    const second = new URL(
      (expectSuccess(await context.client.anilist.connect.post({})) as { url: string }).url
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
    const declinedCallback = await send({
      error: "access_denied",
      state: second.searchParams.get("state"),
    });
    expect(declinedCallback.status).toBe(400);
    expect(await declinedCallback.json()).toMatchObject({
      detail: "AniList authorization was declined. Connect again when you are ready.",
    });
    const declined = expectSuccess(await context.client.anilist.get()) as AniListState;
    expect(declined.authenticated).toBe(false);
    expect(declined.authorizationPending).toBe(false);
    expect(declined.authorizationError).toContain("declined");
  } finally {
    await context.close();
  }
});
