import { PluginHostProvider } from "@tofu/plugins/client";
import type { ReactNode } from "react";
import { useRefresh } from "../lib/navigation";
import { playSoundCue } from "../lib/sound-cues";
import type { ExtensionState } from "../plugin-client";
import type { DashboardState } from "../types";
import { PluginContributionsProvider } from "./plugin-contributions";

export function PluginWorkspace({
  children,
  dashboard,
  extensions,
  path,
}: {
  children: ReactNode;
  dashboard: DashboardState;
  extensions: NonNullable<ExtensionState>;
  path: string;
}) {
  const refresh = useRefresh();
  return (
    <PluginHostProvider value={{ dashboard, playSound: playSoundCue, refresh }}>
      <PluginContributionsProvider initialState={extensions} path={path}>
        {children}
      </PluginContributionsProvider>
    </PluginHostProvider>
  );
}
