import { usePluginHost } from "@tofu/plugins/client";
import type {
  AniListCatalogFilters,
  AniListCatalogSort,
  AniListMedia,
  AniListState,
  AutomationState,
  DashboardState,
} from "@tofu/plugins/domain";
import { useAsyncAction } from "@tofu/ui/use-async-action";
import { useNow } from "@tofu/ui/use-now";
import { useState } from "react";
import { useAniListCatalog } from "../hooks/use-anilist-catalog";
import { useAuthorizationPolling } from "../hooks/use-authorization-polling";
import { browseRequest, catalogSortOptions } from "./browse-filters";
import { AniListEpisodeModal } from "./episode-modal";
import { LibraryControls } from "./library-controls";
import { noFilters, type SortValue, sortOptions, useLibraryFilters } from "./library-filters";
import { LibraryHeader } from "./library-header";
import { LibraryResults } from "./library-results";
import { LibrarySettings } from "./library-settings";

export const AniListLibrary = ({
  dashboard,
  initialAniList: state,
  initialAutomation: automationState,
}: {
  dashboard: DashboardState;
  initialAniList: AniListState;
  initialAutomation: AutomationState;
}) => {
  const { refresh } = usePluginHost();
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
  const [settings, setSettings] = useState(false);
  const pollError = useAuthorizationPolling(state.authorizationPending && !settings, refresh);
  const selectedEntry = selected
    ? (state.entries.find((entry) => entry.mediaId === selected.mediaId) ?? selected)
    : null;
  const plugin = automationState.plugins.find((item) => item.id === "anilist");
  const canLoad = Boolean(plugin?.enabled && (plugin.hasApiKey || state.userName));
  const [view, setView] = useState<"cards" | "compact" | "list">("cards");
  return (
    <main className="anilist-library">
      <LibraryHeader
        actions={actions}
        browsing={browsing}
        canLoad={canLoad}
        catalog={catalog}
        openSettings={() => setSettings(true)}
        state={state}
      />
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
          openSettings={() => setSettings(true)}
          pollError={pollError}
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
      {settings ? (
        <LibrarySettings
          automationState={automationState}
          close={() => setSettings(false)}
          dashboard={dashboard}
          state={state}
        />
      ) : null}
    </main>
  );
};
