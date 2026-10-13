import { expect, test } from "bun:test";
import { join } from "node:path";
import { treaty } from "@elysia/eden";
import { pluginEndpoints } from "../src/api/modules/plugins/service";
import type { AutomationState } from "../src/types";
import { createTestApi } from "./helpers/application";
import { credentialsFixture } from "./helpers/credentials";
import { expectProblem, expectSuccess } from "./helpers/problem";
import { openTestServices } from "./helpers/services";
import { fixture } from "./helpers/torrent";

function connectedJev() {
  return Response.json({
    answers: { connected: { noul: 1, type: "noul" } },
    model: "jev-latest",
    usage: { input_tokens: 10, output_tokens: 1 },
  });
}
test("C411 validates a pasted Torznab link and saves only its key without enabling the plugin", async () => {
  const context = await fixture(1024, []);
  const received: URL[] = [];
  const upstream = Bun.serve({
    fetch(request) {
      received.push(new URL(request.url));
      return new Response("<rss><channel></channel></rss>");
    },
    hostname: "127.0.0.1",
    port: 0,
  });
  const service = await openTestServices({
    dataDir: join(context.directory, "feeds"),
    endpoints: { ...pluginEndpoints, c411: upstream.url.href },
    engine: () => context.engine,
    now: Date.now,
  });
  const api = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const client = treaty(api).api;
  try {
    const response = await client.plugins({ id: "c411" }).connect.post({
      apiKey: " https://c411.org/api/torznab?apikey=personal%2Bkey&t=search&cat=5070 ",
      enabled: false,
    });
    expect(response.status).toBe(200);
    const state = expectSuccess(response) as AutomationState;
    expect(state.plugins.find((plugin) => plugin.id === "c411")).toMatchObject({
      enabled: false,
      error: null,
      hasApiKey: true,
    });
    expect(state.plugins.find((plugin) => plugin.id === "c411")?.checkedAt).toBeNumber();
    expect(JSON.stringify(state)).not.toContain("personal+key");
    expect(received).toHaveLength(1);
    expect(received[0]?.searchParams.get("apikey")).toBe("personal+key");
    expect(received[0]?.searchParams.get("limit")).toBe("1");
    await client.plugins({ id: "c411" }).put({ enabled: true });
    const checked = await client.plugins({ id: "c411" }).test.post({});
    expect(checked.status).toBe(200);
    expect(received[1]?.searchParams.get("apikey")).toBe("personal+key");
    await service.close();
    const restored = await openTestServices({
      dataDir: join(context.directory, "feeds"),
      endpoints: { ...pluginEndpoints, c411: upstream.url.href },
      engine: () => context.engine,
      now: Date.now,
    });
    try {
      const restoredApi = await createTestApi(
        () => context.engine,
        context.sync.options,
        () => restored
      );
      const restoredClient = treaty(restoredApi).api;
      const restoredState = expectSuccess(await restoredClient.automation.get()) as AutomationState;
      expect(restoredState.plugins.find((plugin) => plugin.id === "c411")).toMatchObject({
        enabled: true,
        hasApiKey: true,
      });
      const restoredCheck = await restoredClient.plugins({ id: "c411" }).test.post({});
      expect(restoredCheck.status).toBe(200);
      expect(received[2]?.searchParams.get("apikey")).toBe("personal+key");
    } finally {
      await restored.close();
    }
  } finally {
    await service.close();
    upstream.stop(true);
    await context.close();
  }
});
test("a plugin configuration change cancels validation without saving the candidate key", async () => {
  const started = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<void>();
  const context = await credentialsFixture(async () => {
    started.resolve();
    await complete.promise;
    return connectedJev();
  });
  try {
    const pending = context.client
      .plugins({ id: "jev" })
      .connect.post({ apiKey: "candidate-test-key", enabled: true });
    await started.promise;
    const disabled = await context.client.plugins({ id: "jev" }).put({ enabled: false });
    expect(disabled.status).toBe(200);
    complete.resolve();
    expect((await pending).status).not.toBe(200);
    const state = expectSuccess(await context.client.automation.get()) as AutomationState;
    expect(state.plugins.find((plugin) => plugin.id === "jev")).toMatchObject({
      checkedAt: null,
      enabled: false,
      hasApiKey: false,
    });
  } finally {
    complete.resolve();
    await context.close();
  }
});
test("a rejected replacement keeps the saved Jev key, enabled state and daily limit", async () => {
  const authorizations: (string | null)[] = [];
  const context = await credentialsFixture((request) => {
    const authorization = request.headers.get("authorization");
    authorizations.push(authorization);
    return authorization === "Bearer saved-working-key"
      ? connectedJev()
      : new Response("candidate-key", { status: 401 });
  });
  try {
    const initial = await context.client
      .plugins({ id: "jev" })
      .put({ apiKey: "saved-working-key", dailyLimit: 5, enabled: true });
    expect(initial.status).toBe(200);
    const response = await context.client
      .plugins({ id: "jev" })
      .connect.post({ apiKey: "candidate-key", dailyLimit: 2, enabled: false });
    expect(response.status).toBe(400);
    await expectProblem(
      response,
      400,
      "TypeSafe rejected this API key. Generate a new key and try again."
    );
    const state = expectSuccess(await context.client.automation.get()) as AutomationState;
    expect(state.plugins.find((plugin) => plugin.id === "jev")).toMatchObject({
      checkedAt: null,
      dailyLimit: 5,
      enabled: true,
      error: null,
      hasApiKey: true,
    });
    expect((await context.client.plugins({ id: "jev" }).test.post({})).status).toBe(200);
    expect(authorizations).toEqual(["Bearer candidate-key", "Bearer saved-working-key"]);
  } finally {
    await context.close();
  }
});
test("Jev verifies a trimmed key while disabled and accounts for validation in its daily budget", async () => {
  const authorizations: (string | null)[] = [];
  const context = await credentialsFixture((request) => {
    authorizations.push(request.headers.get("authorization"));
    return connectedJev();
  });
  try {
    const response = await context.client
      .plugins({ id: "jev" })
      .connect.post({ apiKey: " test-jev-key ", dailyLimit: 1, enabled: false });
    expect(response.status).toBe(200);
    const state = expectSuccess(response) as AutomationState;
    expect(state.plugins.find((plugin) => plugin.id === "jev")).toMatchObject({
      callsToday: 1,
      dailyLimit: 1,
      enabled: false,
      hasApiKey: true,
    });
    expect(JSON.stringify(state)).not.toContain("test-jev-key");
    const blocked = await context.client
      .plugins({ id: "jev" })
      .connect.post({ apiKey: "replacement-key", enabled: true });
    await expectProblem(blocked, 429, "Jev daily limit reached");
    expect(authorizations).toEqual(["Bearer test-jev-key"]);
    const current = expectSuccess(await context.client.automation.get()) as AutomationState;
    expect(current.plugins.find((plugin) => plugin.id === "jev")?.enabled).toBe(false);
  } finally {
    await context.close();
  }
});
test.each([
  "https://example.com/api/torznab?apikey=private-test-key",
  "http://c411.org/api/torznab?apikey=private-test-key",
  "https://c411.org.evil.test/api/torznab?apikey=private-test-key",
  "https://user:password@c411.org/api/torznab?apikey=private-test-key",
  "https://c411.org/api/torznab?apikey=first&apikey=second",
  "https://c411.org/api/torznab?apikey=",
  "https://c411.org/api/torznab?t=search",
  "https://c411.org/user/integrations?apikey=private-test-key",
  "javascript:alert(1)",
])(
  "C411 rejects an invalid credential link without contacting its provider: %s",
  async (apiKey) => {
    let calls = 0;
    const context = await credentialsFixture(() => {
      calls += 1;
      return new Response("<rss><channel></channel></rss>");
    });
    try {
      const response = await context.client
        .plugins({ id: "c411" })
        .connect.post({ apiKey, enabled: true });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.error?.value ?? response.data)).not.toContain(
        "private-test-key"
      );
      expect(calls).toBe(0);
      const state = expectSuccess(await context.client.automation.get()) as AutomationState;
      expect(state.plugins.find((plugin) => plugin.id === "c411")).toMatchObject({
        enabled: false,
        hasApiKey: false,
      });
    } finally {
      await context.close();
    }
  }
);
test.each(["c411", "jev"])(
  "%s refuses a successful HTTP response with an invalid provider payload",
  async (id) => {
    const context = await credentialsFixture(
      () => new Response("<html>Sign in: private-test-key</html>")
    );
    try {
      const response = await context.client
        .plugins({ id })
        .connect.post({ apiKey: "private-test-key", enabled: true });
      expect(response.status).toBe(502);
      expect(JSON.stringify(response.error?.value ?? response.data)).not.toContain(
        "private-test-key"
      );
      const state = expectSuccess(await context.client.automation.get()) as AutomationState;
      expect(state.plugins.find((plugin) => plugin.id === id)).toMatchObject({
        checkedAt: null,
        enabled: false,
        hasApiKey: false,
      });
    } finally {
      await context.close();
    }
  }
);
