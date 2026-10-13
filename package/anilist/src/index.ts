import { definePlugin } from "@tofu/plugins";
import { type AniListApiDependencies, createAniListApi } from "./server/api";
import { ui } from "./ui";

export function createAniListPlugin(dependencies: AniListApiDependencies) {
  return definePlugin({
    api: () => createAniListApi(dependencies, "/api"),
    auth: { kind: "custom", label: "Connect your AniList account" },
    description: "Your anime library, watched episodes, and release automations.",
    id: "anilist",
    name: "AniList",
    setup({ scope }) {
      scope.onDispose(() => dependencies.application().anilist.suspend());
    },
    ui,
    version: "0.0.0",
  });
}
