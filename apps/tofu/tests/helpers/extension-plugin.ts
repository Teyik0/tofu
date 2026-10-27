import { join } from "node:path";
import { definePlugin } from "@tofu/plugins";
import type { PluginCore } from "@tofu/plugins/server";
import { Elysia } from "elysia";
import { Type } from "typebox";

export function createPlugin(core: PluginCore) {
  return definePlugin({
    api(context) {
      return new Elysia().use(core).get("/status", ({ core: host }) => ({
        authenticated: context.auth?.status().authenticated ?? false,
        settings: context.settings.get(),
        torrents: host.dashboard().torrents.length,
      }));
    },
    auth: { kind: "api-key", label: "Fixture API key" },
    id: "fixture",
    name: "Fixture",
    settings: {
      defaults: { label: "Initial label" },
      schema: Type.Object({ label: Type.String() }),
    },
    setup({ scope }) {
      scope.onDispose(async () => {
        await Bun.write(join(process.cwd(), "disposed-fixture-plugin"), "disposed");
      });
    },
    version: "0.0.0",
  });
}
