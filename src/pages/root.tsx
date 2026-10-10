import "../styles.css";

import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import { Provider } from "jotai";
import { type CSSProperties, useState } from "react";
import { DestinationSidebar } from "../components/destination-sidebar";
import { TofuStateSync } from "../components/tofu-state-sync";
import { TorrentDrop } from "../components/torrent-drop";
import { SidebarInset, SidebarProvider } from "../components/ui/sidebar";
import { TooltipProvider } from "../components/ui/tooltip";
import { WorkspaceDialogs } from "../components/workspace-dialogs";
import { readData } from "../lib/api-data";
import { api } from "../lib/client";
import { destinationFromPath, isPreferencesPath } from "../lib/navigation";
import { createTofuStore } from "../state/workspace";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(async () => ({
    dashboard: readData(await api.state.get({ query: { detail: "false" } })),
  }))
  .layout(({ children, dashboard, path }) => {
    const initialTheme = dashboard?.settings.theme ?? "system";
    const [store] = useState(() => createTofuStore(initialTheme));
    const activeDestination = destinationFromPath(path);
    return (
      <html data-theme={initialTheme} lang="en">
        <head>
          <link href="/favicon.ico" rel="icon" sizes="16x16 32x32 48x48" />
          <link href="/public/icon.png" rel="icon" sizes="256x256" type="image/png" />
          <link href="/public/apple-touch-icon.png" rel="apple-touch-icon" sizes="180x180" />
          <HeadContent />
        </head>
        <body>
          <Provider store={store}>
            <TofuStateSync initialTheme={initialTheme} path={path} />
            <TooltipProvider>
              <SidebarProvider
                className="app-shell"
                style={
                  { "--sidebar-width": "190px", "--sidebar-width-icon": "52px" } as CSSProperties
                }
              >
                {dashboard && !isPreferencesPath(path) && (
                  <DestinationSidebar active={activeDestination} data={dashboard} />
                )}
                <SidebarInset className="min-w-0 overflow-hidden">{children}</SidebarInset>
                {!!dashboard && (
                  <>
                    <TorrentDrop activeDestination={activeDestination} />
                    <WorkspaceDialogs activeDestination={activeDestination} dashboard={dashboard} />
                  </>
                )}
              </SidebarProvider>
            </TooltipProvider>
          </Provider>
          <Scripts />
        </body>
      </html>
    );
  });
