import { Elysia, t } from "elysia";
import { pluginHost } from "./lib/extensions";

export const extensionsPlugin = new Elysia({
  name: "tofu-extensions-api",
  prefix: "/extensions",
})
  .beforeHandle(() => pluginHost.initialize())
  .get("", { query: t.Object({ threadId: t.Optional(t.String()) }) }, ({ query }) =>
    pluginHost.snapshot(query.threadId)
  )
  .patch("/:id/enabled", { body: t.Object({ enabled: t.Boolean() }) }, ({ params, body }) =>
    pluginHost.setEnabled(params.id, body.enabled)
  )
  .patch(
    "/:id/settings",
    { body: t.Object({ patch: t.Unknown(), threadId: t.Optional(t.String()) }) },
    ({ params, body }) => pluginHost.updateSettings(params.id, body.patch, body.threadId)
  )
  .delete(
    "/:id/settings",
    { query: t.Object({ threadId: t.Optional(t.String()) }) },
    ({ params, query }) => pluginHost.resetSettings(params.id, query.threadId)
  )
  .post("/:id/pages/:pageId", { body: t.Object({ pinned: t.Boolean() }) }, ({ params, body }) =>
    pluginHost.setPage(params.id, params.pageId, body.pinned)
  )
  .delete("/:id/pages/:pageId", ({ params }) => pluginHost.setPage(params.id, params.pageId, null))
  .post(
    "/:id/auth",
    { body: t.Object({ apiKey: t.Optional(t.String({ maxLength: 4096 })) }) },
    ({ params, body }) => pluginHost.authorize(params.id, body.apiKey)
  )
  .delete("/:id/auth", ({ params }) => pluginHost.disconnect(params.id))
  .get("/:id/auth/callback", async ({ params, request }) => {
    await pluginHost.callback(params.id, request.url);
    return new Response("Account connected. You can return to Tofu.", {
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
    });
  });
