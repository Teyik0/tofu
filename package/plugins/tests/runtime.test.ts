import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Elysia } from "elysia";
import { Type } from "typebox";
import type { ErasedPluginDefinition } from "../src/index";
import { definePlugin } from "../src/index";
import { createPluginRuntime, isDefinedPlugin } from "../src/server";

test("disabled plugin routes disappear and enabling creates a fresh scope without deleting plugin data", async () => {
  const runtime = createPluginRuntime();
  const signals: AbortSignal[] = [];
  let disposals = 0;
  const data = { visits: 0 };
  await runtime.install({
    create(scope) {
      signals.push(scope.signal);
      scope.onDispose(() => {
        disposals += 1;
      });
      return new Elysia().get("/count", () => {
        data.visits += 1;
        return data;
      });
    },
    id: "counter",
  });
  const request = () => new Request("http://localhost/api/plugins/counter/count");
  expect((await runtime.handle(request())).status).toBe(404);
  await runtime.enable("counter");
  expect(await (await runtime.handle(request())).json()).toEqual({ visits: 1 });
  await runtime.disable("counter");
  expect((await runtime.handle(request())).status).toBe(404);
  expect(signals[0]?.aborted).toBe(true);
  await runtime.enable("counter");
  expect(signals[1]?.aborted).toBe(false);
  expect(await (await runtime.handle(request())).json()).toEqual({ visits: 2 });
  await runtime.uninstall("counter");
  expect(data.visits).toBe(2);
  expect(disposals).toBe(2);
  expect(runtime.list()).toEqual([]);
});

test("dynamic factories must return an SDK definition before the host registers them", () => {
  expect(isDefinedPlugin(null)).toBe(false);
  expect(isDefinedPlugin({ id: "ordinary", name: "Ordinary", version: "0.0.0" })).toBe(false);
  const plugin = definePlugin({
    api: new Elysia(),
    id: "defined",
    name: "Defined",
    version: "0.0.0",
  });
  expect(isDefinedPlugin(plugin)).toBe(true);
});

test("heterogeneous plugin definitions keep each settings schema behind a validated host controller", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-heterogeneous-"));
  const runtime = createPluginRuntime();
  const definitions: ErasedPluginDefinition[] = [
    definePlugin({
      api: ({ settings }) => new Elysia().get("/settings", () => settings.get()),
      id: "language",
      name: "Language",
      settings: { defaults: { language: "en" }, schema: Type.Object({ language: Type.String() }) },
      version: "0.0.0",
    }),
    definePlugin({
      api: ({ settings }) => new Elysia().get("/settings", () => settings.get()),
      id: "limit",
      name: "Limit",
      settings: {
        defaults: { limit: 10 },
        schema: Type.Object({ limit: Type.Number({ minimum: 1 }) }),
      },
      version: "0.0.0",
    }),
  ];
  try {
    for (const definition of definitions) {
      // biome-ignore lint/performance/noAwaitInLoops: Registry mutations install plugins in their declared order.
      await runtime.installDefinition({ definition, directory });
    }
    const language = runtime.settings("language");
    const limit = runtime.settings("limit");
    expect(language?.schema.properties.language).toBeDefined();
    expect(language?.get()).toEqual({ language: "en" });
    await expect(language?.update({ language: 1 })).rejects.toThrow("schema");
    expect(await language?.update({ language: "ja" }, "thread-one")).toEqual({ language: "ja" });
    expect(limit?.get()).toEqual({ limit: 10 });
    await runtime.enable("language");
    expect(
      await (
        await runtime.handle(new Request("http://localhost/api/plugins/language/settings"))
      ).json()
    ).toEqual({ language: "en" });
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true });
  }
});

