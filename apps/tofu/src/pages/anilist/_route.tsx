import { defineRoute } from "@teyik0/furin";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { AniListHeader } from "../../../../../package/anilist/src/components/library-header";
import { LibrarySettings } from "../../../../../package/anilist/src/components/library-settings";
import { useAuthorizationPolling } from "../../../../../package/anilist/src/hooks/use-authorization-polling";
import { aniListContext } from "../../../../../package/anilist/src/pages/_context";
import { Alert, AlertDescription } from "../../../../../package/ui/src/ui/alert";
import { Button } from "../../../../../package/ui/src/ui/button";
import { Skeleton } from "../../../../../package/ui/src/ui/skeleton";
import { useAsyncAction } from "../../../../../package/ui/src/use-async-action";
import { AccessRequired } from "../../components/access-required";
import { api } from "../../lib/client";
import { errorMessage } from "../../lib/errors";
import { useRefresh } from "../../lib/navigation";
import { dashboardAtom, sessionAtom } from "../../state/workspace";

export const route = defineRoute("/anilist/_route")
  .config({ mode: "ssr" })
  // The account belongs to the server owner and is read by authorized browsers only.
  .loader(() => ({ requestedAt: Date.now() }))
  .layout(({ children, path, requestedAt }) => {
    const session = useAtomValue(sessionAtom);
    const dashboard = useAtomValue(dashboardAtom);
    const administer = session?.capabilities.administer === true;
    const refresh = useRefresh();
    const actions = useAsyncAction("Unable to update AniList");
    const [settings, setSettings] = useState(false);
    const [state, setState] = useState<React.ContextType<typeof aniListContext>>(null);
    const [error, setError] = useState<string | null>(null);
    const pollError = useAuthorizationPolling(
      administer && state?.anilist.authorizationPending === true && !settings,
      refresh
    );

    // biome-ignore lint/correctness/useExhaustiveDependencies: The loader epoch reloads privileged account data after a route refresh.
    useEffect(() => {
      if (!administer) {
        return;
      }
      const controller = new AbortController();
      const load = async () => {
        try {
          const [anilist, automation] = await Promise.all([
            api.anilist.get({ fetch: { signal: controller.signal } }),
            api.automation.get({ fetch: { signal: controller.signal } }),
          ]);
          if (controller.signal.aborted) {
            return;
          }
          if (anilist.error || automation.error) {
            setError(errorMessage(anilist.error ?? automation.error, "Unable to load AniList"));
            return;
          }
          setError(null);
          setState({
            anilist: anilist.data,
            automation: automation.data,
            openSettings: () => setSettings(true),
          });
        } catch (cause) {
          if (!controller.signal.aborted) {
            setError(errorMessage(cause, "Unable to load AniList"));
          }
        }
      };
      void load();
      return () => controller.abort();
    }, [administer, requestedAt]);

    if (session && !administer) {
      return (
        <main className="anilist-library">
          <AccessRequired
            description={`AniList on ${session.server.name} belongs to its owner. Your playback here never changes their AniList account.`}
            title="AniList is managed by this server's owner"
          />
        </main>
      );
    }

    return (
      <main aria-busy={!(state || error)} className="anilist-library">
        {state ? (
          <AniListHeader
            actions={actions}
            openSettings={state.openSettings}
            path={path}
            state={state.anilist}
          />
        ) : (
          <header className="library-topbar anilist-page-header">
            <Skeleton className="h-6 w-28" />
            <Skeleton className="h-9 w-64" />
          </header>
        )}
        {error || actions.error || pollError ? (
          <div className="anilist-page-body">
            <Alert>
              <AlertDescription>
                {error ?? actions.error ?? pollError}
                <Button
                  disabled={actions.busy}
                  onClick={() => actions.action(refresh)}
                  size="sm"
                  variant="link"
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        {administer && state ? (
          <aniListContext.Provider value={state}>{children}</aniListContext.Provider>
        ) : null}
        {settings && state && dashboard ? (
          <LibrarySettings
            automationState={state.automation}
            close={() => setSettings(false)}
            dashboard={dashboard}
            state={state.anilist}
          />
        ) : null}
      </main>
    );
  });
