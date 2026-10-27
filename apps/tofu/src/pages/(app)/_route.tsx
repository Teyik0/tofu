import { defineRoute } from "@teyik0/furin";
import { api } from "../../lib/client";
import { destinationFromPath } from "../../lib/navigation";

export const route = defineRoute("/(app)/_route")
  .config({ mode: "ssr" })
  .loader(async ({ path }) => {
    const { data: dashboard, error } = await api.state.get({ query: { detail: "false" } });
    if (error) {
      throw error;
    }
    const id = destinationFromPath(path, dashboard.server.id);
    return {
      settings: null,
      thread: dashboard.destinations.find((thread) => thread.id === id) ?? null,
    };
  })
  .layout(({ children }) => children);
