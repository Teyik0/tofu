import { defineRoute } from "@teyik0/furin";
import { createTofuClient } from "../../client";
import { AppShell } from "../../components/app-shell";
import { route as root } from "../root";

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .loader(async ({ request }) => {
    const { data, error } = await createTofuClient(new URL(request.url).origin).api.state.get({
      query: { detail: "false" },
    });
    if (error || !data || !("destinations" in data)) {
      throw new Error("Le moteur Tofu est indisponible");
    }
    return { dashboard: data };
  })
  .layout(({ children, dashboard, path }) => (
    <AppShell dashboard={dashboard} path={path}>
      {children}
    </AppShell>
  ));
