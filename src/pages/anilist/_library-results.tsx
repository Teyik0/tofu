import { AniListIcon } from "../../components/anilist/icon";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Skeleton } from "../../components/ui/skeleton";
import type { useAniListCatalog } from "../../hooks/use-anilist-catalog";
import type { useAsyncAction } from "../../hooks/use-async-action";
import type { AniListEntry, AniListMedia, AniListState } from "../../types";
import { AnimeCard, AnimeRow } from "./_library-cards";

type CatalogModel = ReturnType<typeof useAniListCatalog>;
type Actions = ReturnType<typeof useAsyncAction>;
export function LibraryResults({
  state,
  browsing,
  catalog,
  entries,
  actions,
  pollError,
  view,
  now,
  openMedia,
  openSettings,
}: {
  state: AniListState;
  browsing: boolean;
  catalog: CatalogModel;
  entries: (AniListMedia | AniListEntry)[];
  actions: Actions;
  pollError: string | null;
  view: "cards" | "compact" | "list";
  now: number;
  openMedia: (entry: AniListMedia) => void;
  openSettings: () => void;
}) {
  const error = actions.error ?? pollError;
  const { busy } = actions;
  const {
    error: currentCatalogError,
    loading: loadingCatalog,
    data: currentCatalog,
    end: catalogEnd,
    loadingMore,
    loadMore,
  } = catalog;
  return (
    <>
      {" "}
      {error || (!browsing && state.refreshError) || currentCatalogError ? (
        <Alert>
          <AlertDescription>
            {currentCatalogError ?? error ?? state.refreshError ?? "Unable to load AniList"}
          </AlertDescription>
        </Alert>
      ) : null}
      <LibraryContent
        entries={entries}
        filtered={browsing || state.entries.length > 0}
        loading={loadingCatalog || (!browsing && busy && !state.entries.length)}
        now={now}
        openMedia={openMedia}
        openSettings={openSettings}
        view={view}
      />
      {browsing && currentCatalog?.hasNextPage ? (
        <div className="flex min-h-10 items-center justify-center" ref={catalogEnd}>
          {currentCatalogError ? (
            <Button disabled={loadingMore} onClick={loadMore} variant="outline">
              {loadingMore ? "Loading…" : "Retry loading anime"}
            </Button>
          ) : (
            <span className="text-muted-foreground text-sm" role="status">
              {loadingMore ? "Loading more anime…" : ""}
            </span>
          )}
        </div>
      ) : null}
    </>
  );
}

function LibraryContent({
  loading,
  filtered,
  entries,
  view,
  now,
  openMedia,
  openSettings,
}: {
  loading: boolean;
  filtered: boolean;
  entries: (AniListMedia | AniListEntry)[];
  view: "cards" | "compact" | "list";
  now: number;
  openMedia: (entry: AniListMedia) => void;
  openSettings: () => void;
}) {
  if (loading) {
    return (
      <div aria-label="Loading anime" className="anime-grid" role="status">
        {["first", "second", "third", "fourth", "fifth"].map((placeholder) => (
          <Skeleton className="anime-cover-skeleton" key={placeholder} />
        ))}
      </div>
    );
  }
  if (!entries.length) {
    return (
      <Empty className="anilist-empty">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <AniListIcon />
          </EmptyMedia>
          <EmptyTitle>
            {filtered ? "No anime match your filters" : "Bring your AniList into Tofu"}
          </EmptyTitle>
          <EmptyDescription>
            {filtered
              ? "Try another title or clear a filter."
              : "Connect your account or enter a public username in Settings. Watching and Plan to Watch appear by default."}
          </EmptyDescription>
        </EmptyHeader>
        {filtered ? null : <Button onClick={() => openSettings()}>Connect AniList</Button>}
      </Empty>
    );
  }
  const Item = view === "list" ? AnimeRow : AnimeCard;
  return (
    <div className="anime-grid" data-view={view}>
      {entries.map((entry) => (
        <Item entry={entry} key={entry.mediaId} now={now} onOpen={() => openMedia(entry)} />
      ))}
    </div>
  );
}
