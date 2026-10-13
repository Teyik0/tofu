import type { createCore } from "./core";
import type { DashboardState, Destination } from "./domain";

export interface PluginCoreCapabilities {
  dashboard: () => DashboardState;
  thread: (id: string) => Destination | null;
}

export type PluginCore = ReturnType<typeof createCore<PluginCoreCapabilities>>;
