import type { ComponentType } from "react";
import type { DashboardState, Destination, Settings, TorrentSummary } from "./domain";
import type { PluginRouteFactory } from "./routes";

export interface ThreadLayoutContext {
  dashboard: DashboardState;
  settings: Settings;
  thread: Destination | null;
}

export interface ThreadContext extends ThreadLayoutContext {
  thread: Destination;
}

export interface ThreadActionContext extends ThreadContext {
  torrents: readonly TorrentSummary[];
}

export type ThreadAction = {
  id: string;
  label: string;
  icon?: ComponentType<{ className?: string }>;
} & (
  | { dialog: ComponentType<ThreadActionContext & { close: () => void }>; run?: never }
  | { run: (context: ThreadActionContext) => void | Promise<void>; dialog?: never }
);

/** Native routes are retained as their original inferred type by definePlugin. */
export interface PluginPage<Route = unknown> {
  /** Account and configuration pages can remain accessible while active features are disabled. */
  availableWhenDisabled?: boolean;
  icon?: ComponentType<{ className?: string }>;
  id: string;
  path: string;
  pinnable: boolean;
  route: PluginRouteFactory<Route>;
  title: string;
}

export interface PluginUI {
  pages?: readonly PluginPage[];
  settings?: ComponentType<{ threadId?: string }>;
  threadActions?: readonly ThreadAction[];
}
