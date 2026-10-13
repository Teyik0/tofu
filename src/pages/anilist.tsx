import { defineRoute } from "@teyik0/furin";
import { useState } from "react";
import { browseRequest, catalogSortOptions } from "@/components/anilist/browse-filters";
import { AniListEpisodeModal } from "@/components/anilist/episode-modal";
import { LibraryControls } from "@/components/anilist/library-controls";
import {
  noFilters,
  type SortValue,
  sortOptions,
  useLibraryFilters,
} from "@/components/anilist/library-filters";
import { LibraryHeader } from "@/components/anilist/library-header";
import { LibraryResults } from "@/components/anilist/library-results";
import { LibrarySettings } from "@/components/anilist/library-settings";
import { useAniListCatalog } from "@/hooks/use-anilist-catalog";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useAuthorizationPolling } from "@/hooks/use-authorization-polling";
import { useNow } from "@/hooks/use-now";
import { useRefresh } from "@/lib/navigation";
import type { AniListCatalogFilters, AniListCatalogSort, AniListMedia } from "@/types";
import { api } from "../lib/client";
import { route as root } from "./root";

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .loader(async () => {
    const [anilist, automation] = await Promise.all([api.anilist.get(), api.automation.get()]);
    if (anilist.error) {
      throw anilist.error;
    }
    if (automation.error) {
      throw automation.error;
    }
    return {
      initialAniList: anilist.data,
      initialAutomation: automation.data,
    };
  })
  .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
  .page(({ dashboard, initialAniList: state, initialAutomation: automationState }) => {
    const refresh = useRefresh();
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
  });
