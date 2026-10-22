import { Provider, useAtomValue } from "jotai";
import type { ReactNode } from "react";
import { type CSSProperties, useState } from "react";
import type { LibraryState } from "../api/modules/dashboard/projection";
import { destinationFromPath, isPreferencesPath } from "../lib/navigation";
import { createTofuStore, dashboardAtom, sessionAtom } from "../state/workspace";
import { DestinationSidebar } from "./destination-sidebar";
import { GlobalSearch } from "./global-search";
import { OpenedTorrents } from "./opened-torrents";
import { TofuStateSync } from "./tofu-state-sync";
import { TorrentDrop } from "./torrent-drop";
import { SidebarInset, SidebarProvider } from "./ui/sidebar";
import { TooltipProvider } from "./ui/tooltip";
import { WorkspaceDialogs } from "./workspace-dialogs";

export function WorkspaceLayout({
  children,
  loaded,
  path,
}: {
  children: ReactNode;
  loaded: LibraryState;
  path: string;
}) {
  const [store] = useState(() => createTofuStore(loaded));
  const dashboard = useAtomValue(dashboardAtom, { store }) ?? {
    ...loaded,
    detailHost: null,
    host: null,
  };
  const capabilities = useAtomValue(sessionAtom, { store })?.capabilities;
  const activeDestination = destinationFromPath(path);
  return (
    <Provider store={store}>
      <TofuStateSync dashboard={loaded} path={path} />
      <TooltipProvider>
        <SidebarProvider
          className="app-shell"
          style={{ "--sidebar-width": "190px", "--sidebar-width-icon": "52px" } as CSSProperties}
        >
          {dashboard && !isPreferencesPath(path) && (
            <DestinationSidebar active={activeDestination} data={dashboard} />
          )}
          <SidebarInset className="min-w-0 overflow-hidden">{children}</SidebarInset>
          {!!dashboard && (
            <>
              <TorrentDrop activeDestination={activeDestination} />
              <WorkspaceDialogs activeDestination={activeDestination} dashboard={dashboard} />
              {capabilities?.hostNative ? <OpenedTorrents /> : null}
              <GlobalSearch activeDestination={activeDestination} dashboard={dashboard} />
            </>
          )}
        </SidebarProvider>
      </TooltipProvider>
    </Provider>
  );
}
