import { createContext } from "react";
import type { AniListState } from "../../api/modules/anilist/types";
import type { AutomationState } from "../../api/modules/automation/model";

export const aniListContext = createContext<{
  anilist: AniListState;
  automation: AutomationState;
  openSettings: () => void;
} | null>(null);
