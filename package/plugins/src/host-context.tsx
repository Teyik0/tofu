import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { LiveState } from "./library-state";

export interface PluginHost {
  dashboard: LiveState;
  notificationRevision: number;
  openSearch: (value: boolean | { query: string; destinationId: string }) => void;
  playSound: (cue: "added" | "removed") => void;
  refresh: () => Promise<void>;
  session: {
    capabilities: { administer: boolean; hostNative: boolean };
    caller: { deviceKind?: string | null };
    server: { name: string };
  } | null;
  toggleSidebar?: () => void;
}

const HostContext = createContext<PluginHost | null>(null);

export function PluginHostProvider({
  children,
  value,
}: {
  children: ReactNode;
  value: PluginHost;
}) {
  return <HostContext value={value}>{children}</HostContext>;
}

export function usePluginHost(): PluginHost {
  const host = useContext(HostContext);
  if (!host) {
    throw new Error("Plugin UI must be rendered inside PluginHostProvider");
  }
  return host;
}
