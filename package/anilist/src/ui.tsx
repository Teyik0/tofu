import { defineRoute } from "@teyik0/furin";
import type { PluginRouteContext } from "@tofu/plugins/routes";
import { api, coreClient } from "./client-api";
import { AniListIcon } from "./components/icon";
import { AniListLibrary } from "./components/library";

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
            const [
              { data: initialAniList, error: anilistError },
              { data: initialAutomation, error: automationError },
            ] = await Promise.all([api.anilist.get(), coreClient.automation.get()]);
            if (anilistError) {
              throw anilistError;
            }
            if (automationError) {
              throw automationError;
            }
            return { initialAniList, initialAutomation };
          })
          .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
          .page(AniListLibrary);
      },
      title: "AniList",
    },
  ] as const,
};
