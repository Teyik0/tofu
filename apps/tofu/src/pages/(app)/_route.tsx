import { createThreadLayout } from "@tofu/plugins/routes";
import { api } from "../../lib/client";
import { destinationFromPath } from "../../lib/navigation";
import { route as root } from "../root";

export const route = createThreadLayout(
  root,
  async ({ path }) => {
    const { data: dashboard, error } = await api.state.get({ query: { detail: "false" } });
    if (error) {
      throw error;
    }
    const id = destinationFromPath(path);
    return {
      dashboard,
      settings: dashboard.settings,
      thread: dashboard.destinations.find((thread) => thread.id === id) ?? null,
    };
  },
  ({ children }) => children
);
