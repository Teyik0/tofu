import { useQuery } from "@teyik0/furin/client";
import { ListFilterIcon, ServerIcon } from "lucide-react";
import { useEffect } from "react";
import { api } from "../lib/client";
import { errorMessage } from "../lib/errors";
import { DestinationIcon } from "./destination-icon";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { SidebarMenuItem } from "./ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

function SidebarRemoteServer({
  server,
  visible,
}: {
  server: { alias: string; name: string; serverId: string };
  visible: boolean;
}) {
  const { data, error } = useQuery(api.desktop.servers({ id: server.serverId }).state.get.live());
  if (!visible) {
    return null;
  }
  const state = error ? null : data;
  const snapshot = state?.connection === "ready" ? state.snapshot : null;
  const name = server.alias || state?.server.name || server.name;

  if (!snapshot) {
    if (!error && (!state || state.connection === "connecting")) {
      return null;
    }
    return (
      <SidebarMenuItem className="group-data-[collapsible=icon]:hidden">
        <p
          className="px-2 py-2 text-[10px] text-muted-foreground"
          role="status"
          title={
            error ? errorMessage(error, "Unable to read this server") : state?.failure?.body.detail
          }
        >
          {name} · {state?.connection === "unauthorized" ? "Access required" : "Unavailable"}
        </p>
      </SidebarMenuItem>
    );
  }

  let role = "Playback";
  if (snapshot.capabilities.administer) {
    role = "Administration";
  } else if (snapshot.capabilities.manage) {
    role = "Management";
  }

  const counts = new Map<string, number>();
  for (const torrent of snapshot.torrents) {
    counts.set(torrent.destinationId, (counts.get(torrent.destinationId) ?? 0) + 1);
  }

  return snapshot.threads.map((thread) => (
    <SidebarMenuItem key={`${server.serverId}:${thread.id}`}>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              aria-disabled="true"
              aria-label={`${thread.name} · ${name}`}
              className="flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-sidebar-foreground text-xs outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center"
              type="button"
            >
              <DestinationIcon name={thread.icon} />
              <span className="min-w-0 flex-1 truncate group-data-[collapsible=icon]:hidden">
                {thread.name}
              </span>
              <ServerIcon
                aria-hidden="true"
                className="size-3! text-muted-foreground group-data-[collapsible=icon]:hidden"
              />
              <span className="text-[10px] text-muted-foreground tabular-nums group-data-[collapsible=icon]:hidden">
                {counts.get(thread.id) ?? 0}
              </span>
            </button>
          }
        />
        <TooltipContent side="right" sideOffset={10}>
          <div className="space-y-1">
            <strong className="block">{thread.name}</strong>
            <p>{name}</p>
            <p>{role} · Connected</p>
            <p className="text-muted-foreground">Opening remote threads is not available yet.</p>
          </div>
        </TooltipContent>
      </Tooltip>
    </SidebarMenuItem>
  ));
}

export function SidebarRemoteServers({
  currentServerId,
  selectedServerId,
}: {
  currentServerId: string;
  selectedServerId: string | null;
}) {
  const { data, error } = useQuery(api.desktop.servers.get.live());
  if (error) {
    return (
      <SidebarMenuItem>
        <p className="px-2 py-2 text-destructive text-xs" role="alert">
          {errorMessage(error, "Unable to read saved servers")}
        </p>
      </SidebarMenuItem>
    );
  }
  return data?.servers
    .filter((server) => server.serverId !== currentServerId)
    .map((server) => (
      <SidebarRemoteServer
        key={server.serverId}
        server={server}
        visible={selectedServerId === null || selectedServerId === server.serverId}
      />
    ));
}

export function SidebarServerFilter({
  currentServer,
  selectedServerId,
  onChange,
}: {
  currentServer: { id: string; name: string };
  selectedServerId: string | null;
  onChange: (serverId: string | null) => void;
}) {
  const { data, error } = useQuery(api.desktop.servers.get.live());
  const servers = error
    ? []
    : (data?.servers ?? []).filter((server) => server.serverId !== currentServer.id);

  // Return to the complete list if the selected server is forgotten.
  useEffect(() => {
    if (
      !error &&
      data &&
      selectedServerId !== null &&
      selectedServerId !== currentServer.id &&
      !data.servers.some((server) => server.serverId === selectedServerId)
    ) {
      onChange(null);
    }
  }, [currentServer.id, data, error, onChange, selectedServerId]);

  let selectedName = "All servers";
  if (selectedServerId === currentServer.id) {
    selectedName = "This computer";
  } else if (selectedServerId !== null) {
    const server = servers.find((candidate) => candidate.serverId === selectedServerId);
    selectedName = server?.alias || server?.name || "Selected server";
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label={`Filter threads: ${selectedName}`}
            className="size-5! text-muted-foreground data-[active=true]:text-(--olive)"
            data-active={selectedServerId !== null}
            disabled={!(data || error)}
            size="icon"
            title={`Filter threads: ${selectedName}`}
            type="button"
            variant="ghost"
          />
        }
      >
        <ListFilterIcon className="size-3.5!" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuRadioGroup
          onValueChange={(value: string) => onChange(value === "all" ? null : value)}
          value={selectedServerId ?? "all"}
        >
          <DropdownMenuRadioItem value="all">All servers</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem title={currentServer.name} value={currentServer.id}>
            This computer
          </DropdownMenuRadioItem>
          {servers.map((server) => (
            <DropdownMenuRadioItem key={server.serverId} value={server.serverId}>
              <span className="truncate">{server.alias || server.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        {error ? (
          <p className="px-2 py-2 text-destructive text-xs" role="alert">
            {errorMessage(error, "Unable to read saved servers")}
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
