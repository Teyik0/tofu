import type { ReactNode } from "react";
import { createContext, useContext } from "react";
import type { DashboardState } from "./domain";

export interface PluginHost {
  dashboard: DashboardState;
  refresh: () => Promise<void>;
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
