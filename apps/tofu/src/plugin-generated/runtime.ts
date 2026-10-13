import { isAbsolute, join, relative, sep } from "node:path";
import type { ErasedPluginDefinition } from "@tofu/plugins";
import type { PluginCore } from "@tofu/plugins/server";
import { inspectPluginPackage, isDefinedPlugin } from "@tofu/plugins/server";

export interface ExternalPluginPin {
  id: string;
  integrity: string;
  path: string;
}

interface PluginServerModule {
  createPlugin: (core: PluginCore) => unknown;
}

function isPluginServerModule(value: unknown): value is PluginServerModule {
  return Boolean(
    value &&
      typeof value === "object" &&
      "createPlugin" in value &&
      typeof value.createPlugin === "function"
  );
}

export async function loadExternalPlugins(
  core: PluginCore,
  pins: readonly ExternalPluginPin[],
  cacheDirectories: readonly string[]
): Promise<ErasedPluginDefinition[]> {
  if (pins.length === 0) {
    return [];
  }
  const inspected = await Promise.all(
    pins.map(async (pin) => {
      if (isAbsolute(pin.path) || pin.path === ".." || pin.path.startsWith(`..${sep}`)) {
        throw new Error("Plugin runtime paths must remain inside the packaged cache");
      }
      for (const root of cacheDirectories) {
        const directory = join(root, pin.path);
        const contained = relative(root, directory);
        if (contained === ".." || contained.startsWith(`..${sep}`) || isAbsolute(contained)) {
          throw new Error("Plugin runtime paths must remain inside the packaged cache");
        }
        // biome-ignore lint/performance/noAwaitInLoops: Resolve the first available source or packaged cache before loading code.
        if (await Bun.file(join(directory, "package.json")).exists()) {
          return await inspectPluginPackage(directory, { integrity: pin.integrity });
        }
      }
      throw new Error(`Plugin ${pin.id} is missing from the runtime cache; rebuild Tofu`);
    })
  );
  return await Promise.all(
    inspected.map(async (entry, index) => {
      const pin = pins[index];
      if (!pin || entry.id !== pin.id) {
        throw new Error("Plugin identity does not match the runtime pin");
      }
      const module: unknown = await import(entry.serverPath);
      if (!isPluginServerModule(module)) {
        throw new Error(`Plugin ${entry.id} must export createPlugin from its server entry`);
      }
      const definition = await module.createPlugin(core);
      if (
        !isDefinedPlugin(definition) ||
        definition.id !== entry.id ||
        definition.version !== entry.version
      ) {
        throw new Error(`Plugin ${entry.id} must return a matching definePlugin definition`);
      }
      return definition;
    })
  );
}
