import { createThreadLayout } from "@tofu/plugins/routes";
import { readData } from "../../lib/api-data";
import { api } from "../../lib/client";
import { destinationFromPath } from "../../lib/navigation";
import { route as root } from "../root";

export const route = createThreadLayout(
  root,
  async ({ path }) => {
    const dashboard = readData(await api.state.get({ query: { detail: "false" } }));
    const id = destinationFromPath(path);
    return {
      dashboard,
      settings: dashboard.settings,
      thread: dashboard.destinations.find((thread) => thread.id === id) ?? null,
    };
  },
  ({ children }) => children
);
