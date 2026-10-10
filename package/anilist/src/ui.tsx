import { defineRoute } from "@teyik0/furin";
import type { PluginRouteContext } from "@tofu/plugins/routes";
import { AniListIcon } from "./components/anilist-icon";
import { AniListLibrary } from "./components/anilist-library";

export const ui = {
  pages: [
    {
      availableWhenDisabled: true,
      icon: AniListIcon,
      id: "library",
      path: "/anilist",
      pinnable: true,
      route({ threadLayout }: PluginRouteContext) {
        return defineRoute()
          .config({ layout: threadLayout, mode: "ssr" })
          .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
          .page(AniListLibrary);
      },
      title: "AniList",
    },
  ] as const,
};
