import { expect, test } from "bun:test";
import {
  createClient as furinClient,
  useMutation as furinMutation,
  useQuery as furinQuery,
} from "@teyik0/furin/client";
import { createClient, useMutation, useQuery } from "../src/client";

test("plugin query hooks share the host Furin contexts through direct exports", () => {
  expect(createClient).toBe(furinClient);
  expect(useMutation).toBe(furinMutation);
  expect(useQuery).toBe(furinQuery);
});

test("the SDK browser entry excludes credential storage and server runtime code", async () => {
  const result = await Bun.build({
    entrypoints: [new URL("../src/client.ts", import.meta.url).pathname],
    packages: "external",
    target: "browser",
  });
  expect(result.success).toBe(true);
  const source = await result.outputs[0]?.text();
  expect(source).toContain("@teyik0/furin/client");
  expect(source).not.toContain("node:fs");
  expect(source).not.toContain("credentials.json");
  expect(source).not.toContain("new Elysia");
});
