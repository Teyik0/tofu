import { expect, test } from "bun:test";
import { join } from "node:path";
import { createClient, useQuery } from "@teyik0/furin/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { Api } from "../src/api";
import { AutomationService } from "../src/api/modules/automation/service";
import { pluginEndpoints } from "../src/api/modules/plugins/service";
import { createAutomationMutations } from "../src/lib/automation-mutations";
import type { AutomationDraft, AutomationState } from "../src/types";
import { createTestApi } from "./api-fixture";
import { fixture, waitFor } from "./helpers";

test.each(["success", "rejection"])(
  "automation preferences update immediately and reconcile after %s",
  async (outcome) => {
    const context = await fixture(1024, []);
    const service = await AutomationService.open({
      dataDir: join(context.directory, "feeds"),
      endpoints: pluginEndpoints,
      engine: () => context.engine,
      now: Date.now,
    });
    const app = await createTestApi(
      () => context.engine,
      context.sync.options,
      () => service
    );
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: new URL("http://localhost/") },
    });
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const client = createClient<Api>("http://localhost", {
      fetcher: async (input, init) => {
        const request = new Request(input, init);
        if (request.method === "PUT") {
          started.resolve();
          await release.promise;
        }
        return app.handle(request);
      },
    }).api;
    const read = () => {
      let data: Awaited<ReturnType<typeof client.automation.get>>["data"] | undefined;
      function Preferences() {
        ({ data } = useQuery(client.automation.get));
        return null;
      }
      renderToStaticMarkup(<Preferences />);
      if (!(data && "preferences" in data)) {
        throw new Error("Automation preferences were not loaded");
      }
      return data.preferences;
    };
    try {
      await client.automation.get();
      const initial = read();
      const changed = { ...initial, waitMinutes: outcome === "success" ? 35 : 2000 };
      const pending = createAutomationMutations(client).savePreferences(changed);
      await started.promise;
      expect(read()).toEqual(changed);
      release.resolve();
      const result = await pending;
      expect(result.error === null).toBe(outcome === "success");
      const expected = outcome === "success" ? changed : initial;
      expect(await waitFor(read, (value) => value.waitMinutes === expected.waitMinutes)).toEqual(
        expected
      );
      const confirmed = await client.automation.get();
      expect(confirmed.data).toMatchObject({ preferences: expected });
    } finally {
      release.resolve();
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      await service.close();
      await context.close();
    }
  }
);

test("rules appear, change and disappear before their writes complete", async () => {
  const context = await fixture(1024, []);
  const service = await AutomationService.open({
    dataDir: join(context.directory, "feeds"),
    endpoints: pluginEndpoints,
    engine: () => context.engine,
    now: Date.now,
  });
  const app = await createTestApi(
    () => context.engine,
    context.sync.options,
    () => service
  );
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: new URL("http://localhost/") },
  });
  let started = Promise.withResolvers<void>();
  let release = Promise.withResolvers<void>();
  const client = createClient<Api>("http://localhost", {
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      if (request.method !== "GET") {
        started.resolve();
        await release.promise;
      }
      return app.handle(request);
    },
  }).api;
  const read = () => {
    let data: AutomationState | undefined;
    function Rules() {
      const query = useQuery(client.automation.get);
      if (query.data && "automations" in query.data) {
        ({ data } = query);
      }
      return null;
    }
    renderToStaticMarkup(<Rules />);
    if (!data) {
      throw new Error("Automation rules were not loaded");
    }
    return data;
  };
  try {
    await client.automation.get();
    const draft: AutomationDraft = {
      ...read().preferences,
      destinationId: "default",
      enabled: false,
      includeExisting: true,
      matchMode: "exact",
      query: "Follow Test Show",
      season: null,
      title: "Test Show",
    };
    const mutations = createAutomationMutations(client);
    const creating = mutations.createRule(draft);
    await started.promise;
    expect(read().automations).toMatchObject([{ enabled: false, title: "Test Show" }]);
    const temporaryId = read().automations[0]?.id;
    release.resolve();
    const created = await creating;
    if (!(created.data && "id" in created.data)) {
      throw new Error("Automation creation failed");
    }
    const rule = created.data;
    await waitFor(read, (value) => value.automations[0]?.id === rule.id);
    expect(read().automations).toHaveLength(1);
    expect(rule.id).not.toBe(temporaryId);

    started = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    const updating = mutations.updateRule(rule.id, { ...draft, title: "Updated Show" });
    await started.promise;
    expect(read().automations[0]?.title).toBe("Updated Show");
    release.resolve();
    expect((await updating).error).toBeNull();
    await client.automation.get();
    expect(read().automations[0]?.title).toBe("Updated Show");

    started = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    const rejected = mutations.updateRule(rule.id, { ...draft, title: "" });
    await started.promise;
    expect(read().automations[0]?.title).toBe("");
    release.resolve();
    expect((await rejected).error?.status).toBe(422);
    expect(read().automations[0]?.title).toBe("Updated Show");

    started = Promise.withResolvers<void>();
    release = Promise.withResolvers<void>();
    const removing = mutations.deleteRule(rule.id);
    await started.promise;
    expect(read().automations).toEqual([]);
    release.resolve();
    expect((await removing).error).toBeNull();
    await client.automation.get();
    expect(read().automations).toEqual([]);
  } finally {
    release.resolve();
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    await service.close();
    await context.close();
  }
});
