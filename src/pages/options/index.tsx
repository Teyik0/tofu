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
import { route as options } from "./_route";

export const route = defineRoute()
  .config({ layout: options, mode: "ssr" })
  .head(() => ({ meta: [{ title: "General settings — Tofu" }] }))
  .page(() => {
    const { dashboard: data } = getRouteApi("/options").useLoaderData();
    const { dispatchAction, busy, error } = useSettingsAction();
    return (
      <div aria-busy={busy}>
        <FieldSet>
          <FieldLegend>Behavior</FieldLegend>
          <FieldGroup className="settings-group">
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
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <p className="settings-note">Your transfers and preferences are stored on this machine.</p>
      </div>
    );
  });
