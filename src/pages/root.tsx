import "../styles.css";
import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import type { CSSProperties } from "react";
import { DestinationSidebar } from "../components/destination-sidebar";
import { ThemeProvider } from "../components/theme-provider";
import { TorrentDrop } from "../components/torrent-drop";
import { SidebarInset, SidebarProvider } from "../components/ui/sidebar";
import { TooltipProvider } from "../components/ui/tooltip";
import { WorkspaceDialogs } from "../components/workspace-dialogs";
import { WorkspaceProvider } from "../components/workspace-state";
import { api } from "../lib/client";
import { destinationFromPath, isPreferencesPath } from "../lib/navigation";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(async () => {
    const { data, error } = await api.state.get({ query: { detail: "false" } });
    if (error || !data || !("destinations" in data)) {
      throw new Error("The Tofu engine is unavailable");
    }
    return { dashboard: data };
  })
  .layout(({ children, dashboard, path }) => {
    const activeDestination = destinationFromPath(path);
    return (
      <html data-theme={dashboard.settings.theme} lang="en">
        <head>
          <link href="/favicon.ico" rel="icon" sizes="16x16 32x32 48x48" />
          <link href="/public/icon.png" rel="icon" sizes="256x256" type="image/png" />
          <link href="/public/apple-touch-icon.png" rel="apple-touch-icon" sizes="180x180" />
          <HeadContent />
        </head>
        <body>
          <ThemeProvider initialTheme={dashboard.settings.theme}>
            <WorkspaceProvider path={path}>
              <TooltipProvider>
                <SidebarProvider
                  className="app-shell"
                  style={
                    { "--sidebar-width": "190px", "--sidebar-width-icon": "52px" } as CSSProperties
                  }
                >
                  {!isPreferencesPath(path) && (
                    <DestinationSidebar active={activeDestination} data={dashboard} />
                  )}
                  <SidebarInset className="min-w-0 overflow-hidden">{children}</SidebarInset>
                  <TorrentDrop activeDestination={activeDestination} />
                  <WorkspaceDialogs activeDestination={activeDestination} dashboard={dashboard} />
                </SidebarProvider>
              </TooltipProvider>
            </WorkspaceProvider>
          </ThemeProvider>
          <Scripts />
        </body>
      </html>
    );
  });
