import { useMutation } from "@teyik0/furin/client";
import { ChevronDownIcon, RefreshCwIcon, SettingsIcon } from "lucide-react";
import { ActionTooltip } from "../../components/action-tooltip";
import { AniListIcon } from "../../components/anilist/icon";
import { aniListStatusLabel, aniListStatusLabels } from "../../components/anilist/status";
import { SidebarToggle } from "../../components/sidebar-toggle";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import type { useAniListCatalog } from "../../hooks/use-anilist-catalog";
import type { useAsyncAction } from "../../hooks/use-async-action";
import { api } from "../../lib/client";
import { useRefresh } from "../../lib/navigation";
import type { AniListState } from "../../types";

type CatalogModel = ReturnType<typeof useAniListCatalog>;
type Actions = ReturnType<typeof useAsyncAction>;

interface LibraryHeaderProps {
  actions: Actions;
  browsing: boolean;
  canLoad: boolean;
  catalog: CatalogModel;
  openSettings: () => void;
  state: AniListState;
}

export function LibraryHeader({
  state,
  browsing,
  catalog,
  actions,
  canLoad,
  openSettings,
}: LibraryHeaderProps) {
  const refresh = useRefresh();
  const loadList = useMutation(api.anilist.list.post);
  const savePreferences = useMutation(api.anilist.preferences.put);
  const { busy, action } = actions;
  const statuses = new Set(state.visibleStatuses);
  const loadingCatalog = catalog.loading;
  const accountName = state.connectedUser || state.userName || null;

  return (
    <header className="library-topbar anilist-page-header">
      <div className="library-title anilist-page-heading">
        <SidebarToggle className="mobile-sidebar-toggle" />
        <AniListIcon />
        <h1>AniList</h1>
      </div>
      <div className="anilist-header-actions">
        <div className="anilist-list-selector">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  aria-label={`Lists ${state.visibleStatuses.map(aniListStatusLabel).join(", ") || "None"}`}
                  className="anilist-status-filter"
                  size="lg"
                  variant="outline"
                >
                  <span aria-hidden="true" className="anilist-status-filter-label">
                    Lists
                  </span>
                  <span id="anilist-lists-value">
                    {state
                      ? state.visibleStatuses.length
                        ? state.visibleStatuses.map(aniListStatusLabel).join(", ")
                        : "None"
                      : "Loading…"}
                  </span>
                  <ChevronDownIcon data-icon="inline-end" />
                </Button>
              }
            />
            <DropdownMenuContent align="start" className="anilist-genre-menu" sideOffset={10}>
              <DropdownMenuGroup>
                <DropdownMenuCheckboxItem
                  checked={!state.visibleStatuses.length}
                  disabled={busy || !state}
                  onCheckedChange={() =>
                    action(async () => {
                      await savePreferences.mutateAsync({ visibleStatuses: [] });
                      await refresh();
                    })
                  }
                >
                  None
                </DropdownMenuCheckboxItem>
                {aniListStatusLabels.map(({ value, label }) => (
                  <DropdownMenuCheckboxItem
                    checked={statuses.has(value)}
                    disabled={busy || !state}
                    key={value}
                    onCheckedChange={(checked) => {
                      if (state) {
                        action(async () => {
                          await savePreferences.mutateAsync({
                            visibleStatuses: checked
                              ? [...state.visibleStatuses, value]
                              : state.visibleStatuses.filter((item) => item !== value),
                          });
                          await refresh();
                        });
                      }
                    }}
                  >
                    {label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <span aria-hidden="true" className="toolbar-divider" />
        <ActionTooltip>
          <Button
            aria-label="Sync list"
            disabled={browsing ? loadingCatalog : busy || !canLoad}
            onClick={() =>
              browsing
                ? catalog.reload()
                : action(async () => {
                    await loadList.mutateAsync();
                  })
            }
            size="icon-lg"
            variant="outline"
          >
            <RefreshCwIcon className={busy ? "motion-safe:animate-spin" : undefined} />
          </Button>
        </ActionTooltip>
        {/* The account doubles as the settings entry point, like AniList's avatar menu. */}
        <ActionTooltip>
          {accountName ? (
            <Button
              aria-label={`AniList settings, ${accountName}`}
              className="anilist-account-button"
              onClick={() => openSettings()}
              size="lg"
              variant="outline"
            >
              <span aria-hidden="true" className="anilist-account-avatar">
                {accountName.slice(0, 1).toUpperCase()}
              </span>
              <span className="anilist-account-name">{accountName}</span>
              <SettingsIcon aria-hidden="true" data-icon="inline-end" />
            </Button>
          ) : (
            <Button
              aria-label="AniList settings"
              className="anilist-account-button"
              onClick={() => openSettings()}
              size="icon-lg"
              variant="outline"
            >
              <SettingsIcon />
            </Button>
          )}
        </ActionTooltip>
      </div>
    </header>
  );
}
