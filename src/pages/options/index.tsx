import { defineRoute } from "@teyik0/furin";
import { getRouteApi } from "@teyik0/furin/client";
import { startTransition } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field";
import { Switch } from "../../components/ui/switch";
import { useSettingsAction } from "../../hooks/use-settings-action";
import { api } from "../../lib/client";
import { route as options } from "./_route";

export const route = defineRoute()
  .config({ layout: options, mode: "ssr" })
  .loader(async () => {
    const { data, error } = await api.instance.get();
    if (error !== null) {
      throw error;
    }
    return { instance: data };
  })
  .head(() => ({ meta: [{ title: "General settings — Tofu" }] }))
  .page(({ instance }) => {
    const { dashboard: data } = getRouteApi("/options").useLoaderData();
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
                      Permanently delete the original .torrent file after a successful import from
                      your file manager. Downloaded content is kept. Browser uploads and
                      drag-and-drop imports keep the original file.
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
                  {data.session.mode !== "desktop" &&
                    " Logs are stored on the machine hosting Tofu."}
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
  });
