import { Link, useRouter } from "@teyik0/furin/link";
import { useSetAtom } from "jotai";
import { FolderIcon, PencilIcon, PlugIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { type MouseEvent, memo, startTransition, useActionState, useEffect, useState } from "react";
import { isSupersededNavigation, showDestination } from "../lib/navigation";
import { modalAtom } from "../state/workspace";
import type { DashboardState, Destination } from "../types";
import { ActionTooltip } from "./action-tooltip";
import { AniListIcon } from "./anilist/icon";
import { DestinationIcon } from "./destination-icon";
import { DestinationMenu } from "./destination-menu";
import { bytes } from "./format";
import { Logo } from "./icon";
import { type ModalKind, useDeleteDestination } from "./modal";
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from "./ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { SidebarUpdateAction } from "./updates";

function useShiftHeld() {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    const update = (event: KeyboardEvent) => setHeld(event.shiftKey);
    const release = () => setHeld(false);
    window.addEventListener("keydown", update);
    window.addEventListener("keyup", update);
    window.addEventListener("blur", release);
    return () => {
      window.removeEventListener("keydown", update);
      window.removeEventListener("keyup", update);
      window.removeEventListener("blur", release);
    };
  }, []);
  return held;
}

/** Replaces the torrent count on hover; Shift-clicking Delete skips the confirmation dialog. */
function DestinationThreadActions({
  activeDestination,
  destination,
  deletable,
  immediate,
  open,
}: {
  activeDestination: string | null;
  destination: Destination;
  deletable: boolean;
  immediate: boolean;
  open: (modal: ModalKind) => void;
}) {
  const router = useRouter();
  const deleteDestination = useDeleteDestination(activeDestination);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (event: MouseEvent<HTMLButtonElement>) => {
    if (!event.shiftKey) {
      open({ destination, type: "deleteDestination" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await showDestination(router, await deleteDestination(destination.id), activeDestination);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete the tab");
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div className="sidebar-thread-actions">
        <ActionTooltip>
          <button
            aria-label={`Edit tab ${destination.name}`}
            className="sidebar-thread-action"
            onClick={() => open({ destination, type: "destination" })}
            type="button"
          >
            <PencilIcon />
          </button>
        </ActionTooltip>
        {deletable ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  aria-label={`Delete tab ${destination.name}`}
                  className="sidebar-thread-action sidebar-thread-delete"
                  data-immediate={immediate || undefined}
                  disabled={busy}
                  onClick={(event) => void remove(event)}
                  type="button"
                >
                  <Trash2Icon />
                </button>
              }
            />
            <TooltipContent sideOffset={6}>
              {immediate ? "Delete now" : "Delete tab · Shift-click to skip confirmation"}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {error !== null && (
        <p className="text-destructive text-xs" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export const DestinationSidebar = memo(
  function DestinationSidebarView({
    data,
    active,
  }: {
    data: DashboardState | null;
    active: string | null;
  }) {
    const router = useRouter();
    const open = useSetAtom(modalAtom);
    const [navigationError, openPlugins] = useActionState<string | null, void>(async () => {
      try {
        await router.navigate({ to: "/plugins" });
        return null;
      } catch (cause) {
        if (isSupersededNavigation(cause)) {
          return null;
        }
        return cause instanceof Error ? cause.message : "Unable to open plugins";
      }
    }, null);
    const shiftHeld = useShiftHeld();
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
              to="/"
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
                    <DestinationMenu
                      deletable={data.destinations.length > 1}
                      destination={destination}
                      open={open}
                    >
                      <SidebarMenuButton
                        aria-label={destination.name}
                        className="sidebar-shortcut"
                        isActive={active === destination.id}
                        render={
                          <Link
                            aria-current={active === destination.id ? "page" : undefined}
                            params={{ id: destination.id }}
                            resetScroll={false}
                            to="/thread/:id"
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
                    <DestinationMenu
                      deletable={data.destinations.length > 1}
                      destination={destination}
                      open={open}
                    >
                      <SidebarMenuButton
                        aria-label={destination.name}
                        className="sidebar-thread-link"
                        isActive={active === destination.id}
                        render={
                          <Link
                            aria-current={active === destination.id ? "page" : undefined}
                            params={{ id: destination.id }}
                            resetScroll={false}
                            to="/thread/:id"
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
                    <DestinationThreadActions
                      activeDestination={active}
                      deletable={data.destinations.length > 1}
                      destination={destination}
                      immediate={shiftHeld}
                      open={open}
                    />
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
                  onClick={() => void router.navigate({ to: "/options" })}
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
                  onClick={() => startTransition(() => openPlugins())}
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
          {navigationError !== null && (
            <p className="text-destructive text-xs" role="alert">
              {navigationError}
            </p>
          )}
        </SidebarFooter>
      </Sidebar>
    );
  },
  (previous, next) =>
    previous.active === next.active &&
    previous.data?.destinations === next.data?.destinations &&
    previous.data?.torrents === next.data?.torrents &&
    previous.data?.session.freeSpace === next.data?.session.freeSpace
);
