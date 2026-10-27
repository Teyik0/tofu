import { useContext } from "react";
import { AniListLibrary } from "../components/library";
import { aniListContext } from "./_context";

export function AniListLibraryPage() {
  const context = useContext(aniListContext);
  return context ? (
    <AniListLibrary
      automationState={context.automation}
      openSettings={context.openSettings}
      state={context.anilist}
    />
  ) : null;
}
