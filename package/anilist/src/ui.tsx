import { defineRoute } from "@teyik0/furin";
import { BellIcon } from "lucide-react";
import { AniListIcon } from "./components/icon";
import { AniListLayout } from "./pages/layout";
import { AniListLibraryPage } from "./pages/library";
import { AniListNotificationsPage } from "./pages/notifications";

declare module "@teyik0/furin/routes" {
  interface FileRoutes {
    "/__tofu_anilist/_route": {
      kind: "layout";
      parent: undefined;
      pathParams: Record<never, never>;
    };
  }
}

export const ui = {
  layout: defineRoute("/__tofu_anilist/_route")
    .config({ mode: "ssr" })
    // Privileged account data is loaded by authorized browsers after mount.
    .loader(() => ({ requestedAt: Date.now() }))
    .layout(AniListLayout),
  pages: [
    {
      availableWhenDisabled: true,
      icon: AniListIcon,
      id: "library",
      path: "/anilist",
      pinnable: true,
      route: defineRoute("/__tofu_plugin")
        .config({ mode: "ssr" })
        .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
        .page(AniListLibraryPage),
      title: "AniList",
    },
    {
      availableWhenDisabled: true,
      icon: BellIcon,
      id: "notifications",
      path: "/anilist/notifications",
      pinnable: true,
      route: defineRoute("/__tofu_plugin")
        .config({ mode: "ssr" })
        .head(() => ({ meta: [{ title: "Notifications · AniList — Tofu" }] }))
        .page(AniListNotificationsPage),
      title: "AniList notifications",
    },
  ] as const,
};
