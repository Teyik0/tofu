import { Link, useRouter } from "@teyik0/furin/link";
import { FolderIcon, PencilIcon, PlugIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { memo } from "react";
import type { DashboardState } from "../types";
import { ActionTooltip } from "./action-tooltip";
import { AniListIcon } from "./anilist-icon";
import { DestinationIcon } from "./destination-icon";
import { DestinationMenu } from "./destination-menu";
import { bytes } from "./format";
import { Logo } from "./icon";
import type { ModalKind } from "./modal";
import { SidebarToggle } from "./sidebar-toggle";
import { Button } from "./ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";
import { SidebarUpdateAction } from "./updates";

export const DestinationSidebar = memo(
  function DestinationSidebarView({
    data,
    active,
    open,
  }: {
    data: DashboardState | null;
    active: string | null;
    open: (modal: ModalKind) => void;
  }) {
    const router = useRouter();
    return (
      <Sidebar className="destination-sidebar" collapsible="icon" variant="inset">
        <SidebarHeader>
          <div className="sidebar-brand-row">
            <Link
              aria-current={active === null ? "page" : undefined}
              aria-label="All torrents"
              className="sidebar-brand"
              resetScroll={false}
              title="All torrents"
              to="/library/all"
            >
              <Logo />
              <span aria-hidden="true">Tofu</span>
            </Link>
            <SidebarToggle />
          </div>
          <nav aria-label="Sidebar shortcuts">
            <SidebarMenu className="sidebar-shortcuts">
              <SidebarMenuItem>
                <ActionTooltip>
                  <Link
                    aria-current={active === "anilist" ? "page" : undefined}
                    aria-label="AniList"
                    className="sidebar-shortcut sidebar-app-shortcut"
                    data-sidebar="menu-button"
                    resetScroll={false}
                    to="/anilist"
                  >
                    <AniListIcon />
                  </Link>
                </ActionTooltip>
              </SidebarMenuItem>
              {data?.destinations
                .filter((destination) => destination.pinned)
                .map((destination) => (
                  <SidebarMenuItem key={destination.id}>
                    <DestinationMenu destination={destination} open={open}>
                      <SidebarMenuButton
                        aria-label={destination.name}
                        className="sidebar-shortcut"
                        isActive={active === destination.id}
                        render={
                          <Link
                            aria-current={active === destination.id ? "page" : undefined}
                            params={{ id: destination.id }}
                            resetScroll={false}
                            to="/library/destinations/:id"
                          />
                        }
                        tooltip={{ children: destination.name, hidden: false }}
                      >
                        <DestinationIcon name={destination.icon} />
                      </SidebarMenuButton>
                    </DestinationMenu>
                  </SidebarMenuItem>
                ))}
            </SidebarMenu>
          </nav>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>DESTINATIONS</SidebarGroupLabel>
            <ActionTooltip>
              <SidebarGroupAction
                aria-label="Create a tab"
                disabled={!data}
                onClick={() => open({ destination: null, type: "destination" })}
              >
                <PlusIcon />
              </SidebarGroupAction>
            </ActionTooltip>
            <SidebarMenu aria-label="Destination tabs">
              {data?.destinations
                .filter((destination) => !destination.pinned)
                .map((destination) => (
                  <SidebarMenuItem key={destination.id}>
                    <DestinationMenu destination={destination} open={open}>
                      <SidebarMenuButton
                        aria-label={destination.name}
                        className="sidebar-thread-link"
                        isActive={active === destination.id}
                        render={
                          <Link
                            aria-current={active === destination.id ? "page" : undefined}
                            params={{ id: destination.id }}
                            resetScroll={false}
                            to="/library/destinations/:id"
                          />
                        }
                        title={destination.downloadPath}
                        tooltip={destination.name}
                      >
                        <DestinationIcon name={destination.icon} />
                        <span>{destination.name}</span>
                      </SidebarMenuButton>
                    </DestinationMenu>
                    <SidebarMenuBadge>
                      {
                        data.torrents.filter((torrent) => torrent.destinationId === destination.id)
                          .length
                      }
                    </SidebarMenuBadge>
                    <ActionTooltip>
                      <SidebarMenuAction
                        aria-label={`Edit tab ${destination.name}`}
                        onClick={() => open({ destination, type: "destination" })}
                        showOnHover
                      >
                        <PencilIcon />
                      </SidebarMenuAction>
                    </ActionTooltip>
                  </SidebarMenuItem>
                ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <div className="sidebar-disk">
            <FolderIcon />
            <div>
              <span>Available space</span>
              <strong>{bytes(data?.session.freeSpace ?? null)}</strong>
            </div>
          </div>
          <fieldset aria-label="Sidebar actions" className="sidebar-actions">
            <div className="sidebar-utilities">
              <ActionTooltip>
                <Button
                  aria-label="Settings"
                  disabled={!data}
                  onClick={() => void router.navigate({ to: "/settings" })}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <SettingsIcon />
                </Button>
              </ActionTooltip>
              <ActionTooltip>
                <Button
                  aria-label="Plugins"
                  disabled={!data}
                  onClick={() => void router.navigate({ to: "/plugins" })}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <PlugIcon />
                </Button>
              </ActionTooltip>
            </div>
            <SidebarUpdateAction />
          </fieldset>
        </SidebarFooter>
      </Sidebar>
    );
  },
  (previous, next) =>
    previous.active === next.active &&
    previous.data?.destinations === next.data?.destinations &&
    previous.data?.torrents === next.data?.torrents &&
    previous.data?.session.freeSpace === next.data?.session.freeSpace &&
    previous.open === next.open
);
