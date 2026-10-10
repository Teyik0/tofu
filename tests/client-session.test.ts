import { expect, test } from "bun:test";
import { createClient } from "@teyik0/furin/client";
import { apiPlugin } from "../src/api";
import { api } from "../src/lib/client";

test("the shared server client accesses the local API without an HTTP listener or session cookie", async () => {
  const { data, error } = await api.instance.get();
  expect(error).toBeNull();
  expect(data).toMatchObject({ dataDir: expect.any(String), profile: expect.any(String) });
});

test("the API plugin supports Eden's direct server transport", async () => {
  const { data, error } = await createClient(apiPlugin, { parseDate: false }).api.instance.get();
  expect(error).toBeNull();
  expect(data).toMatchObject({ dataDir: expect.any(String), profile: expect.any(String) });
});
