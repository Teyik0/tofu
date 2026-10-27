import type { ComponentType } from "react";
import type { Settings } from "./domain";
import type { LibraryState, LibraryTorrent } from "./library-state";
import type { PluginRouteFactory } from "./routes";

export interface ThreadLayoutContext {
  dashboard: LibraryState;
  settings: Settings | null;
  thread: LibraryState["destinations"][number] | null;
}

export interface ThreadContext extends ThreadLayoutContext {
  thread: LibraryState["destinations"][number];
}

export interface ThreadActionContext extends ThreadContext {
  torrents: readonly LibraryTorrent[];
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
  route: (Route & { readonly __type: "FURIN_ROUTE" }) | PluginRouteFactory<Route>;
  title: string;
}

export interface PluginUI {
  pages?: readonly PluginPage[];
  settings?: ComponentType<{ threadId?: string }>;
  threadActions?: readonly ThreadAction[];
}
