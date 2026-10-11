import { FieldGroup, FieldLegend, FieldSet } from "@tofu/ui/field";
import type { PluginForms, PluginId, PluginState } from "../../types";
import { PluginCard } from "./plugin-card";

export function PluginGroup({
  desktop,
  forms,
  ids,
  title,
  plugins,
}: {
  desktop: boolean;
  forms: PluginForms;
  ids: readonly PluginId[];
  title: string;
  plugins: PluginState[];
}) {
  return (
    <FieldSet>
      <FieldLegend>{title}</FieldLegend>
      <FieldGroup className="settings-group plugins-group">
        {plugins
          .filter((plugin) => ids.includes(plugin.id))
          .map((plugin) => (
            <PluginCard desktop={desktop} form={forms[plugin.id]} key={plugin.id} plugin={plugin} />
          ))}
      </FieldGroup>
    </FieldSet>
  );
}
