import { expect, test } from "bun:test";
import { Elysia } from "elysia";
import { services } from "../src/api/lib/services";
import { fixture } from "./helpers";

test("a third-party Elysia plugin reuses shared services without remounting application routes", async () => {
  const context = await fixture(65_536, []);
  try {
    const extension = new Elysia({ name: "fixture-extension", prefix: "/api/plugins/fixture" }).get(
      "/state",
      () => services.engine.snapshot(null, false)
    );
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
