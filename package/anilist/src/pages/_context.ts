import { createContext } from "react";
import type { AutomationState } from "../../../plugins/src/automation-model";
import type { AniListState } from "../server/types";

export const aniListContext = createContext<{
  anilist: AniListState;
  automation: AutomationState;
  openSettings: () => void;
} | null>(null);
