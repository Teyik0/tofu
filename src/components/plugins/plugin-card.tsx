import { EdenFetchError } from "@elysia/eden";
import { Form, getDeepError, handleSubmit, useField } from "@formisch/react";
import { useMutation } from "@teyik0/furin/client";
import { useRouter } from "@teyik0/furin/link";
import { useRef, useState } from "react";
import { api } from "../../lib/client";
import { confirmPluginConfiguration } from "../../lib/plugin-forms";
import type { PluginConfiguration, PluginForm, PluginState } from "../../types";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

type PluginCommand = { type: "configure"; configuration: PluginConfiguration } | { type: "test" };
interface PluginFeedback {
  error: string | null;
  keyRequired: boolean;
}
const pluginPaths = [
  "/plugins",
  "/plugins/sources",
  "/plugins/intelligence",
  "/plugins/integrations",
] as const;

export function PluginCard({ plugin, form }: { plugin: PluginState; form: PluginForm }) {
  const router = useRouter();
  const configure = useMutation(api.plugins({ id: plugin.id }).put);
  const testConnection = useMutation(api.plugins({ id: plugin.id }).test.post);
  const keyField = useField(form, { path: ["apiKey"] });
  const limitField = useField(form, { path: ["dailyLimit"] });
  const key = keyField.input ?? "";
  const limit = limitField.input ?? String(plugin.dailyLimit);
  const keyInput = useRef<HTMLInputElement>(null);
  const keyed = plugin.id === "jev" || plugin.id === "c411";
  const errorId = `plugin-error-${plugin.id}`;
  const [feedback, setFeedback] = useState<PluginFeedback>({ error: null, keyRequired: false });
  const [isPending, setPending] = useState(false);
  const busy = isPending || form.isSubmitting;
  const run = async (command: PluginCommand) => {
    setPending(true);
    setFeedback({ error: null, keyRequired: false });
    if (
      command.type === "configure" &&
      command.configuration.enabled &&
      keyed &&
      !plugin.hasApiKey &&
      !command.configuration.apiKey
    ) {
      keyInput.current?.focus();
      setPending(false);
      setFeedback({
        error: `Add your ${plugin.id === "jev" ? "TypeSafe" : "C411"} API key before enabling this plugin.`,
        keyRequired: true,
      });
      return;
    }
    try {
      if (command.type === "test") {
        await testConnection.mutateAsync();
      } else {
        const { configuration } = command;
        await configure.mutateAsync(configuration, {
          optimistic(cache) {
            for (const path of pluginPaths) {
              cache.update(path, (data) => ({
                ...data,
                initialAutomation: {
                  ...data.initialAutomation,
                  plugins: data.initialAutomation.plugins.map((current) =>
                    current.id === plugin.id
                      ? {
                          ...current,
                          dailyLimit: configuration.dailyLimit ?? current.dailyLimit,
                          enabled: configuration.enabled,
                          error: null,
                        }
                      : current
                  ),
                },
              }));
            }
          },
        });
        confirmPluginConfiguration(form, {
          apiKey: configuration.apiKey,
          dailyLimit: configuration.dailyLimit ?? plugin.dailyLimit,
        });
      }
      setFeedback({ error: null, keyRequired: false });
    } catch (cause) {
      const value: unknown = cause instanceof EdenFetchError ? cause.value : null;
      setFeedback({
        error:
          value &&
          typeof value === "object" &&
          "detail" in value &&
          typeof value.detail === "string"
            ? value.detail
            : cause instanceof Error
              ? cause.message
              : "Unable to update plugin",
        keyRequired: false,
      });
    } finally {
      setPending(false);
    }
  };
  const keyRequired = feedback.keyRequired && !plugin.hasApiKey && !key.trim();
  const error =
    getDeepError(form) ?? (busy || (feedback.keyRequired && !keyRequired) ? null : feedback.error);
  const configurePlugin = async (
    configuration: { apiKey: string; dailyLimit: number },
    enabled: boolean
  ) => {
    await run({
      configuration: {
        enabled,
        ...(configuration.apiKey.trim() ? { apiKey: configuration.apiKey.trim() } : {}),
        dailyLimit: configuration.dailyLimit,
      },
      type: "configure",
    });
  };
  const save = (enabled: boolean) => {
    void handleSubmit(form, (configuration) => configurePlugin(configuration, enabled))();
  };
  const dirty = key.trim() !== "" || limit !== String(plugin.dailyLimit);
  const formId = `plugin-form-${plugin.id}`;
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
          aria-label={`Enable ${plugin.name}`}
          checked={plugin.enabled}
          disabled={busy}
          id={`plugin-${plugin.id}`}
          onCheckedChange={save}
        />
      </Field>
      {keyed === true && (
        <Form
          id={formId}
          of={form}
          onSubmit={(configuration) => configurePlugin(configuration, plugin.enabled)}
        >
          <FieldGroup className="plugins-configuration">
            <Field
              className="plugins-credential"
              data-invalid={keyRequired || Boolean(keyField.errors) || undefined}
              orientation="responsive"
            >
              <FieldContent>
                <FieldLabel htmlFor={`key-${plugin.id}`}>
                  {`${plugin.id === "jev" ? "TypeSafe" : "C411"} API key`}
                </FieldLabel>
                <FieldDescription>
                  {plugin.id === "jev"
                    ? "A TypeSafe API key is required to enable Jev. Without Jev, use keywords or an exact title or pattern. Evaluated titles and metadata are sent to TypeSafe."
                    : "Available in C411 → API integrations. The key stays on the server."}
                </FieldDescription>
              </FieldContent>
              <Input
                aria-describedby={keyRequired ? errorId : undefined}
                aria-invalid={keyRequired || Boolean(keyField.errors) || undefined}
                autoComplete="off"
                {...keyField.props}
                id={`key-${plugin.id}`}
                onChange={(event) => keyField.onChange(event.target.value)}
                placeholder={plugin.hasApiKey ? "Saved · type to replace" : "Your personal key"}
                ref={(element) => {
                  keyInput.current = element;
                  keyField.props.ref(element);
                }}
                type="password"
                value={key}
              />
            </Field>
            {plugin.id === "jev" && (
              <Field
                className="plugins-limit"
                data-invalid={Boolean(limitField.errors)}
                orientation="horizontal"
              >
                <FieldContent>
                  <FieldLabel htmlFor="jev-daily-limit">Daily call limit</FieldLabel>
                  <FieldDescription>
                    {plugin.callsToday} call{plugin.callsToday === 1 ? "" : "s"} today · cached
                    evaluations are not billed again.
                  </FieldDescription>
                </FieldContent>
                <Input
                  {...limitField.props}
                  aria-invalid={Boolean(limitField.errors)}
                  id="jev-daily-limit"
                  max="100000"
                  min="1"
                  onChange={(event) => limitField.onChange(event.target.value)}
                  required
                  type="number"
                  value={limit}
                />
              </Field>
            )}
          </FieldGroup>
        </Form>
      )}
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
      {(plugin.enabled || keyed || plugin.id === "anilist") && (
        <div className="plugins-plugin-actions">
          {plugin.enabled === true && (
            <Button
              disabled={busy}
              onClick={() => void run({ type: "test" })}
              size="sm"
              variant="outline"
            >
              Test connection
            </Button>
          )}
          {plugin.id === "anilist" && (
            <Button
              onClick={() => {
                void router.navigate({ to: "/anilist" });
              }}
              size="sm"
              variant="outline"
            >
              Open AniList
            </Button>
          )}
          {plugin.checkedAt !== null && (
            <span className="automation-caption">
              Checked at {new Date(plugin.checkedAt).toLocaleTimeString("en-US")}
            </span>
          )}
          {keyed === true && (
            <Button
              className="plugins-save"
              disabled={busy || !dirty}
              form={formId}
              size="sm"
              type="submit"
            >
              Save
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
