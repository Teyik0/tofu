import { defineRoute } from "@teyik0/furin";
import { useRouter } from "@teyik0/furin/link";
import { BrainCircuitIcon, CableIcon, GlobeIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import { startTransition, useActionState } from "react";
import { PluginGroup } from "../../components/plugins/plugin-group";
import { SettingsLayout } from "../../components/settings-layout";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { usePluginForms } from "../../hooks/use-plugin-forms";
import { api } from "../../lib/client";
import { errorMessage } from "../../lib/errors";
import { isSupersededNavigation } from "../../lib/navigation";
import { route as root } from "../root";

const sections = [
  { icon: PlugIcon, label: "Installed", to: "/plugins" },
  { icon: GlobeIcon, label: "Sources", to: "/plugins/sources" },
  { icon: BrainCircuitIcon, label: "Intelligence", to: "/plugins/intelligence" },
  { icon: CableIcon, label: "Integrations", to: "/plugins/integrations" },
] as const;

export const route = defineRoute()
  .config({ layout: root, mode: "ssr" })
  .loader(async () => {
    const [automation, instance] = await Promise.all([api.automation.get(), api.instance.get()]);
    if (instance.error !== null) {
      throw instance.error;
    }
    if (automation.error !== null) {
      throw automation.error;
    }
    return { desktop: instance.data.desktop, initialAutomation: automation.data };
  })
  .layout(({ children, initialAutomation: state, desktop, path }) => {
    const router = useRouter();

    const [refreshError, refreshAction, isRefreshing] = useActionState<string | null, void>(
      async () => {
        try {
          await router.refresh();
          return null;
        } catch (cause) {
          if (isSupersededNavigation(cause)) {
            return null;
          }
          return errorMessage(cause, "Unable to refresh plugins");
        }
      },
      null
    );

    const forms = usePluginForms(state.plugins);

    return (
      <SettingsLayout
        actions={
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
        }
        backClassName="plugins-back"
        className="plugins-page"
        contentClassName="plugins-content"
        navigationLabel="Plugin sections"
        path={path}
        sections={sections}
        title="Plugins"
      >
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
            desktop={desktop}
            forms={forms}
            ids={["nyaa", "tsundere", "c411"]}
            plugins={state.plugins}
            title="Torrent sources"
          />
        )}
        {(path === "/plugins" || path === "/plugins/intelligence") && (
          <PluginGroup
            desktop={desktop}
            forms={forms}
            ids={["jev"]}
            plugins={state.plugins}
            title="Release intelligence"
          />
        )}
        {(path === "/plugins" || path === "/plugins/integrations") && (
          <PluginGroup
            desktop={desktop}
            forms={forms}
            ids={["anilist"]}
            plugins={state.plugins}
            title="Account integrations"
          />
        )}
        {children}
      </SettingsLayout>
    );
  });
