import { defineRoute } from "@teyik0/furin";
import { useRouter } from "@teyik0/furin/link";
import { useAtomValue } from "jotai";
import {
  DownloadIcon,
  GlobeIcon,
  ListFilterIcon,
  PaletteIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useEffect } from "react";
import { SettingsLayout } from "../../components/settings-layout";
import { sessionAtom } from "../../state/workspace";

const sections = [
  { icon: SlidersHorizontalIcon, label: "General", to: "/options" },
  { icon: ListFilterIcon, label: "Preferences", to: "/options/preferences" },
  { icon: PaletteIcon, label: "Appearance", to: "/options/appearance" },
  { icon: DownloadIcon, label: "Downloads", to: "/options/downloads" },
  { icon: GlobeIcon, label: "Connections", to: "/options/connections" },
  { icon: RefreshCwIcon, label: "Updates", to: "/options/updates" },
] as const;

export const route = defineRoute("/options/_route")
  .config({ mode: "ssr" })
  .layout(({ children, path }) => {
    const router = useRouter();
    const server = useAtomValue(sessionAtom)?.server.name;
    useEffect(() => {
      if (path === "/options" && window.location.hash === "#updates") {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        void router.navigate({ replace: true, to: "/options/updates" });
      }
    }, [path, router.navigate]);

    return (
      <SettingsLayout
        actions={server ? <span className="settings-context">Server: {server}</span> : null}
        navigationLabel="Settings sections"
        path={path}
        sections={sections}
        title="Settings"
      >
        {(path === "/options" || path === "/options/downloads") && server ? (
          <p className="settings-intro">Applies to {server}. Changes apply automatically.</p>
        ) : null}
        {path === "/options/appearance" ? (
          <p className="settings-intro">Applies to this device. Changes apply automatically.</p>
        ) : null}
        {children}
      </SettingsLayout>
    );
  });
