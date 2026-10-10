import { ui as anilist } from "@tofu/anilist/client";
import type { PluginUI } from "@tofu/plugins";
import { createClient } from "@tofu/plugins/client";
import type { createExtensionsApi } from "./api/extensions-api";
import { externalPluginUIs } from "./plugin-generated/client";

export const registeredPluginUIs: readonly { id: string; ui: PluginUI }[] = [
  { id: "anilist", ui: anilist },
  ...externalPluginUIs,
];
export const extensionClient = createClient<ReturnType<typeof createExtensionsApi>>(
  typeof window === "undefined" ? "http://localhost" : window.location.origin
);
export type ExtensionState = Awaited<ReturnType<typeof extensionClient.api.extensions.get>>["data"];
