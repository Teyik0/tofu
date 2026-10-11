import { FrownIcon, MehIcon, SmileIcon } from "lucide-react";
import type { AniListDate, AniListEntry, AniListMedia } from "../../types";
import { Badge } from "../ui/badge";
import { aniListMediaColors } from "./media-colors";
import { aniListStatusLabel } from "./status";

const seasons = { FALL: "Fall", SPRING: "Spring", SUMMER: "Summer", WINTER: "Winter" };
const formats: Record<string, string> = {
  MOVIE: "Movie",
  MUSIC: "Music",
  ONA: "ONA",
  OVA: "OVA",
  SPECIAL: "Special",
  TV: "TV Show",
  TV_SHORT: "TV Short",
};
function releaseLabel(date: AniListDate | null | undefined) {
  if (!date?.year) {
    return null;
  }
  if (!date.month) {
    return String(date.year);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
    ...(date.day ? ({ day: "numeric" } as const) : {}),
    timeZone: "UTC",
  }).format(new Date(Date.UTC(date.year, date.month - 1, date.day ?? 1)));
}
export function animeAiringLabel(media: AniListMedia, now: number) {
  const next = media.nextAiringEpisode;
  if (next) {
    const seconds = Math.max(0, next.airingAt - now / 1000);
    const count =
      seconds >= 86_400
        ? Math.floor(seconds / 86_400)
        : seconds >= 3600
          ? Math.floor(seconds / 3600)
          : Math.floor(seconds / 60);
    const unit = seconds >= 86_400 ? "day" : seconds >= 3600 ? "hour" : "minute";
    return count > 0
      ? `Ep ${next.episode} airing in ${count} ${unit}${count === 1 ? "" : "s"}`
      : `Ep ${next.episode} airing soon`;
  }
  const start = media.releaseDate?.year;
  const end = media.endDate?.year;
  if (media.airingStatus === "FINISHED" && start && end && start !== end) {
    return `${start} – ${end}`;
  }
  if (media.airingStatus === "RELEASING" && start) {
    return `Airing since ${start}`;
  }
  if (media.season && media.seasonYear) {
    return `${seasons[media.season]} ${media.seasonYear}`;
  }
  return (
    releaseLabel(media.releaseDate) ??
    (media.seasonYear
      ? String(media.seasonYear)
      : media.airingStatus === "NOT_YET_RELEASED"
        ? "TBA"
        : "—")
  );
}
export function AniListMediaInfo({
  media,
  now,
}: {
  media: AniListMedia | AniListEntry;
  now: number;
}) {
  const upcoming = media.airingStatus === "NOT_YET_RELEASED";
  const score = media.averageScore ?? null;
  const sentiment =
    score === null ? null : score >= 75 ? "positive" : score >= 60 ? "neutral" : "negative";
  const ScoreIcon =
    sentiment === "positive" ? SmileIcon : sentiment === "neutral" ? MehIcon : FrownIcon;
  return (
    <div className="anime-preview" style={aniListMediaColors(media.coverColor)}>
      <div className="anime-preview-heading">
        <strong>{animeAiringLabel(media, now)}</strong>
        {upcoming ? null : (
          <span
            aria-label={`Average score: ${score === null ? "unknown" : `${score}%`}`}
            className="anime-preview-score"
            data-sentiment={sentiment}
            role="img"
          >
            {score === null ? null : <ScoreIcon aria-hidden="true" />}
            {score === null ? "—" : `${score}%`}
          </span>
        )}
      </div>
      {upcoming ? null : (
        <div className="anime-preview-details">
          <strong>{media.studios?.join(" · ") || "—"}</strong>
          <span>
            {media.format ? (formats[media.format] ?? media.format) : "—"} ·{" "}
            {media.episodes === null ? "— episodes" : `${media.episodes} episodes`}
          </span>
        </div>
      )}
      {media.genres.length ? (
        <div className="anime-preview-genres">
          {media.genres.slice(0, 3).map((genre) => (
            <Badge key={genre} variant="secondary">
              {genre}
            </Badge>
          ))}
        </div>
      ) : null}
      {!upcoming && "status" in media ? (
        <div className="anime-preview-library">
          <span>{aniListStatusLabel(media.status)}</span>
          <span>
            {media.progress} / {media.episodes ?? "—"} watched
          </span>
        </div>
      ) : null}
    </div>
  );
}
