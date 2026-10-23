import "@teyik0/furin/server-only";
import { Elysia } from "elysia";

export const resources = new AsyncDisposableStack();
const initializations = new Set<Promise<void>>();

// Reserve before the first await so startup failure waits for every resource transfer.
export function reserveInitialization() {
  const completed = Promise.withResolvers<void>();
  initializations.add(completed.promise);
  return {
    [Symbol.dispose]() {
      initializations.delete(completed.promise);
      completed.resolve();
    },
  };
}

export async function closeResources() {
  while (initializations.size > 0) {
    // biome-ignore lint/performance/noAwaitInLoops: An initializer can finish after another import fails or shutdown begins.
    await Promise.all(initializations);
  }
  await resources.disposeAsync();
}

export const lifecyclePlugin = new Elysia({ name: "tofu-lifecycle" }).decorate(
  "resources",
  resources
);
