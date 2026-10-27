import { defineRoute } from "@teyik0/furin";
import { useAtomValue } from "jotai";
import { startTransition, useEffect, useState } from "react";
import { Alert, AlertDescription } from "../../../../../package/ui/src/ui/alert";
import { Button } from "../../../../../package/ui/src/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../../../package/ui/src/ui/field";
import { Switch } from "../../../../../package/ui/src/ui/switch";
import type { HostState } from "../../api/modules/dashboard/projection";
import { AccessRequired, SettingsSkeleton } from "../../components/access-required";
import { useSettingsAction } from "../../hooks/use-settings-action";
import { api } from "../../lib/client";
import { errorMessage } from "../../lib/errors";
import { dashboardAtom, sessionAtom } from "../../state/workspace";

export const route = defineRoute("/options")
  .config({ mode: "ssr" })
  // Host instance details are read by the owner's browser, never during server rendering.
  .loader(() => ({ requestedAt: Date.now() }))
  .head(() => ({ meta: [{ title: "General settings — Tofu" }] }))
  .page(({ requestedAt }) => {
    const live = useAtomValue(dashboardAtom);
    const session = useAtomValue(sessionAtom);
    const owner = session?.capabilities.owner === true;
    const [instance, setInstance] = useState<{
      data: Awaited<ReturnType<typeof api.instance.get>>["data"];
      error: string | null;
    } | null>(null);
    // biome-ignore lint/correctness/useExhaustiveDependencies: The loader epoch invalidates privileged browser reads after a successful route refresh.
    useEffect(() => {
      if (!owner) {
        return;
      }
      let active = true;
      const load = async () => {
        const { data, error } = await api.instance.get();
        if (active) {
          setInstance({
            data,
            error: error ? errorMessage(error, "Unable to read this server") : null,
          });
        }
      };
      void load();
      return () => {
        active = false;
      };
    }, [owner, requestedAt]);
    if (session && !owner) {
      return (
        <AccessRequired
          description={`Startup, background mode and logs are managed on ${session.server.name} itself. Appearance and your connection are available in this device's settings.`}
          title={`Managed on ${session.server.name}`}
        />
      );
    }
    if (instance?.error) {
      return (
        <Alert variant="destructive">
          <AlertDescription>{instance.error}</AlertDescription>
        </Alert>
      );
    }
    if (!(session && live?.host && instance?.data)) {
      return <SettingsSkeleton label="Loading general settings" />;
    }
    return (
      <GeneralSettings
        hostNative={session.capabilities.hostNative}
        instance={instance.data}
        settings={live.host.settings}
      />
    );
  });

function GeneralSettings({
  hostNative,
  instance,
  settings,
}: {
  hostNative: boolean;
  instance: NonNullable<Awaited<ReturnType<typeof api.instance.get>>["data"]>;
  settings: HostState["settings"];
}) {
  const data = { session: { mode: hostNative ? "desktop" : "server" }, settings };
  const { dispatchAction, busy, error, feedback } = useSettingsAction();
  return (
    <div aria-busy={busy}>
      <FieldSet>
        <FieldLegend>Behavior</FieldLegend>
        <FieldGroup className="settings-group">
          {data.session.mode === "desktop" && (
            <>
              <Field className="settings-row" orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="default-torrent-app">
                    Default .torrent application
                  </FieldLabel>
                  <FieldDescription id="default-torrent-app-description">
                    {instance.profile === "release"
                      ? "Open .torrent files from your file manager with Tofu. Your system may ask you to choose Tofu in its default application settings."
                      : "Use the installed release of Tofu to change default applications. Development builds keep your current associations."}
                  </FieldDescription>
                </FieldContent>
                <Button
                  aria-describedby="default-torrent-app-description"
                  disabled={busy || instance.profile !== "release"}
                  id="default-torrent-app"
                  onClick={() =>
                    startTransition(() => dispatchAction({ type: "default-torrent-app" }))
                  }
                  variant="outline"
                >
                  Set Tofu as default
                </Button>
              </Field>
              <Field className="settings-row" orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="delete-torrent-file-after-add">
                    Delete .torrent file after adding
                  </FieldLabel>
                  <FieldDescription id="delete-torrent-file-after-add-description">
                    Permanently delete the original .torrent file after it is added from your file
                    manager or a watched thread folder. Each thread can override this. Downloaded
                    content is kept. Browser uploads and drag-and-drop imports keep the original
                    file.
                  </FieldDescription>
                </FieldContent>
                <Switch
                  aria-describedby="delete-torrent-file-after-add-description"
                  checked={data.settings.deleteTorrentFileAfterAdd}
                  disabled={busy}
                  id="delete-torrent-file-after-add"
                  onCheckedChange={(deleteTorrentFileAfterAdd) =>
                    startTransition(() =>
                      dispatchAction({ settings: { deleteTorrentFileAfterAdd }, type: "update" })
                    )
                  }
                />
              </Field>
            </>
          )}
          {data.session.mode === "desktop" ? (
            <Field className="settings-row" orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="run-in-background">Run in background</FieldLabel>
                <FieldDescription>
                  Keep transfers and automations running when you close the window. Use the system
                  tray icon to reopen Tofu. Quit Tofu stops the server.
                </FieldDescription>
              </FieldContent>
              <Switch
                checked={data.settings.runInBackground}
                disabled={busy}
                id="run-in-background"
                onCheckedChange={(runInBackground) =>
                  startTransition(() =>
                    dispatchAction({ settings: { runInBackground }, type: "update" })
                  )
                }
              />
            </Field>
          ) : (
            <Field className="settings-row">
              <FieldContent>
                <FieldLabel>Web workspace</FieldLabel>
                <FieldDescription>
                  Transfers continue on the server when you close this browser tab.
                </FieldDescription>
              </FieldContent>
            </Field>
          )}
          {data.session.mode === "desktop" && data.settings.runInBackground && (
            <Field className="settings-row" orientation="horizontal">
              <FieldContent>
                <FieldLabel>Background mode</FieldLabel>
                <FieldDescription>
                  Hide the window and keep Tofu running in the system tray.
                </FieldDescription>
              </FieldContent>
              <Button
                disabled={busy}
                onClick={() => startTransition(() => dispatchAction({ type: "background" }))}
                variant="outline"
              >
                Switch to background mode now
              </Button>
            </Field>
          )}
        </FieldGroup>
      </FieldSet>
      <FieldSet>
        <FieldLegend>Diagnostics</FieldLegend>
        <FieldGroup className="settings-group">
          <Field className="settings-row" orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={data.session.mode === "desktop" ? "open-logs" : undefined}>
                Application logs
              </FieldLabel>
              <FieldDescription id="open-logs-description">
                Local logs help diagnose errors and are kept across restarts.
                {data.session.mode !== "desktop" && " Logs are stored on the machine hosting Tofu."}
              </FieldDescription>
            </FieldContent>
            {data.session.mode === "desktop" && (
              <Button
                aria-describedby="open-logs-description"
                disabled={busy}
                id="open-logs"
                onClick={() => startTransition(() => dispatchAction({ type: "open-logs" }))}
                variant="outline"
              >
                Open logs folder
              </Button>
            )}
          </Field>
        </FieldGroup>
      </FieldSet>
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {feedback !== null && (
        <p aria-live="polite" className="settings-feedback" role="status">
          {feedback}
        </p>
      )}
      <p className="settings-note">Your transfers and preferences are stored on this machine.</p>
    </div>
  );
}
