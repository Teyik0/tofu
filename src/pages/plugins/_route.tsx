import { defineRoute } from "@teyik0/furin";
import { Link, useRouter } from "@teyik0/furin/link";
import {
  ArrowLeftIcon,
  BrainCircuitIcon,
  CableIcon,
  GlobeIcon,
  PlugIcon,
  RefreshCwIcon,
} from "lucide-react";
import { createContext, startTransition, useActionState, useContext, useState } from "react";
import { Logo } from "../../components/icon";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button, buttonVariants } from "../../components/ui/button";
import { SidebarUpdateAction } from "../../components/updates";
import { useWorkspace } from "../../components/workspace-state";
import { api } from "../../lib/client";
import { backToWorkspace } from "../../lib/navigation";
import type { PluginId } from "../../types";
import { route as root } from "../root";

interface PluginDraft {
  apiKey: string;
  dailyLimit: string;
}
type PluginDraftUpdate = Partial<PluginDraft> | ((current: PluginDraft) => Partial<PluginDraft>);
interface PluginDraftsContextValue {
  drafts: Partial<Record<PluginId, PluginDraft>>;
  updateDraft: (id: PluginId, draft: PluginDraftUpdate) => void;
}
const PluginDraftsContext = createContext<PluginDraftsContextValue | null>(null);
export const usePluginDrafts = () => {
  const drafts = useContext(PluginDraftsContext);
  if (!drafts) {
    throw new Error("Plugins require the plugin layout");
  }
  return drafts;
};
const sections = [
  { icon: PlugIcon, label: "Installed", to: "/plugins" },
  { icon: GlobeIcon, label: "Sources", to: "/plugins/sources" },
  { icon: BrainCircuitIcon, label: "Intelligence", to: "/plugins/intelligence" },
  { icon: CableIcon, label: "Integrations", to: "/plugins/integrations" },
] as const;

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .loader(async () => {
    const { data, error } = await api.automation.get();
    if (error) {
      throw error;
    }
    if (!(data && "plugins" in data)) {
      throw new Error("Unable to load plugins");
    }
    return { initialAutomation: data };
  })
  .layout(({ children, initialAutomation: state, path }) => {
    const router = useRouter();
    const { settingsBackPath } = useWorkspace();

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

    const [drafts, setDrafts] = useState<Partial<Record<PluginId, PluginDraft>>>({});
    const updateDraft = (id: PluginId, draft: PluginDraftUpdate) => {
      setDrafts((current) => {
        const previous = {
          apiKey: current[id]?.apiKey ?? "",
          dailyLimit:
            current[id]?.dailyLimit ??
            String(state.plugins.find((plugin) => plugin.id === id)?.dailyLimit ?? 1000),
        };
        return {
          ...current,
          [id]: { ...previous, ...(typeof draft === "function" ? draft(previous) : draft) },
        };
      });
    };

    return (
      <PluginDraftsContext value={{ drafts, updateDraft }}>
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
                Built-in plugins for this device. Enable the sources and integrations you want to
                use.
              </p>
              {refreshError ? (
                <Alert>
                  <AlertDescription>{refreshError}</AlertDescription>
                </Alert>
              ) : null}
              {children}
            </div>
          </main>
        </div>
      </PluginDraftsContext>
    );
  });
