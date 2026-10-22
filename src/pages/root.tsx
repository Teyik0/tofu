import "../styles.css";

import { defineRootRoute, HeadContent, Scripts } from "@teyik0/furin";
import { WorkspaceLayout } from "../components/workspace-layout";
import { api } from "../lib/client";

export const route = defineRootRoute()
  .config({ mode: "ssr" })
  .loader(async ({ path }) => {
    if (path === "/pair" || path === "/signed-out" || path === "/session-transfer") {
      return { dashboard: null };
    }
    const { data, error } = await api.state.get({ query: { detail: "false" } });
    if (error) {
      throw error;
    }
    return { dashboard: data };
  })
  .layout(({ children, dashboard, path }) => (
    <html data-theme={dashboard?.appearance.theme ?? "system"} lang="en">
      <head>
        <link href="/favicon.ico" rel="icon" sizes="16x16 32x32 48x48" />
        <link href="/public/icon.png" rel="icon" sizes="256x256" type="image/png" />
        <link href="/public/apple-touch-icon.png" rel="apple-touch-icon" sizes="180x180" />
        <HeadContent />
      </head>
      <body>
        {dashboard ? (
          <WorkspaceLayout loaded={dashboard} path={path}>
            {children}
          </WorkspaceLayout>
        ) : (
          children
        )}
        <Scripts />
      </body>
    </html>
  ));
