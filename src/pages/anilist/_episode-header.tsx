import { useMutation } from "@teyik0/furin/client";
import { cn } from "cn";
import { useAtomValue } from "jotai";
import { ExternalLinkIcon, HeartIcon } from "lucide-react";
import { type CSSProperties, useState } from "react";
import type { AniListEntry, AniListMedia } from "../../api/modules/anilist/types";
import { ActionTooltip } from "../../components/action-tooltip";
import { AniListCover } from "../../components/anilist/cover";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button, buttonVariants } from "../../components/ui/button";
import { DialogDescription, DialogTitle } from "../../components/ui/dialog";
import type { useAniListEditor } from "../../hooks/use-anilist-editor";
import { useAsyncAction } from "../../hooks/use-async-action";
import { api } from "../../lib/client";
import { sessionAtom } from "../../state/workspace";
export function EpisodeHeader({
  entry,
  authenticated,
  model,
  available,
}: {
  entry: AniListMedia | AniListEntry;
  authenticated: boolean;
  available: number | null;
  model: ReturnType<typeof useAniListEditor>;
}) {
  const { editor, setEditor, loading: editorLoading } = model;
  // The host opens AniList itself only for its own window; elsewhere the link opens here.
  const hostNative = useAtomValue(sessionAtom)?.capabilities.hostNative === true;
  const openAnime = useMutation(api.anilist.open.post);
  const setFavourite = useMutation((enabled: boolean) =>
    api.anilist.entries({ mediaId: entry.mediaId }).favourite.put({ enabled })
  );
  const { busy, error, action } = useAsyncAction("Unable to update this anime");
  const [notice, setNotice] = useState<string | null>(null);
  const listed = "progress" in entry;
  const availableLabel = available ?? "—";
  return (
    <>
      {" "}
      {/* Without a banner, AniList-style blurred cover art keeps the header from looking empty. */}
      <div
        className="anime-modal-banner"
        data-source={entry.bannerImage ? "banner" : entry.coverImage ? "cover" : "none"}
        style={
          entry.bannerImage || entry.coverImage
            ? ({
                "--anime-banner": `url(${JSON.stringify(entry.bannerImage ?? entry.coverImage)})`,
              } as CSSProperties)
            : undefined
        }
      />
      <div className="anime-modal-heading">
        <div className="anime-modal-cover">
          <AniListCover src={entry.coverImage} />
        </div>
        <div className="anime-modal-title">
          <span className="anilist-eyebrow">
            {entry.format?.replaceAll("_", " ") ?? "ANIME"} · {entry.seasonYear ?? "—"}
          </span>
          <DialogTitle>{entry.title}</DialogTitle>
          <DialogDescription>
            <span>{listed ? entry.progress : "—"}</span> / {entry.episodes ?? "—"} episodes watched
            · {availableLabel} with releases
          </DialogDescription>
        </div>
        <div className="anime-modal-actions">
          <Button
            aria-label={editor?.isFavourite ? "Remove from favourites" : "Add to favourites"}
            aria-pressed={editor?.isFavourite ?? false}
            className="anime-favourite-button"
            disabled={
              busy ||
              editorLoading ||
              !authenticated ||
              !editor ||
              editor.isFavourite === null ||
              editor.isFavouriteBlocked === true
            }
            onClick={() =>
              action(async () => {
                const favouriteResult = await setFavourite.mutateAsync(!editor?.isFavourite);
                if (favouriteResult && "isFavourite" in favouriteResult) {
                  setEditor((current) =>
                    current ? { ...current, isFavourite: favouriteResult.isFavourite } : current
                  );
                  setNotice(
                    favouriteResult.isFavourite
                      ? "Added to AniList favourites."
                      : "Removed from AniList favourites."
                  );
                }
              })
            }
            size="icon-lg"
            title={authenticated ? "AniList favourite" : "Connect AniList to favourite this anime"}
            variant={editor?.isFavourite ? "secondary" : "outline"}
          >
            <HeartIcon fill={editor?.isFavourite ? "currentColor" : "none"} />
          </Button>
          {entry.siteUrl ? (
            <ActionTooltip>
              <a
                aria-label={`Open ${entry.title} on AniList`}
                className={cn(
                  buttonVariants({ size: "icon-lg", variant: "outline" }),
                  "anime-external-link"
                )}
                href={entry.siteUrl}
                onClick={(event) => {
                  if (!hostNative) {
                    return;
                  }
                  event.preventDefault();
                  const url = event.currentTarget.href;
                  action(async () => {
                    await openAnime.mutateAsync({ url });
                  });
                }}
                rel="noopener noreferrer"
                target="_blank"
              >
                <ExternalLinkIcon />
              </a>
            </ActionTooltip>
          ) : null}
        </div>
      </div>
      {error ? (
        <Alert>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <p className="anime-modal-notice" role="status">
          {notice}
        </p>
      ) : null}
    </>
  );
}
