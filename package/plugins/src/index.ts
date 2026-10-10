/* biome-ignore-all lint/performance/noBarrelFile: Public package definition and shared type contract. */

export type { PluginAuthDefinition, PluginAuthStatus } from "./auth";
export {
  type DefinedPlugin,
  definePlugin,
  type ErasedPluginDefinition,
  type PluginAPI,
  type PluginContext,
  type PluginDefinition,
  type PluginInstallationOptions,
} from "./definition";
export type { PluginSettings, SettingsDefinition } from "./settings";
export type { PluginCore, PluginCoreCapabilities } from "./tofu-core";
export type {
  PluginPage,
  PluginUI,
  ThreadAction,
  ThreadActionContext,
  ThreadContext,
  ThreadLayoutContext,
} from "./ui";
export { PLUGIN_API_VERSION } from "./version";
