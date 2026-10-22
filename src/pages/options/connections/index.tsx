import { defineRoute } from "@teyik0/furin";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { SettingsSkeleton } from "../../../components/access-required";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";
import { sessionAtom } from "../../../state/workspace";
import { AuthorizedDevices } from "./_authorized-devices";
import { DesktopServers } from "./_desktop-servers";
import { LinkedLibraries } from "./_linked-libraries";
import { NetworkAccess } from "./_network-access";
import { OwnConnection } from "./_own-connection";
import { ServerAddresses } from "./_server-addresses";

export type ConnectionsState = NonNullable<Awaited<ReturnType<typeof api.connections.get>>["data"]>;

export const route = defineRoute("/options/connections")
  .config({ mode: "ssr" })
  // Remote access configuration is read by administrators' browsers, never while rendering.
  .loader(() => ({ requestedAt: Date.now() }))
  .head(() => ({ meta: [{ title: "Connections — Tofu" }] }))
  .page(({ requestedAt }) => {
    const session = useAtomValue(sessionAtom);
    const administer = session?.capabilities.administer === true;
    const [state, setState] = useState<ConnectionsState | null>(null);
    const [error, setError] = useState<string | null>(null);
    const reload = useCallback(async () => {
      const { data, error: failure } = await api.connections.get();
      if (failure) {
        setError(errorMessage(failure, "Unable to read connections"));
        return;
      }
      setError(null);
      setState(data);
    }, []);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The loader epoch invalidates privileged browser reads after a successful route refresh.
    useEffect(() => {
      if (administer) {
        void reload();
      }
    }, [administer, reload, requestedAt]);
    if (!session) {
      return <SettingsSkeleton label="Checking your session" />;
    }
    if (!administer) {
      return <OwnConnection session={session} />;
    }
    return (
      <div className="connections">
        <div className="connections-intro">
          <h2>Connect your devices</h2>
          <p>Share {session.server.name}'s library and play from another Tofu or browser.</p>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {state ? (
          <>
            <NetworkAccess onChanged={reload} session={session} state={state} />
            <ServerAddresses state={state} />
          </>
        ) : (
          <SettingsSkeleton label="Loading network access" />
        )}
        {session.caller.kind === "device" && session.caller.deviceKind === "browser" ? (
          <Button nativeButton={false} render={<a href="/session-transfer" />} variant="outline">
            Move connection to another browser
          </Button>
        ) : null}
        <AuthorizedDevices session={session} state={state} />
        {session.capabilities.hostNative ? <DesktopServers /> : null}
        <LinkedLibraries />
        <p className="connections-footnote">
          Devices need both a working connection and an invitation. Turning off remote access keeps
          your local files and downloads.
        </p>
      </div>
    );
  });
