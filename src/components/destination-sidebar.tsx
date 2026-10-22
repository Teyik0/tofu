import { Link, useRouter } from "@teyik0/furin/link";
import { useAtomValue, useSetAtom } from "jotai";
import { FolderIcon, PencilIcon, PlugIcon, PlusIcon, SettingsIcon, Trash2Icon } from "lucide-react";
import { type MouseEvent, memo, startTransition, useActionState, useEffect, useState } from "react";
import type { LiveState } from "../api/modules/dashboard/projection";
import type { Destination } from "../api/modules/destinations/model";
import { useAsyncAction } from "../hooks/use-async-action";
import { errorMessage } from "../lib/errors";
import { isSupersededNavigation, showDestination } from "../lib/navigation";
import type { ModalKind } from "../state/workspace";
import { modalAtom, sessionAtom } from "../state/workspace";
import { ActionTooltip } from "./action-tooltip";
import { AniListIcon } from "./anilist/icon";
import { DestinationIcon } from "./destination-icon";
import { DestinationMenu } from "./destination-menu";
import { bytes } from "./format";
import { GlobalSearchTrigger } from "./global-search";
import { Logo } from "./icon";
import { useDeleteDestination } from "./modal";
import { SidebarRemoteServers, SidebarServerFilter } from "./sidebar-remote-servers";
import { SidebarToggle } from "./sidebar-toggle";
import { Button } from "./ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
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
  const { busy, error, action } = useAsyncAction("Unable to delete the tab");
  const remove = (event: MouseEvent<HTMLButtonElement>) => {
    if (!event.shiftKey) {
      open({ destination, type: "deleteDestination" });
      return;
    }
    action(async () => {
      await showDestination(router, await deleteDestination(destination.id), activeDestination);
    });
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
    data: LiveState | null;
    active: string | null;
  }) {
    const router = useRouter();
    const open = useSetAtom(modalAtom);
    const capabilities = useAtomValue(sessionAtom)?.capabilities;
    const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
    const serverFilter = capabilities?.hostNative ? selectedServerId : null;
    const showCurrentServer = serverFilter === null || serverFilter === data?.server.id;
    // Editing threads needs their host folders, which only administrators receive.
    const editable = (id: string) => data?.host?.destinations.find((item) => item.id === id);
    const [navigationError, openPlugins] = useActionState<string | null, void>(async () => {
      try {
        await router.navigate({ to: "/plugins" });
        return null;
      } catch (cause) {
        if (isSupersededNavigation(cause)) {
          return null;
        }
        return errorMessage(cause, "Unable to open plugins");
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
          <GlobalSearchTrigger />
          <nav aria-label="Sidebar shortcuts">
            <SidebarMenu className="sidebar-shortcuts">
              {capabilities?.administer ? (
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
              ) : null}
              {data?.destinations
                .filter((destination) => destination.pinned && showCurrentServer)
                .map((destination) => (
                  <SidebarMenuItem key={destination.id}>
                    <DestinationMenu
                      deletable={data.destinations.length > 1}
                      destination={editable(destination.id)}
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
            <SidebarGroupLabel>THREADS</SidebarGroupLabel>
            <div className="absolute top-3.5 right-3 flex items-center gap-1 group-data-[collapsible=icon]:hidden">
              {capabilities?.hostNative && data ? (
                <SidebarServerFilter
                  currentServer={data.server}
                  onChange={setSelectedServerId}
                  selectedServerId={serverFilter}
                />
              ) : null}
              {data?.host && showCurrentServer ? (
                <ActionTooltip>
                  <Button
                    aria-label="Create a tab"
                    className="size-5!"
                    onClick={() => open({ destination: null, type: "destination" })}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <PlusIcon className="size-3.5!" />
                  </Button>
                </ActionTooltip>
              ) : null}
            </div>
            <SidebarMenu aria-label="Destination tabs">
              {data?.destinations
                .filter((destination) => !destination.pinned && showCurrentServer)
                .map((destination) => (
                  <SidebarMenuItem key={destination.id}>
                    <DestinationMenu
                      deletable={data.destinations.length > 1}
                      destination={editable(destination.id)}
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
                        title={editable(destination.id)?.downloadPath ?? destination.name}
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
                    {editable(destination.id) ? (
                      <DestinationThreadActions
                        activeDestination={active}
                        deletable={data.destinations.length > 1}
                        destination={editable(destination.id) as Destination}
                        immediate={shiftHeld}
                        open={open}
                      />
                    ) : null}
                  </SidebarMenuItem>
                ))}
              {capabilities?.hostNative && data ? (
                <SidebarRemoteServers
                  currentServerId={data.server.id}
                  selectedServerId={serverFilter}
                />
              ) : null}
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
              {capabilities?.administer ? (
                <ActionTooltip>
                  <Button
                    aria-label="Plugins"
                    onClick={() => startTransition(() => openPlugins())}
                    size="icon"
                    type="button"
                    variant="ghost"
                  >
                    <PlugIcon />
                  </Button>
                </ActionTooltip>
              ) : null}
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
    previous.data?.host === next.data?.host &&
    previous.data?.server === next.data?.server &&
    previous.data?.torrents === next.data?.torrents &&
    previous.data?.session.freeSpace === next.data?.session.freeSpace
);
