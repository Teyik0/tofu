import type { PluginId, PluginState } from "../../../../../package/plugins/src/plugin-model";
import { FieldGroup, FieldLegend, FieldSet } from "../../../../../package/ui/src/ui/field";
import type { PluginForms } from "../../lib/plugin-forms";
import { PluginCard } from "./_plugin-card";

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
  const selectedIds = new Set(ids);
  return (
    <FieldSet>
      <FieldLegend>{title}</FieldLegend>
      <FieldGroup className="settings-group plugins-group">
        {plugins
          .filter((plugin) => selectedIds.has(plugin.id))
          .map((plugin) => {
            const form = forms[plugin.id];
            return form ? (
              <PluginCard desktop={desktop} form={form} key={plugin.id} plugin={plugin} />
            ) : null;
          })}
      </FieldGroup>
    </FieldSet>
  );
}
