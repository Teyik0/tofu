import { defineRoute } from "@teyik0/furin";
import type { PluginRouteContext } from "@tofu/plugins/routes";
import { useContext } from "react";
import { AniListIcon } from "./components/icon";
import { AniListLibrary } from "./components/library";
import { aniListContext } from "./pages/_context";

export const ui = {
  pages: [
    {
      availableWhenDisabled: true,
      icon: AniListIcon,
      id: "library",
      path: "/anilist",
      pinnable: true,
      route(_context: PluginRouteContext) {
        return defineRoute("/__tofu_plugin")
          .config({ mode: "ssr" })
          .page(() => {
            const context = useContext(aniListContext);
            return context ? (
              <AniListLibrary
                automationState={context.automation}
                openSettings={context.openSettings}
                state={context.anilist}
              />
            ) : null;
          });
      },
      title: "AniList",
    },
  ] as const,
};
