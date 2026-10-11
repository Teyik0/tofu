import { expect, test } from "bun:test";
import { createClient } from "@teyik0/furin/client";
import { createBaseContext } from "elysia";
import { apiPlugin } from "../src/api";
import { applicationScope } from "../src/api/lib/host";
import { api } from "../src/lib/client";
import { fixture } from "./helpers";

test("the shared server client accesses the local API without an HTTP listener or session cookie", async () => {
  const context = await fixture(4096, []);
  try {
    const app = context.api.get("/fixture/client", async () => {
      const { data, error } = await api.instance.get();
      expect(error).toBeNull();
      return data;
    });
    const response = await app.handle("http://localhost/fixture/client");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      dataDir: expect.any(String),
      profile: expect.any(String),
    });
  } finally {
    await context.close();
  }
});

test("the API plugin supports Eden's direct server transport", async () => {
  const context = await fixture(4096, []);
  try {
    const application = await new (createBaseContext(context.api))().store.applicationHost
      .application;
    const { data, error } = await applicationScope.run(application, () =>
      createClient(apiPlugin, { parseDate: false }).api.instance.get()
    );
    expect(error).toBeNull();
    expect(data).toMatchObject({ dataDir: expect.any(String), profile: expect.any(String) });
  } finally {
    await context.close();
  }
});
