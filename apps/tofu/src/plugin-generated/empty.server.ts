import type { ErasedPluginDefinition } from "@tofu/plugins";
import type { PluginCore } from "@tofu/plugins/server";

export function externalPlugins(core: PluginCore): Promise<ErasedPluginDefinition[]> {
  void core;
  return Promise.resolve([]);
}
