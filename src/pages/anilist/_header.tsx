import { useMutation } from "@teyik0/furin/client";
import { Link } from "@teyik0/furin/link";
import { ChevronDownIcon, ListFilterIcon, UserRoundIcon } from "lucide-react";
import { useState } from "react";
import type { AniListState } from "../../api/modules/anilist/types";
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
import type { useAsyncAction } from "../../hooks/use-async-action";
import { api } from "../../lib/client";
import { useRefresh } from "../../lib/navigation";

type Actions = ReturnType<typeof useAsyncAction>;

interface AniListHeaderProps {
  actions: Actions;
  openSettings: () => void;
  path: string;
  state: AniListState;
}

export function AniListHeader({ state, actions, openSettings, path }: AniListHeaderProps) {
  const refresh = useRefresh();
  const savePreferences = useMutation(api.anilist.preferences.put);
  const { busy, action } = actions;
  const statuses = new Set(state.visibleStatuses);
  const [failedAvatar, setFailedAvatar] = useState<string | null>(null);
  const avatar = state.avatarImage;

  return (
    <header className="library-topbar anilist-page-header">
      <h1 className="sr-only">
        {path === "/anilist" ? "AniList library" : "AniList notifications"}
      </h1>
      <div className="library-title anilist-page-heading">
        <SidebarToggle className="mobile-sidebar-toggle" />
        <AniListIcon />
        <nav aria-label="AniList pages" className="anilist-navigation">
          <Link
            aria-current={path === "/anilist" ? "page" : undefined}
            className="anilist-navigation-link"
            to="/anilist"
          >
            Library
          </Link>
          <Link
            aria-current={path === "/anilist/notifications" ? "page" : undefined}
            className="anilist-navigation-link"
            to="/anilist/notifications"
          >
            Notifications
          </Link>
        </nav>
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
                  variant="ghost"
                >
                  <ListFilterIcon aria-hidden="true" data-icon="inline-start" />
                  <span id="anilist-lists-value">
                    {state.visibleStatuses.length
                      ? state.visibleStatuses.map(aniListStatusLabel).join(", ")
                      : "Browse catalog"}
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
        <ActionTooltip>
          <Button
            aria-label="AniList account settings"
            className="anilist-account-button"
            onClick={openSettings}
            size="icon-lg"
            variant="ghost"
          >
            {avatar && failedAvatar !== avatar ? (
              // biome-ignore lint/a11y/noNoninteractiveElementInteractions: This handles a failed profile image request.
              <img
                alt=""
                className="anilist-account-avatar"
                height={30}
                onError={() => setFailedAvatar(avatar)}
                src={avatar}
                width={30}
              />
            ) : (
              <UserRoundIcon />
            )}
          </Button>
        </ActionTooltip>
      </div>
    </header>
  );
}
