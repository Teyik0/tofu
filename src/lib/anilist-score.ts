import type { AniListScoreFormat } from "../api/modules/anilist/types";

export const aniListScoreScales: { [Format in AniListScoreFormat]: { max: number; step: number } } =
  {
    POINT_3: { max: 3, step: 1 },
    POINT_5: { max: 5, step: 1 },
    POINT_10: { max: 10, step: 1 },
    POINT_10_DECIMAL: { max: 10, step: 0.1 },
    POINT_100: { max: 100, step: 1 },
  };
