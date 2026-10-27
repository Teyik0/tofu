import { expect, test } from "bun:test";
import { createPluginScope } from "../src/server";

test("disabling a plugin aborts its work and disposes resources once in reverse order", async () => {
  const scope = createPluginScope();
  const events: string[] = [];
  scope.onDispose(() => {
    events.push("first");
  });
  scope.onDispose(() => {
    events.push("second");
  });
  await scope.dispose();
  await scope.dispose();
  expect(scope.signal.aborted).toBe(true);
  expect(events).toEqual(["second", "first"]);
});

test("a failing disposer still releases the remaining plugin resources", async () => {
  const scope = createPluginScope();
  const events: string[] = [];
  scope.onDispose(() => {
    events.push("released");
  });
  scope.onDispose(() => {
    throw new Error("Resource failure");
  });
  await expect(scope.dispose()).rejects.toThrow("Plugin disposal failed");
  expect(events).toEqual(["released"]);
  expect(scope.signal.aborted).toBe(true);
});
