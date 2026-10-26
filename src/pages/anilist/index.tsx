import { defineRoute } from "@teyik0/furin";
import { useAtomValue } from "jotai";
import { useContext, useState } from "react";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useNow } from "@/hooks/use-now";
import { dashboardAtom } from "@/state/workspace";
import type { AniListCatalogFilters, AniListCatalogSort } from "../../api/modules/anilist/catalog";
import type { AniListMedia, AniListState } from "../../api/modules/anilist/types";
import type { AutomationState } from "../../api/modules/automation/model";
import type { LibraryState } from "../../api/modules/dashboard/projection";
import { browseRequest, catalogSortOptions } from "./_browse-filters";
import { aniListContext } from "./_context";
import { AniListEpisodeModal } from "./_episode-modal";
import { LibraryControls } from "./_library-controls";
import { noFilters, type SortValue, sortOptions, useLibraryFilters } from "./_library-filters";
import { LibraryResults } from "./_library-results";
import { useAniListCatalog } from "./hooks/_use-anilist-catalog";

export const route = defineRoute("/anilist")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
  .page(({ dashboard: loaded }) => {
    const context = useContext(aniListContext);
    if (!(context && loaded)) {
      return null;
    }
    return (
      <AniListLibrary
        automationState={context.automation}
        loaded={loaded}
        openSettings={context.openSettings}
        state={context.anilist}
      />
    );
  });

function AniListLibrary({
  loaded,
  state,
  automationState,
  openSettings,
}: {
  loaded: LibraryState;
  state: AniListState;
  automationState: AutomationState;
  openSettings: () => void;
}) {
  const dashboard = useAtomValue(dashboardAtom) ?? { ...loaded, detailHost: null, host: null };
  const actions = useAsyncAction("Unable to update AniList");
  const [search, setSearch] = useState("");
  const [listSort, setListSort] = useState<SortValue>("title");
  const [catalogSort, setCatalogSort] = useState<AniListCatalogSort>("trending");
  const browsing = state.visibleStatuses.length === 0;
  const sort = browsing ? catalogSort : listSort;
  const setSort = (value: SortValue) => {
    if (value !== "progress" && value !== "year" && browsing) {
      setCatalogSort(value);
    } else {
      setListSort(value);
    }
  };
  const [filters, setFilters] = useState(noFilters);
  const requestFilters: AniListCatalogFilters = {
    ...browseRequest(filters),
    formats: filters.formats,
    genres: filters.genres,
    search,
    season: filters.season === "any" ? undefined : filters.season,
    sort: catalogSort,
    year: filters.year === "any" ? undefined : Number(filters.year),
  };
  const catalog = useAniListCatalog(browsing, requestFilters);
  const now = useNow(60_000);
  const model = useLibraryFilters(
    state,
    catalog.options,
    browsing,
    search,
    sort,
    now,
    catalog.data,
    filters,
    setFilters
  );
  const [selected, setSelected] = useState<AniListMedia | null>(null);
  const selectedEntry = selected
    ? (state.entries.find((entry) => entry.mediaId === selected.mediaId) ?? selected)
    : null;
  const [view, setView] = useState<"cards" | "compact" | "list">("cards");
  return (
    <>
      <div className="anilist-page-body">
        <LibraryControls
          availableSorts={browsing ? catalogSortOptions : sortOptions}
          browsing={browsing}
          catalog={catalog}
          model={model}
          search={search}
          setSearch={setSearch}
          setSort={setSort}
          setView={setView}
          sort={sort}
          view={view}
        />
        <LibraryResults
          actions={actions}
          browsing={browsing}
          catalog={catalog}
          entries={model.entries}
          now={now}
          openMedia={setSelected}
          openSettings={openSettings}
          state={state}
          view={view}
        />
      </div>
      {selectedEntry ? (
        <AniListEpisodeModal
          authenticated={state.authenticated}
          automation={automationState}
          close={() => setSelected(null)}
          dashboard={dashboard}
          entry={selectedEntry}
          key={selectedEntry.mediaId}
        />
      ) : null}
    </>
  );
}
