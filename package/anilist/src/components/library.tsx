import { usePluginHost } from "@tofu/plugins/client";
import { useState } from "react";
import type { AutomationState } from "../../../plugins/src/automation-model";
import { useAsyncAction } from "../../../ui/src/use-async-action";
import { useNow } from "../../../ui/src/use-now";
import { useAniListCatalog } from "../hooks/use-anilist-catalog";
import type { AniListCatalogFilters, AniListCatalogSort } from "../server/catalog";
import type { AniListMedia, AniListState } from "../server/types";
import { browseRequest, catalogSortOptions } from "./browse-filters";
import { AniListEpisodeModal } from "./episode-modal";
import { LibraryControls } from "./library-controls";
import { noFilters, type SortValue, sortOptions, useLibraryFilters } from "./library-filters";
import { LibraryResults } from "./library-results";

export function AniListLibrary({
  state,
  automationState,
  openSettings,
}: {
  state: AniListState;
  automationState: AutomationState;
  openSettings: () => void;
}) {
  const { dashboard } = usePluginHost();
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
