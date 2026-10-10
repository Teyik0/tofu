import type { AniListDate, AniListMedia } from "../../types";
import { Badge } from "../ui/badge";

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
  return releaseLabel(media.releaseDate) ?? (media.seasonYear ? String(media.seasonYear) : "—");
}
export function AniListMediaInfo({ media, now }: { media: AniListMedia; now: number }) {
  return (
    <div className="anime-preview">
      <div className="anime-preview-heading">
        <strong>{animeAiringLabel(media, now)}</strong>
        <span
          aria-label={`Average score: ${media.averageScore === null || media.averageScore === undefined ? "unknown" : `${media.averageScore}%`}`}
          role="img"
        >
          {media.averageScore === null || media.averageScore === undefined
            ? "—"
            : `${media.averageScore}%`}
        </span>
      </div>
      <div className="anime-preview-details">
        <strong>{media.studios?.join(" · ") || "—"}</strong>
        <span>
          {media.format ? (formats[media.format] ?? media.format) : "—"} ·{" "}
          {media.episodes === null ? "— episodes" : `${media.episodes} episodes`}
        </span>
      </div>
      <div className="anime-preview-genres">
        {media.genres.slice(0, 3).map((genre) => (
          <Badge key={genre} variant="secondary">
            {genre}
          </Badge>
        ))}
      </div>
    </div>
  );
}
