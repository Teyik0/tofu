import type { FurinSyncOptions } from "@teyik0/furin/sync";
import type { AnyElysia } from "elysia";
import type { TObject } from "typebox";
import type { PluginAuth, PluginAuthDefinition } from "./auth";
import type { PluginScope } from "./lifecycle";
import type { PluginSettings, SettingsDefinition } from "./settings";
import type { PluginUI } from "./ui";

const pluginIdPattern = /^[a-z][a-z0-9-]*$/;

export const installPluginDefinition = Symbol.for("tofu.install-plugin-definition.v0");

export interface PluginInstallationOptions {
  auth?: PluginAuth | ((scope: PluginScope) => PluginAuth | null | Promise<PluginAuth | null>);
  directory: string;
  mountAt?: string | null;
}

export type PluginDefinitionInstaller = <
  Schema extends TObject,
  API extends AnyElysia,
  UI extends PluginUI,
>(
  definition: PluginDefinition<Schema, API, UI>,
  options: PluginInstallationOptions
) => Promise<void>;

/** Heterogeneous registries retain each schema inside its installer closure. */
export interface ErasedPluginDefinition {
  auth?: PluginAuthDefinition;
  description?: string;
  id: string;
  name: string;
  ui?: PluginUI;
  version: string;
  [installPluginDefinition]: (
    installer: PluginDefinitionInstaller,
    options: PluginInstallationOptions
  ) => Promise<void>;
}

export type DefinedPlugin<
  Schema extends TObject,
  API extends AnyElysia,
  UI extends PluginUI,
> = PluginDefinition<Schema, API, UI> & ErasedPluginDefinition;

/** Validate dynamic factory results after the host has verified and trusted their package. */
export function isDefinedPlugin(value: unknown): value is ErasedPluginDefinition {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    typeof value.id === "string" &&
    pluginIdPattern.test(value.id) &&
    "name" in value &&
    typeof value.name === "string" &&
    "version" in value &&
    typeof value.version === "string" &&
    installPluginDefinition in value &&
    typeof value[installPluginDefinition] === "function"
  );
}

export interface PluginContext<Schema extends TObject> {
  auth: PluginAuth | null;
  scope: PluginScope;
  settings: PluginSettings<Schema>;
  sync?: FurinSyncOptions;
}

export interface PluginDefinition<
  Schema extends TObject,
  API extends AnyElysia,
  UI extends PluginUI,
> {
  api: API | ((context: PluginContext<Schema>) => API);
  auth?: PluginAuthDefinition;
  description?: string;
  id: string;
  name: string;
  settings?: SettingsDefinition<Schema>;
  setup?: (context: PluginContext<Schema>) => void | Promise<void>;
  ui?: UI;
  version: string;
}

/** One definition holds backend, UI, settings and auth contributions. */
export function definePlugin<
  Schema extends TObject,
  API extends AnyElysia,
  const UI extends PluginUI,
>(definition: PluginDefinition<Schema, API, UI>): DefinedPlugin<Schema, API, UI> {
  if (!pluginIdPattern.test(definition.id)) {
    throw new Error(
      "Plugin IDs must start with a lowercase letter and contain only lowercase letters, digits, and hyphens"
    );
  }
  return Object.assign(definition, {
    [installPluginDefinition](
      installer: PluginDefinitionInstaller,
      options: PluginInstallationOptions
    ) {
      return installer(definition, options);
    },
  });
}

export type PluginAPI<Definition> = Definition extends { api: infer API }
  ? API extends (...args: never[]) => infer Result
    ? Result
    : API
  : never;
