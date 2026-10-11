import { Elysia, t } from "elysia";
import type { PluginHost } from "./plugin-host";

export function createExtensionsApi(getHost: () => PluginHost) {
  return new Elysia({ name: "tofu-extensions-api", prefix: "/api/extensions" })
    .beforeHandle(() => getHost().initialize())
    .get("", { query: t.Object({ threadId: t.Optional(t.String()) }) }, ({ query }) =>
      getHost().snapshot(query.threadId)
    )
    .patch("/:id/enabled", { body: t.Object({ enabled: t.Boolean() }) }, ({ params, body }) =>
      getHost().setEnabled(params.id, body.enabled)
    )
    .patch(
      "/:id/settings",
      { body: t.Object({ patch: t.Unknown(), threadId: t.Optional(t.String()) }) },
      ({ params, body }) => getHost().updateSettings(params.id, body.patch, body.threadId)
    )
    .delete(
      "/:id/settings",
      { query: t.Object({ threadId: t.Optional(t.String()) }) },
      ({ params, query }) => getHost().resetSettings(params.id, query.threadId)
    )
    .post("/:id/pages/:pageId", { body: t.Object({ pinned: t.Boolean() }) }, ({ params, body }) =>
      getHost().setPage(params.id, params.pageId, body.pinned)
    )
    .delete("/:id/pages/:pageId", ({ params }) => getHost().setPage(params.id, params.pageId, null))
    .post(
      "/:id/auth",
      { body: t.Object({ apiKey: t.Optional(t.String({ maxLength: 4096 })) }) },
      ({ params, body }) => getHost().authorize(params.id, body.apiKey)
    )
    .delete("/:id/auth", ({ params }) => getHost().disconnect(params.id))
    .get("/:id/auth/callback", async ({ params, request }) => {
      await getHost().callback(params.id, request.url);
      return new Response("Account connected. You can return to Tofu.", {
        headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
      });
    });
}