test("rebuilding one plugin keeps other typed APIs reachable without retaining disabled routes", async () => {
  const runtime = createPluginRuntime();
  const first = definePlugin({
    api: new Elysia().get("/value", () => "first"),
    id: "first",
    name: "First",
    version: "0.0.0",
  });
  const second = definePlugin({
    api: new Elysia().get("/value", () => "second"),
    id: "second",
    name: "Second",
    version: "0.0.0",
  });
  try {
    await runtime.installDefinition({ definition: first, directory: tmpdir() });
    await runtime.installDefinition({ definition: second, directory: tmpdir() });
    await runtime.enable("first");
    await runtime.enable("second");
    expect(
      await (await runtime.handle(new Request("http://localhost/api/plugins/first/value"))).text()
    ).toBe("first");
    await runtime.disable("second");
    expect(
      await (await runtime.handle(new Request("http://localhost/api/plugins/first/value"))).text()
    ).toBe("first");
    expect(
      (await runtime.handle(new Request("http://localhost/api/plugins/second/value"))).status
    ).toBe(404);
    await runtime.enable("second");
    expect(
      await (await runtime.handle(new Request("http://localhost/api/plugins/second/value"))).text()
    ).toBe("second");
  } finally {
    await runtime.dispose();
  }
});

test("failed plugin initialization disposes registered work and can be retried", async () => {
  const runtime = createPluginRuntime();
  let fail = true;
  let cleanups = 0;
  try {
    await runtime.installDefinition({
      definition: definePlugin({
        api: new Elysia().get("/ready", () => "ready"),
        id: "retry",
        name: "Retry",
        setup({ scope }) {
          scope.onDispose(() => {
            cleanups += 1;
          });
          if (fail) {
            throw new Error("Initialization failed");
          }
        },
        version: "0.0.0",
      }),
      directory: tmpdir(),
    });
    await expect(runtime.enable("retry")).rejects.toThrow("Initialization failed");
    expect(cleanups).toBe(1);
    expect(runtime.list()).toEqual([{ enabled: false, id: "retry" }]);
    expect(
      (await runtime.handle(new Request("http://localhost/api/plugins/retry/ready"))).status
    ).toBe(404);
    fail = false;
    await runtime.enable("retry");
    expect(
      await (await runtime.handle(new Request("http://localhost/api/plugins/retry/ready"))).text()
    ).toBe("ready");
  } finally {
    await runtime.dispose();
  }
  expect(cleanups).toBe(2);
});

test("one plugin definition registers persisted settings, scoped setup and enabled UI contributions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tofu-plugin-definition-"));
  const runtime = createPluginRuntime();
  let setupCalls = 0;
  let disposalCalls = 0;
  try {
    const definition = definePlugin({
      api: ({ settings }) =>
        new Elysia()
          .get("/settings", () => settings.get())
          .put("/language", () => settings.update({ language: "ja" })),
      id: "defined-plugin",
      name: "Defined plugin",
      settings: {
        defaults: { language: "en" },
        schema: Type.Object({ language: Type.String() }),
      },
      setup({ scope }) {
        setupCalls += 1;
        scope.onDispose(() => {
          disposalCalls += 1;
        });
      },
      ui: {
        pages: [
          { id: "library", path: "/library", pinnable: true, route: () => null, title: "Library" },
        ],
      },
      version: "0.0.0",
    });
    await runtime.installDefinition({ definition, directory });
    expect(runtime.contributions()).toEqual([]);
    await runtime.enable(definition.id);
    expect(runtime.contributions()[0]?.ui).toEqual(definition.ui);
    await runtime.handle(
      new Request("http://localhost/api/plugins/defined-plugin/language", { method: "PUT" })
    );
    await runtime.disable(definition.id);
    expect(runtime.contributions()).toEqual([]);
    await runtime.enable(definition.id);
    expect(
      await (
        await runtime.handle(new Request("http://localhost/api/plugins/defined-plugin/settings"))
      ).json()
    ).toEqual({ language: "ja" });
    expect(setupCalls).toBe(2);
    expect(disposalCalls).toBe(1);
  } finally {
    await runtime.dispose();
    await rm(directory, { recursive: true });
  }
});
