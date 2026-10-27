import type { AniListStatus } from "../server/types";
import { aniListStatusLabel } from "./status";

export function AniListStatusDot({ status }: { status: AniListStatus }) {
  const label = aniListStatusLabel(status);
  return (
    <span
      aria-label={label}
      className="anime-status-dot"
      data-status={status}
      role="img"
      title={label}
    />
  );
}
