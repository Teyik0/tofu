import { PluginHostProvider } from "@tofu/plugins/client";
import type { LiveState } from "@tofu/plugins/library-state";
import { useAtomValue, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import { useRefresh } from "../lib/navigation";
import { playSoundCue } from "../lib/sound-cues";
import type { ExtensionState } from "../plugin-client";
import {
  anilistNotificationRevisionAtom,
  globalSearchOpenAtom,
  sessionAtom,
} from "../state/workspace";
import { PluginContributionsProvider } from "./plugin-contributions";

export function PluginWorkspace({
  children,
  dashboard,
  extensions,
  path,
}: {
  children: ReactNode;
  dashboard: LiveState;
  extensions: NonNullable<ExtensionState>;
  path: string;
}) {
  const refresh = useRefresh();
  const session = useAtomValue(sessionAtom);
  const notificationRevision = useAtomValue(anilistNotificationRevisionAtom);
  const openSearch = useSetAtom(globalSearchOpenAtom);
  return (
    <PluginHostProvider
      value={{
        dashboard,
        notificationRevision,
        openSearch,
        playSound: playSoundCue,
        refresh,
        session,
      }}
    >
      <PluginContributionsProvider initialState={extensions} path={path}>
        {children}
      </PluginContributionsProvider>
    </PluginHostProvider>
  );
}
