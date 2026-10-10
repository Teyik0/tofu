import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { createCore } from "../src/api/core";
import { fixture } from "./helpers";

test("a third-party Elysia plugin reuses core capabilities without remounting core routes", async () => {
  const context = await fixture(65_536, []);
  try {
    const dependency = createCore({ engine: () => context.engine, sync: context.sync.options });
    const extension = new Elysia({ name: "fixture-extension", prefix: "/api/plugins/fixture" })
      .use(dependency)
      .get("/state", ({ core }) => core.engine().snapshot(null, false));
    const app = new Elysia().use(context.api).use(extension);
    const response = await app.handle("http://localhost/api/plugins/fixture/state");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(context.engine.snapshot(null, false));
    expect((await app.handle("http://localhost/api/health")).status).toBe(200);
    expect((await app.handle("http://localhost/api/plugins/fixture/api/health")).status).toBe(404);
    expect((await app.handle("http://localhost/api/plugins/fixture/health")).status).toBe(404);
  } finally {
    await context.close();
  }
});
