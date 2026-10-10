import { defineRoute } from "@teyik0/furin";
import { createTofuClient } from "../../client";
import { AppShell } from "../../components/app-shell";
import { route as root } from "../root";

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .loader(async ({ request, path }) => {
    const client = createTofuClient(new URL(request.url).origin, request);
    const [{ data, error }, extensions] = await Promise.all([
      client.api.state.get({ query: { detail: "false" } }),
      client.api.extensions.get(),
    ]);
    if (error || !data || !("destinations" in data)) {
      throw new Error("The Tofu engine is unavailable");
    }
    const destinationId = path.startsWith("/library/destinations/")
      ? decodeURIComponent(path.slice("/library/destinations/".length))
      : null;
    return {
      dashboard: data,
      extensions: extensions.data && "plugins" in extensions.data ? extensions.data : undefined,
      settings: data.settings,
      thread: data.destinations.find((destination) => destination.id === destinationId) ?? null,
    };
  })
  .layout(({ children, dashboard, extensions, path }) => (
    <AppShell dashboard={dashboard} initialExtensions={extensions} path={path}>
      {children}
    </AppShell>
  ));
