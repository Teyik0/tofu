import { defineRoute } from "@teyik0/furin";
import type { PluginRouteContext } from "@tofu/plugins/routes";
import { api, coreClient } from "./client-api";
import { AniListIcon } from "./components/icon";
import { AniListLibrary } from "./components/library";
import { readData } from "./lib/api-data";

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
          .loader(async () => {
            const [initialAniList, initialAutomation] = await Promise.all([
              api.anilist.get().then(readData),
              coreClient.automation.get().then(readData),
            ]);
            return { initialAniList, initialAutomation };
          })
          .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
          .page(AniListLibrary);
      },
      title: "AniList",
    },
  ] as const,
};
