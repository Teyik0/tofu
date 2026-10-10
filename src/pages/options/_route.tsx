import { defineRoute } from "@teyik0/furin";
import { Link, useRouter } from "@teyik0/furin/link";
import {
  ArrowLeftIcon,
  DownloadIcon,
  ListFilterIcon,
  PaletteIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
} from "lucide-react";
import { useEffect } from "react";
import { Logo } from "../../components/icon";
import { Button, buttonVariants } from "../../components/ui/button";
import { SidebarUpdateAction } from "../../components/updates";
import { useWorkspace } from "../../components/workspace-state";
import { backToWorkspace } from "../../lib/navigation";
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
    const { settingsBackPath } = useWorkspace();
    const router = useRouter();
    useEffect(() => {
      if (path === "/options" && window.location.hash === "#updates") {
        void router.navigate({ replace: true, to: "/options/updates" });
      }
    }, [path, router.navigate]);

    return (
      <div className="settings-page">
        <aside className="settings-navigation">
          <div className="settings-brand">
            <Logo />
            <strong>Tofu</strong>
          </div>
          <nav aria-label="Settings sections">
            {sections.map(({ to, label, icon: Icon }) => (
              <Link
                aria-current={path === to ? "page" : undefined}
                className={buttonVariants({
                  className: "settings-nav-item",
                  variant: path === to ? "secondary" : "ghost",
                })}
                key={to}
                preload={false}
                resetScroll={false}
                to={to}
              >
                <Icon data-icon="inline-start" />
                {label}
              </Link>
            ))}
          </nav>
          <div className="settings-footer">
            <Button
              className="settings-back"
              onClick={() => void backToWorkspace(router, settingsBackPath)}
              variant="ghost"
            >
              <ArrowLeftIcon data-icon="inline-start" />
              Back
            </Button>
            <SidebarUpdateAction />
          </div>
        </aside>
        <main className="settings-main">
          <header className="settings-topbar">
            <h1>
              <span>Settings</span>
              <span aria-hidden="true">/</span>
              {sections.find((item) => item.to === path)?.label}
            </h1>
          </header>
          <div className="settings-content">
            {path !== "/options/updates" && path !== "/options/preferences" && (
              <p className="settings-intro">
                Preferences for this device. Changes apply automatically.
              </p>
            )}
            {children}
          </div>
        </main>
      </div>
    );
  });
