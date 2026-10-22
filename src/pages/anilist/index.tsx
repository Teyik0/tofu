import { defineRoute } from "@teyik0/furin";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { AccessRequired } from "@/components/access-required";
import { Skeleton } from "@/components/ui/skeleton";
import { useAniListCatalog } from "@/hooks/use-anilist-catalog";
import { useAsyncAction } from "@/hooks/use-async-action";
import { useAuthorizationPolling } from "@/hooks/use-authorization-polling";
import { useNow } from "@/hooks/use-now";
import { errorMessage } from "@/lib/errors";
import { useRefresh } from "@/lib/navigation";
import { dashboardAtom, sessionAtom } from "@/state/workspace";
import type { AniListCatalogFilters, AniListCatalogSort } from "../../api/modules/anilist/catalog";
import type { AniListMedia, AniListState } from "../../api/modules/anilist/types";
import type { AutomationState } from "../../api/modules/automation/model";
import type { LibraryState } from "../../api/modules/dashboard/projection";
import { api } from "../../lib/client";
import { browseRequest, catalogSortOptions } from "./_browse-filters";
import { AniListEpisodeModal } from "./_episode-modal";
import { LibraryControls } from "./_library-controls";
import { noFilters, type SortValue, sortOptions, useLibraryFilters } from "./_library-filters";
import { LibraryHeader } from "./_library-header";
import { LibraryResults } from "./_library-results";
import { LibrarySettings } from "./_library-settings";

export const route = defineRoute("/anilist")
  .config({ mode: "ssr" })
  // The AniList account belongs to this server's owner: it is read by authorized browsers only.
  .loader(() => ({ requestedAt: Date.now() }))
  .head(() => ({ meta: [{ title: "AniList — Tofu" }] }))
  .page(({ dashboard: loaded, requestedAt }) => {
    const session = useAtomValue(sessionAtom);
    const administer = session?.capabilities.administer === true;
    const [loadedState, setLoadedState] = useState<
      { anilist: AniListState; automation: AutomationState; error: null } | { error: string } | null
    >(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The loader epoch invalidates privileged browser reads after a successful route refresh.
    useEffect(() => {
      if (!administer) {
        return;
      }
      let active = true;
      const load = async () => {
        const [anilist, automation] = await Promise.all([api.anilist.get(), api.automation.get()]);
        if (!active) {
          return;
        }
        if (anilist.error || automation.error) {
          setLoadedState({
            error: errorMessage(anilist.error ?? automation.error, "Unable to load AniList"),
          });
          return;
        }
        setLoadedState({ anilist: anilist.data, automation: automation.data, error: null });
      };
      void load();
      return () => {
        active = false;
      };
    }, [administer, requestedAt]);
    if (session && !administer) {
      return (
        <main className="anilist-library">
          <AccessRequired
            description={`AniList on ${session.server.name} belongs to its owner. Your playback here never changes their AniList account.`}
            title="AniList is managed by this server's owner"
          />
        </main>
      );
    }
    if (loadedState && loadedState.error !== null) {
      return (
        <main className="anilist-library">
          <AccessRequired description={loadedState.error} title="AniList is unavailable" />
        </main>
      );
    }
    if (!loadedState) {
      return (
        <main aria-busy="true" aria-label="Loading AniList" className="anilist-library">
          <header className="library-topbar anilist-page-header">
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-9 w-64" />
          </header>
          <div className="anilist-page-body">
            <div className="anilist-filters">
              {["search", "genres", "year", "season", "format"].map((filter) => (
                <div className="anilist-filter" key={filter}>
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="h-[42px] w-full" />
                </div>
              ))}
              <Skeleton className="anilist-advanced-toggle h-[42px] w-full" />
            </div>
            <div className="anilist-results-bar">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="ml-auto h-8 w-48" />
            </div>
            <div className="anime-grid">
              {["first", "second", "third", "fourth", "fifth"].map((card) => (
                <Skeleton className="anime-cover-skeleton" key={card} />
              ))}
            </div>
          </div>
        </main>
      );
    }
    if (!loaded) {
      return null;
    }
    return (
      <AniListLibrary
        automationState={loadedState.automation}
        loaded={loaded}
        state={loadedState.anilist}
      />
    );
  });

function AniListLibrary({
  loaded,
  state,
  automationState,
}: {
  loaded: LibraryState;
  state: AniListState;
  automationState: AutomationState;
}) {
  const dashboard = useAtomValue(dashboardAtom) ?? { ...loaded, detailHost: null, host: null };
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
}
