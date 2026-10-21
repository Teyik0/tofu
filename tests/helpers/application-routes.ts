import { desktopApp } from "@teyik0/furin-electrobun/server";
import { Elysia, t } from "elysia";
import { apiPlugin } from "../../src/api";
import { httpPolicyPlugin } from "../../src/api/lib/http-policy";
import { accessPlugin } from "../../src/api/modules/access/plugin";
import { desktopServicePlugin } from "../../src/api/modules/desktop/service";
import { sync } from "../../src/sync";
import { integrationPlugin } from "./plugin-integration-routes";

export const fixtureRoutes = new Elysia({
  name: "tofu-integration-api",
  serve: { hostname: "127.0.0.1", idleTimeout: 120, maxRequestBodySize: 9 * 1024 * 1024 },
})
  .use(accessPlugin)
  .use((app) =>
    app.decorate((dependencies) => {
      app.use(desktopApp({ admission: dependencies.access.admit.bind(dependencies.access) }));
      return dependencies;
    })
  )
  .use(desktopServicePlugin)
  .use(httpPolicyPlugin)
  .guard({ noStore: true })
  .use(apiPlugin)
  .use(integrationPlugin)
  .post(
    "/__test/desktop/open",
    { body: t.Object({ path: t.String() }) },
    async ({ body, desktopHooks }) => {
      let shown = 0;
      const messages: unknown[] = [];
      // The native host is the boundary; the hook and its application services remain real.
      await desktopHooks.onOpen({
        desktop: {
          dialogs: {
            message: (message: unknown) => {
              messages.push(message);
              return Promise.resolve({ response: 0 });
            },
          },
          window: {
            open: () => {
              shown += 1;
            },
          },
        },
        event: { path: body.path, type: "file" },
        identity: { name: "Tofu Dev" },
      } as unknown as Parameters<typeof desktopHooks.onOpen>[0]);
      return { messages, shown };
    }
  );
export const fixtureSync = sync;
