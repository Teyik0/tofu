import { treaty } from "@elysia/eden";
import { furinSync } from "@teyik0/furin/client";
import { ui as anilist } from "@tofu/anilist/client";
import type { PluginUI } from "@tofu/plugins";
import type { Api } from "./api/index";
import { externalPluginUIs } from "./plugin-generated/client";

export const registeredPluginUIs: readonly { id: string; ui: PluginUI }[] = [
  { id: "anilist", ui: anilist },
  ...externalPluginUIs,
];
export const extensionClient = treaty<Api>(
  typeof window === "undefined" ? "http://localhost" : window.location.origin
).use(furinSync);
export type ExtensionState = Awaited<ReturnType<typeof extensionClient.api.extensions.get>>["data"];
