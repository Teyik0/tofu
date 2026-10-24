import "@teyik0/furin/server-only";
import { Elysia } from "elysia";

export const lifecyclePlugin = new Elysia({ name: "tofu-lifecycle" })
  .use((app) => {
    const resources = new AsyncDisposableStack();
    const initializations = new Set<Promise<void>>();

    return app
      .decorate({
        resources,
        reserveInitialization() {
          const completed = Promise.withResolvers<void>();
          initializations.add(completed.promise);
          return {
            [Symbol.dispose]() {
              initializations.delete(completed.promise);
              completed.resolve();
            },
          };
        },
      })
      .onStop(async () => {
        await Promise.all(initializations);
        await resources.disposeAsync();
      });
  });
