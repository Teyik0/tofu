import { Link } from "@teyik0/furin/link";
import {
  FolderIcon,
  LayoutGridIcon,
  PencilIcon,
  PlugIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react";
import { memo } from "react";
import type { DashboardState } from "../types";
import { ActionTooltip } from "./action-tooltip";
import { bytes } from "./format";
import { Logo } from "./icon";
import type { ModalKind } from "./modal";
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
  SidebarRail,
  SidebarTrigger,
} from "./ui/sidebar";

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
    return (
      <Sidebar className="destination-sidebar" collapsible="icon" variant="inset">
        <SidebarHeader>
          <div className="sidebar-brand-row">
            <Link aria-label="Tofu, accueil" className="brand" to="/library">
              <Logo />
              <span>Tofu</span>
            </Link>
            <ActionTooltip>
              <SidebarTrigger aria-label="Collapse sidebar" />
            </ActionTooltip>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={active === null}
                  render={<Link resetScroll={false} to="/library/all" />}
                  tooltip="All torrents"
                >
                  <LayoutGridIcon />
                  <span>All torrents</span>
                </SidebarMenuButton>
                <SidebarMenuBadge>{data?.torrents.length ?? 0}</SidebarMenuBadge>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroup>
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
              {data?.destinations.map((destination) => (
                <SidebarMenuItem key={destination.id}>
                  <SidebarMenuButton
                    isActive={active === destination.id}
                    render={
                      <Link
                        params={{ id: destination.id }}
                        resetScroll={false}
                        to="/library/destinations/:id"
                      />
                    }
                    title={destination.downloadPath}
                    tooltip={destination.name}
                  >
                    <FolderIcon />
                    <span>{destination.name}</span>
                  </SidebarMenuButton>
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
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton
                disabled={!data}
                onClick={() => open({ type: "plugins" })}
                tooltip="Plugins"
              >
                <PlugIcon />
                <span>Plugins</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                disabled={!data}
                onClick={() => open({ type: "settings" })}
                tooltip="Preferences"
              >
                <SettingsIcon />
                <span>Preferences</span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
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
