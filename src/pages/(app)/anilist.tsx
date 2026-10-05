import { defineRoute } from "@teyik0/furin";
import { AniListLibrary } from "../../components/anilist-library";
import { route as app } from "./_route";

export const route = defineRoute()
  .config({ layout: app, mode: "ssr" })
  .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
  .page(AniListLibrary);
