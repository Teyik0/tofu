import { defineRoute } from "@teyik0/furin";
import { Link, useRouter } from "@teyik0/furin/link";
import { useAtomValue } from "jotai";
import {
  ArrowLeftIcon,
  BrainCircuitIcon,
  CableIcon,
  GlobeIcon,
  PlugIcon,
  RefreshCwIcon,
} from "lucide-react";
import { startTransition, useActionState } from "react";
import { Logo } from "../../components/icon";
import { PluginGroup } from "../../components/plugins/plugin-group";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button, buttonVariants } from "../../components/ui/button";
import { SidebarUpdateAction } from "../../components/updates";
import { usePluginForms } from "../../hooks/use-plugin-forms";
import { readData } from "../../lib/api-data";
import { api } from "../../lib/client";
import { backToWorkspace } from "../../lib/navigation";
import { settingsBackPathAtom } from "../../state/workspace";
import { route as root } from "../root";

const sections = [
  { icon: PlugIcon, label: "Installed", to: "/plugins" },
  { icon: GlobeIcon, label: "Sources", to: "/plugins/sources" },
  { icon: BrainCircuitIcon, label: "Intelligence", to: "/plugins/intelligence" },
  { icon: CableIcon, label: "Integrations", to: "/plugins/integrations" },
] as const;

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .loader(async () => ({ initialAutomation: readData(await api.automation.get()) }))
  .layout(({ children, initialAutomation: state, path }) => {
    const router = useRouter();
    const settingsBackPath = useAtomValue(settingsBackPathAtom);

    const [refreshError, refreshAction, isRefreshing] = useActionState<string | null, void>(
      async () => {
        try {
          await router.refresh();
          return null;
        } catch (cause) {
          if (cause instanceof Error && cause.name === "AbortError") {
            return null;
          }
          return cause instanceof Error ? cause.message : "Unable to refresh plugins";
        }
      },
      null
    );

    const back = () => {
      void backToWorkspace(router, settingsBackPath);
    };

    const forms = usePluginForms(state.plugins);

    return (
      <div className="settings-page plugins-page">
        <aside className="settings-navigation">
          <div className="settings-brand">
            <Logo />
            <strong>Tofu</strong>
          </div>
          <nav aria-label="Plugin sections">
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
            <Button className="settings-back plugins-back" onClick={back} variant="ghost">
              <ArrowLeftIcon data-icon="inline-start" />
              Back
            </Button>
            <SidebarUpdateAction />
          </div>
        </aside>
        <main className="settings-main">
          <header className="settings-topbar">
            <h1>
              <span>Plugins</span>
              <span aria-hidden="true">/</span>
              {sections.find((item) => item.to === path)?.label}
            </h1>
            <Button
              disabled={isRefreshing}
              onClick={() => startTransition(() => refreshAction())}
              variant="ghost"
            >
              <RefreshCwIcon
                className={isRefreshing ? "animate-spin" : undefined}
                data-icon="inline-start"
              />
              Refresh
            </Button>
          </header>
          <div className="settings-content plugins-content">
            <p className="settings-intro">
              Built-in plugins for this device. Enable the sources and integrations you want to use.
            </p>
            {refreshError ? (
              <Alert>
                <AlertDescription>{refreshError}</AlertDescription>
              </Alert>
            ) : null}
            {(path === "/plugins" || path === "/plugins/sources") && (
              <PluginGroup
                forms={forms}
                ids={["nyaa", "tsundere", "c411"]}
                plugins={state.plugins}
                title="Torrent sources"
              />
            )}
            {(path === "/plugins" || path === "/plugins/intelligence") && (
              <PluginGroup
                forms={forms}
                ids={["jev"]}
                plugins={state.plugins}
                title="Release intelligence"
              />
            )}
            {(path === "/plugins" || path === "/plugins/integrations") && (
              <PluginGroup
                forms={forms}
                ids={["anilist"]}
                plugins={state.plugins}
                title="Account integrations"
              />
            )}
            {children}
          </div>
        </main>
      </div>
    );
  });
