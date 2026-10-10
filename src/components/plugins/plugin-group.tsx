import type { PluginId, PluginState } from "../../types";
import { FieldGroup, FieldLegend, FieldSet } from "../ui/field";
import { PluginCard } from "./plugin-card";

export function PluginGroup({
  ids,
  title,
  plugins,
}: {
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
            <PluginCard key={plugin.id} plugin={plugin} />
          ))}
      </FieldGroup>
    </FieldSet>
  );
}
