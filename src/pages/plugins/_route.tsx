import { defineRoute } from "@teyik0/furin";
import { useRouter } from "@teyik0/furin/link";
import { useAtomValue } from "jotai";
import { BrainCircuitIcon, CableIcon, GlobeIcon, PlugIcon, RefreshCwIcon } from "lucide-react";
import { startTransition, useActionState, useEffect, useState } from "react";
import { AccessRequired, SettingsSkeleton } from "../../components/access-required";
import { SettingsLayout } from "../../components/settings-layout";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { usePluginForms } from "../../hooks/use-plugin-forms";
import { api } from "../../lib/client";
import { errorMessage } from "../../lib/errors";
import { isSupersededNavigation } from "../../lib/navigation";
import { sessionAtom } from "../../state/workspace";
import type { AutomationState } from "../../types";
import { PluginGroup } from "./_plugin-group";

const sections = [
  { icon: PlugIcon, label: "Installed", to: "/plugins" },
  { icon: GlobeIcon, label: "Sources", to: "/plugins/sources" },
  { icon: BrainCircuitIcon, label: "Intelligence", to: "/plugins/intelligence" },
  { icon: CableIcon, label: "Integrations", to: "/plugins/integrations" },
] as const;

export const route = defineRoute("/plugins/_route")
  .config({ mode: "ssr" })
  // Plugin credentials and configuration are read by authorized browsers after mount.
  .loader(() => ({ requestedAt: Date.now() }))
  .layout(({ children, path, requestedAt }) => {
    const router = useRouter();
    const session = useAtomValue(sessionAtom);
    const administer = session?.capabilities.administer === true;
    const desktop = session?.capabilities.hostNative === true;
    const [loaded, setLoaded] = useState<{ state: AutomationState } | { error: string } | null>(
      null
    );
    // biome-ignore lint/correctness/useExhaustiveDependencies: The loader epoch invalidates privileged browser reads after a successful route refresh.
    useEffect(() => {
      if (!administer) {
        return;
      }
      let active = true;
      const load = async () => {
        const { data, error } = await api.automation.get();
        if (active) {
          setLoaded(
            error ? { error: errorMessage(error, "Unable to load plugins") } : { state: data }
          );
        }
      };
      void load();
      return () => {
        active = false;
      };
    }, [administer, requestedAt]);

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

    let content = <SettingsSkeleton label="Loading plugins" />;
    if (session && !administer) {
      content = (
        <AccessRequired
          description={`Plugins and their credentials belong to ${session.server.name} and are managed by its administrators.`}
          title="Administration access required"
        />
      );
    } else if (loaded && "error" in loaded) {
      content = (
        <Alert variant="destructive">
          <AlertDescription>{loaded.error}</AlertDescription>
        </Alert>
      );
    } else if (loaded) {
      content = <PluginSections desktop={desktop} path={path} state={loaded.state} />;
    }
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
          Plugins on {session?.server.name ?? "this server"}. Enable the sources and integrations it
          uses.
        </p>
        {refreshError ? (
          <Alert>
            <AlertDescription>{refreshError}</AlertDescription>
          </Alert>
        ) : null}
        {content}
        {children}
      </SettingsLayout>
    );
  });

function PluginSections({
  desktop,
  path,
  state,
}: {
  desktop: boolean;
  path: string;
  state: AutomationState;
}) {
  const forms = usePluginForms(state.plugins);
  return (
    <>
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
    </>
  );
}
