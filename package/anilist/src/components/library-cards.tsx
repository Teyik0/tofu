import type { PreviewCard } from "@base-ui/react/preview-card";
import { ZapIcon } from "lucide-react";
import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "../../../ui/src/ui/hover-card";
import type { AniListEntry, AniListMedia } from "../server/types";
import { AniListCover } from "./cover";
import { formatLabel } from "./library-filters";
import { aniListMediaColors } from "./media-colors";
import { AniListMediaInfo, animeAiringLabel } from "./media-info";
import { aniListStatusLabel } from "./status";
import { AniListStatusDot } from "./status-dot";

export function AnimeRow({
  entry,
  onOpen,
  now,
}: {
  entry: AniListMedia | AniListEntry;
  onOpen: () => void;
  now: number;
}) {
  return (
    <button
      aria-description={"status" in entry ? aniListStatusLabel(entry.status) : undefined}
      aria-label={`View episodes for ${entry.title}`}
      className="anime-row"
      onClick={onOpen}
      type="button"
    >
      <span className="anime-row-cover">
        <AniListCover src={entry.coverImage} />
      </span>
      <span className="anime-row-title">
        <strong>
          {"status" in entry ? <AniListStatusDot status={entry.status} /> : null}
          {entry.title}
        </strong>
        <small>{entry.genres.slice(0, 3).join(" · ") || "—"}</small>
      </span>
      <span className="anime-row-meta">
        {entry.format ? formatLabel(entry.format) : "—"} · {entry.seasonYear ?? "—"}
      </span>
      <span className="anime-row-airing">{animeAiringLabel(entry, now)}</span>
      {"progress" in entry ? (
        <span className="anime-row-progress">
          <span>
            {entry.progress} / {entry.episodes ?? "—"}
          </span>
          <span className="anime-row-track">
            <i
              style={{
                width: `${entry.episodes ? Math.min(100, (entry.progress / entry.episodes) * 100) : 0}%`,
              }}
            />
          </span>
        </span>
      ) : (
        <span>
          {entry.averageScore === null || entry.averageScore === undefined
            ? "—"
            : `${entry.averageScore}%`}
        </span>
      )}
      {"automationId" in entry && entry.automationId ? (
        <ZapIcon aria-label="Custom automation" />
      ) : (
        <span />
      )}
    </button>
  );
}

export function AnimeCard({
  entry,
  onOpen,
  now,
}: {
  entry: AniListMedia | AniListEntry;
  onOpen: () => void;
  now: number;
}) {
  const previewActions = useRef<PreviewCard.Root.Actions | null>(null);
  const scrollController = useRef<AbortController | null>(null);
  useEffect(() => () => scrollController.current?.abort(), []);
  const closePreview = () => flushSync(() => previewActions.current?.close());
  return (
    <HoverCard
      actionsRef={previewActions}
      onOpenChange={(open) => {
        scrollController.current?.abort();
        scrollController.current = null;
        if (open) {
          const controller = new AbortController();
          scrollController.current = controller;
          window.addEventListener("scroll", closePreview, {
            capture: true,
            signal: controller.signal,
          });
        }
      }}
    >
      <HoverCardTrigger
        closeDelay={0}
        delay={0}
        onMouseLeave={closePreview}
        render={
          <button
            aria-description={
              "status" in entry
                ? `${aniListStatusLabel(entry.status)} · ${entry.progress} / ${entry.episodes ?? "—"} watched`
                : undefined
            }
            aria-label={`View episodes for ${entry.title}`}
            className="anime-card"
            onClick={onOpen}
            style={aniListMediaColors(entry.coverColor)}
            type="button"
          />
        }
      >
        <div className="anime-card-cover">
          <AniListCover src={entry.coverImage} />
          {"automationId" in entry && entry.automationId ? (
            <span className="anime-card-automation" title="Custom automation">
              <ZapIcon aria-label="Custom automation" />
            </span>
          ) : null}
        </div>
        <strong>
          {"status" in entry ? <AniListStatusDot status={entry.status} /> : null}
          {entry.title}
        </strong>
      </HoverCardTrigger>
      <HoverCardContent
        align="start"
        alignOffset={5}
        className="anime-preview-popup"
        side="right"
        sideOffset={18}
      >
        <AniListMediaInfo media={entry} now={now} />
      </HoverCardContent>
    </HoverCard>
  );
}
