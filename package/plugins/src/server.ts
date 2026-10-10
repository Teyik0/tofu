/* biome-ignore-all lint/performance/noBarrelFile: Public backend entry keeps host-only capabilities outside browser bundles. */

export { createPluginApi } from "./api";
export type { PluginAuth, PluginCredentials } from "./auth";
export { type ApiKeyAuth, createApiKeyAuth, createCustomAuth } from "./auth-adapters";
export { createCore, createJev } from "./core";
export { createCredentialStore } from "./credentials";
export type { ErasedPluginDefinition, PluginInstallationOptions } from "./definition";
export { isDefinedPlugin } from "./definition";
export { createPluginScope, type Disposer, type PluginScope } from "./lifecycle";
export { createOAuth2Auth, type OAuth2Auth, type OAuth2Options } from "./oauth2";
export {
  type InspectedPluginPackage,
  inspectPluginPackage,
  type PackageInspectionOptions,
} from "./package";
export {
  createPluginRuntime,
  type InstalledPlugin,
  type PluginRegistration,
  type PluginRuntime,
} from "./runtime";
export {
  createSettingsStore,
  type PluginSettings,
  type PluginSettingsController,
  type SettingsDefinition,
} from "./settings";
export type { PluginCore, PluginCoreCapabilities } from "./tofu-core";

export class UserError extends Error {
  readonly status: number;

  constructor(message: string, options: ErrorOptions & { status: number }) {
    super(message, options);
    this.status = options.status;
  }
}
