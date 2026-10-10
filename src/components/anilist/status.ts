import type { AniListStatus } from "../../types";

export const aniListStatusLabels: { value: AniListStatus; label: string }[] = [
  { label: "Watching", value: "CURRENT" },
  { label: "Plan to Watch", value: "PLANNING" },
  { label: "Completed", value: "COMPLETED" },
  { label: "Paused", value: "PAUSED" },
  { label: "Dropped", value: "DROPPED" },
  { label: "Rewatching", value: "REPEATING" },
];
export function aniListStatusLabel(status: AniListStatus) {
  return aniListStatusLabels.find((item) => item.value === status)?.label ?? status;
}
