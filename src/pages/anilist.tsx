import { defineRoute } from "@teyik0/furin";
import { AniListLibrary } from "../components/anilist/library";
import { readData } from "../lib/api-data";
import { api } from "../lib/client";
import { route as root } from "./root";

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .loader(async () => {
    const [anilist, automation] = await Promise.all([
      api.anilist.get().then(readData),
      api.automation.get().then(readData),
    ]);
    return {
      initialAniList: anilist,
      initialAutomation: automation,
    };
  })
  .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
  .page(() => <AniListLibrary />);
