import { usePluginHost } from "@tofu/plugins/client";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@tofu/ui/empty";
import { errorMessage } from "@tofu/ui/errors";
import { LockIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "../../../ui/src/ui/alert";
import { Button } from "../../../ui/src/ui/button";
import { Skeleton } from "../../../ui/src/ui/skeleton";
import { useAsyncAction } from "../../../ui/src/use-async-action";
import { api, coreClient } from "../client-api";
import { AniListHeader } from "../components/library-header";
import { LibrarySettings } from "../components/library-settings";
import { useAuthorizationPolling } from "../hooks/use-authorization-polling";
import { aniListContext } from "./_context";

export function AniListLayout({
  children,
  path,
  requestedAt,
}: {
  children: ReactNode;
  path: string;
  requestedAt: number;
}) {
  const { session, dashboard, refresh } = usePluginHost();
  const administer = session?.capabilities.administer === true;
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
          coreClient.automation.get({ fetch: { signal: controller.signal } }),
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
        <Empty className="access-required">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <LockIcon />
            </EmptyMedia>
            <EmptyTitle>AniList is managed by this server's owner</EmptyTitle>
            <EmptyDescription>
              AniList on {session.server.name} belongs to its owner. Your playback here never
              changes their AniList account.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
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
}
