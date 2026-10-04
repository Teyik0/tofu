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
    description: "Watching et Plan to Watch transformés en automatisations de votre onglet.",
    id: "anilist",
    name: "AniList",
  },
  { description: "Recherche et suivi des sorties via RSS.", id: "nyaa", name: "Nyaa" },
  {
    description: "Sorties et métadonnées du flux JSON officiel.",
    id: "tsundere",
    name: "Tsundere-Raws",
  },
  { description: "Recherche Torznab avec votre clé personnelle.", id: "c411", name: "C411" },
  {
    description: "Compréhension des demandes et matching des titres en langage naturel.",
    id: "jev",
    name: "Jev · TypeSafe",
  },
];
