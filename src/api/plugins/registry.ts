import type { PluginState } from "../../types";

export const pluginEndpoints = {
  c411: "https://c411.org/api/torznab",
  jev: "https://api.typesafe.ai/v1/systemone",
  nyaa: "https://nyaa.si/",
  tsundere: "https://tsundere.to/api/v1/feed.json",
};
export type PluginEndpoints = typeof pluginEndpoints & { anilist?: string; anilistToken?: string };
export const plugins: Pick<PluginState, "id" | "name" | "description">[] = [
  {
    description: "Browse your anime library, sync watched episodes, and customize download rules.",
    id: "anilist",
    name: "AniList",
  },
  { description: "Search and follow releases through RSS.", id: "nyaa", name: "Nyaa" },
  {
    description: "Releases and metadata from the official JSON feed.",
    id: "tsundere",
    name: "Tsundere-Raws",
  },
  { description: "Torznab search with your personal key.", id: "c411", name: "C411" },
  {
    description: "Natural language request interpretation and title matching.",
    id: "jev",
    name: "Jev · TypeSafe",
  },
];
