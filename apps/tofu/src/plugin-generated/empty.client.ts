import type { PluginUI } from "@tofu/plugins";

export interface ExternalPluginUI {
  id: string;
  name: string;
  pages: { id: string; path: string }[];
  ui: PluginUI;
}

export const externalPluginUIs: ExternalPluginUI[] = [];
