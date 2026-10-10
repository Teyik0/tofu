import { expect, test } from "bun:test";
import { createBaseContext, Elysia } from "elysia";
import { contextPlugin } from "../src/api/lib/context";
import { fixture } from "./helpers";

test("a third-party Elysia plugin receives the application without remounting application routes", async () => {
  const context = await fixture(65_536, []);
  try {
    const host = new (createBaseContext(context.api))().store.applicationHost;
    const extension = new Elysia({ name: "fixture-extension", prefix: "/api/plugins/fixture" })
      .use(contextPlugin)
      .get("/state", ({ application }) => application.engine.snapshot(null, false));
    const app = context.api.use(extension).state((store) => ({ ...store, applicationHost: host }));
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
