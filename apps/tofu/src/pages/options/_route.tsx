import { defineRoute } from "@teyik0/furin";
import { useRouter } from "@teyik0/furin/link";
import {
  DownloadIcon,
  ListFilterIcon,
  PaletteIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useEffect } from "react";
import { SettingsLayout } from "../../components/settings-layout";
import { route as root } from "../root";

const sections = [
  { icon: SlidersHorizontalIcon, label: "General", to: "/options" },
  { icon: ListFilterIcon, label: "Preferences", to: "/options/preferences" },
  { icon: PaletteIcon, label: "Appearance", to: "/options/appearance" },
  { icon: DownloadIcon, label: "Downloads", to: "/options/downloads" },
  { icon: RefreshCwIcon, label: "Updates", to: "/options/updates" },
] as const;

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .layout(({ children, path }) => {
    const router = useRouter();
    useEffect(() => {
      if (path === "/options" && window.location.hash === "#updates") {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
        void router.navigate({ replace: true, to: "/options/updates" });
      }
    }, [path, router.navigate]);

    return (
      <SettingsLayout
        navigationLabel="Settings sections"
        path={path}
        sections={sections}
        title="Settings"
      >
        {path !== "/options/updates" && path !== "/options/preferences" && (
          <p className="settings-intro">
            Preferences for this device. Changes apply automatically.
          </p>
        )}
        {children}
      </SettingsLayout>
    );
  });
