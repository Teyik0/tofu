import { defineRoute } from "@teyik0/furin";
import { getRouteApi } from "@teyik0/furin/client";
import { useAtom } from "jotai";
import type { ThemePreference } from "../../../../../../package/plugins/src/settings-model";
import { OptionSelect } from "../../../../../../package/ui/src/option-select";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../../../../../package/ui/src/ui/field";
import { themeAtom, themeStorageKey } from "../../../state/workspace";

const themeOptions = [
  { label: "System (default)", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
] satisfies { label: string; value: ThemePreference }[];

export const route = defineRoute("/options/appearance")
  .config({ mode: "ssr" })
  .head(() => ({ meta: [{ title: "Appearance settings — Tofu" }] }))
  .page(() => {
    const { dashboard } = getRouteApi("/options/appearance").useLoaderData();
    const [theme, setTheme] = useAtom(themeAtom);
    if (!dashboard) {
      return null;
    }
    return (
      <div>
        <FieldSet>
          <FieldLegend>Interface</FieldLegend>
          <FieldGroup className="settings-group">
            <Field className="settings-row" orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="appearance-theme">Appearance</FieldLabel>
                <FieldDescription id="appearance-description">
                  Applies to this device for {dashboard.server.name}. System follows your device’s
                  appearance automatically.
                </FieldDescription>
              </FieldContent>
              <OptionSelect
                ariaDescribedBy="appearance-description"
                className="settings-select"
                disabled={false}
                id="appearance-theme"
                onValueChange={(next) => {
                  window.localStorage.setItem(themeStorageKey(dashboard.server.id), next);
                  setTheme(next);
                }}
                options={themeOptions}
                value={theme}
              />
            </Field>
          </FieldGroup>
        </FieldSet>
      </div>
    );
  });
