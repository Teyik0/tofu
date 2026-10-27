import { defineRoute } from "@teyik0/furin";
import { AniListLibrary } from "@tofu/anilist/components/library";
import { useContext } from "react";
import { aniListContext } from "../../../../../package/anilist/src/pages/_context";

export const route = defineRoute("/anilist")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
  .page(({ dashboard: loaded }) => {
    const context = useContext(aniListContext);
    if (!(context && loaded)) {
      return null;
    }
    return (
      <AniListLibrary
        automationState={context.automation}
        openSettings={context.openSettings}
        state={context.anilist}
      />
    );
  });
