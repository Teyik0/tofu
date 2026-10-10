import { defineRoute } from "@teyik0/furin";
import { getRouteApi } from "@teyik0/furin/client";
import { startTransition } from "react";
import { OptionSelect } from "../../components/option-select";
import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field";
import { useSettingsAction } from "../../hooks/use-settings-action";
import type { ThemePreference } from "../../types";
import { route as options } from "./_route";

const themeOptions = [
  { label: "System (default)", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] satisfies { label: string; value: ThemePreference }[];

export const route = defineRoute()
  .config({ layout: options, mode: "ssr" })
  .head(() => ({ meta: [{ title: "Appearance settings — Tofu" }] }))
  .page(() => {
    const { dashboard } = getRouteApi("/options/appearance").useLoaderData();
    const { busy, dispatchAction, error } = useSettingsAction();
    return (
      <div aria-busy={busy}>
        <FieldSet>
          <FieldLegend>Interface</FieldLegend>
          <FieldGroup className="settings-group">
            <Field className="settings-row" orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="appearance-theme">Appearance</FieldLabel>
                <FieldDescription id="appearance-description">
                  Choose a theme. System follows your device’s appearance automatically.
                </FieldDescription>
              </FieldContent>
              <OptionSelect
                ariaDescribedBy="appearance-description"
                className="settings-select"
                disabled={busy}
                id="appearance-theme"
                onValueChange={(theme) =>
                  startTransition(() => dispatchAction({ settings: { theme }, type: "update" }))
                }
                options={themeOptions}
                value={dashboard.settings.theme}
              />
            </Field>
          </FieldGroup>
        </FieldSet>
        {error !== null && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
    );
  });
