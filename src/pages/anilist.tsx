import { defineRoute } from "@teyik0/furin";
import { AniListLibrary } from "../components/anilist-library";
import { api } from "../lib/client";
import { route as root } from "./root";

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .loader(async () => {
    const [anilist, automation] = await Promise.all([api.anilist.get(), api.automation.get()]);
    if (
      anilist.error ||
      !anilist.data ||
      !("entries" in anilist.data) ||
      automation.error ||
      !automation.data ||
      !("plugins" in automation.data)
    ) {
      throw new Error("Unable to load AniList");
    }
    return {
      initialAniList: anilist.data,
      initialAutomation: automation.data,
    };
  })
  .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
  .page(() => <AniListLibrary />);
