import type { PluginState } from "../../../../../package/plugins/src/plugin-model";
import { Alert, AlertDescription } from "../../../../../package/ui/src/ui/alert";
import { Badge } from "../../../../../package/ui/src/ui/badge";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
} from "../../../../../package/ui/src/ui/field";
import { Switch } from "../../../../../package/ui/src/ui/switch";
import type { PluginForm } from "../../lib/plugin-forms";
import { PluginActions, PluginCredentials } from "./_plugin-card-fields";
import { usePluginCard } from "./_use-plugin-card";

export function PluginCard({
  plugin,
  form,
  desktop,
}: {
  plugin: PluginState;
  form: PluginForm;
  desktop: boolean;
}) {
  const model = usePluginCard({ form, plugin });
  const { keyed, errorId, notice, busy, error, save } = model;
  return (
    <article aria-busy={busy} aria-label={plugin.name} className="plugin-card plugins-plugin">
      <Field orientation="horizontal">
        <FieldContent>
          <div className="plugins-plugin-title">
            <FieldLabel htmlFor={`plugin-${plugin.id}`}>{plugin.name}</FieldLabel>
            <Badge variant={plugin.enabled ? "secondary" : "outline"}>
              {plugin.enabled ? "Enabled" : "Disabled"}
            </Badge>
          </div>
          <FieldDescription>{plugin.description}</FieldDescription>
        </FieldContent>
        <Switch
          aria-describedby={error || plugin.error ? errorId : undefined}
          aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
          checked={plugin.enabled}
          disabled={busy}
          id={`plugin-${plugin.id}`}
          onCheckedChange={save}
        />
      </Field>
      {keyed === true && <PluginCredentials form={form} model={model} plugin={plugin} />}
      {plugin.id === "anilist" && (
        <FieldDescription>
          Connect your account from the AniList page. No API key is required.
        </FieldDescription>
      )}
      {(error !== null || plugin.error !== null) && (
        <Alert id={errorId} variant="destructive">
          <AlertDescription>{error ?? plugin.error}</AlertDescription>
        </Alert>
      )}
      {notice !== null && (
        <p className="automation-caption" role="status">
          {notice}
        </p>
      )}
      {(plugin.enabled || keyed || plugin.id === "anilist") && (
        <PluginActions desktop={desktop} model={model} plugin={plugin} />
      )}
    </article>
  );
}
