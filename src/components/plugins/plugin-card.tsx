import { Form, getDeepError, handleSubmit, useField } from "@formisch/react";
import { useMutation } from "@teyik0/furin/client";
import { useRouter } from "@teyik0/furin/link";
import { ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { useRef, useState } from "react";
import { pluginCredentialPages } from "../../api/modules/plugins/service";
import { api } from "../../lib/client";
import { confirmPluginConfiguration } from "../../lib/plugin-forms";
import type { PluginConfiguration, PluginForm, PluginState } from "../../types";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button, buttonVariants } from "../ui/button";
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

export function PluginCard({
  plugin,
  form,
  desktop,
}: {
  plugin: PluginState;
  form: PluginForm;
  desktop: boolean;
}) {
  const router = useRouter();
  const configure = useMutation(api.plugins({ id: plugin.id }).put);
  const connect = useMutation(api.plugins({ id: plugin.id }).connect.post);
  const openCredentials = useMutation(api.plugins({ id: plugin.id }).credentials.open.post);
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
  const [isValidating, setValidating] = useState(false);
  const [isOpening, setOpening] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [rejectedKey, setRejectedKey] = useState<string | null>(null);
  const busy = isPending || form.isSubmitting;
  const run = async (command: PluginCommand) => {
    setPending(true);
    setFeedback({ error: null, keyRequired: false });
    setNotice(null);
    setRejectedKey(null);
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
        if (keyed && configuration.apiKey?.trim()) {
          setValidating(true);
          await connect.mutateAsync(configuration);
          setNotice("API key verified and saved.");
        } else {
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
                            hasApiKey: Boolean(configuration.apiKey?.trim()) || current.hasApiKey,
                          }
                        : current
                    ),
                  },
                }));
              }
            },
          });
        }
        confirmPluginConfiguration(form, {
          apiKey: configuration.apiKey,
          dailyLimit: configuration.dailyLimit ?? plugin.dailyLimit,
        });
      }
      setFeedback({ error: null, keyRequired: false });
    } catch (cause) {
      if (command.type === "configure" && keyed && command.configuration.apiKey?.trim()) {
        setRejectedKey(command.configuration.apiKey.trim());
        keyInput.current?.focus();
      }
      const value: unknown =
        cause && typeof cause === "object" && "value" in cause ? cause.value : null;
      setFeedback({
        error:
          value && typeof value === "object" && "error" in value && typeof value.error === "string"
            ? value.error
            : value &&
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
      setValidating(false);
    }
  };
  const keyRequired = feedback.keyRequired && !plugin.hasApiKey && !key.trim();
  const keyInvalid = keyRequired || rejectedKey === key.trim() || Boolean(keyField.errors);
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
    if (!enabled) {
      void run({ configuration: { enabled: false }, type: "configure" });
      return;
    }
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
          aria-label={`${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`}
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
              data-invalid={keyInvalid || undefined}
              orientation="responsive"
            >
              <FieldContent>
                <FieldLabel htmlFor={`key-${plugin.id}`}>
                  {plugin.id === "c411" ? "C411 API key or Torznab link" : "TypeSafe API key"}
                </FieldLabel>
                <FieldDescription>
                  {plugin.id === "jev"
                    ? "Get a key from TypeSafe, then paste it here. Validation uses one Jev call. Evaluated titles and metadata are sent to TypeSafe."
                    : "Open C411 API integrations, then paste your key or the full Torznab link. Tofu extracts the key automatically."}
                </FieldDescription>
                <FieldDescription id={`key-help-${plugin.id}`}>
                  {plugin.hasApiKey
                    ? "Your key is saved. Leave this field empty to keep it."
                    : "Validate and save once. Your key stays on the machine running Tofu."}
                </FieldDescription>
              </FieldContent>
              <Input
                {...keyField.props}
                aria-describedby={`key-help-${plugin.id}${keyInvalid ? ` ${errorId}` : ""}`}
                aria-invalid={keyInvalid || undefined}
                autoComplete="off"
                id={`key-${plugin.id}`}
                onChange={(event) => keyField.onChange(event.target.value)}
                placeholder={
                  plugin.hasApiKey
                    ? "Saved · type to replace"
                    : plugin.id === "c411"
                      ? "API key or Torznab link"
                      : "Your personal key"
                }
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
      {notice !== null && (
        <p className="automation-caption" role="status">
          {notice}
        </p>
      )}
      {(plugin.enabled || keyed || plugin.id === "anilist") && (
        <div className="plugins-plugin-actions">
          {keyed === true && (
            <a
              aria-disabled={isOpening || undefined}
              className={buttonVariants({ size: "sm", variant: "outline" })}
              href={pluginCredentialPages[plugin.id === "c411" ? "c411" : "jev"]}
              onClick={(event) => {
                if (!desktop) {
                  return;
                }
                event.preventDefault();
                if (isOpening) {
                  return;
                }
                setOpening(true);
                void openCredentials
                  .mutateAsync()
                  .catch(() =>
                    setFeedback({
                      error: "Unable to open the API key page in your browser",
                      keyRequired: false,
                    })
                  )
                  .finally(() => setOpening(false));
              }}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon data-icon="inline-start" />
              {plugin.id === "c411" ? "Open C411 API integrations" : "Get a TypeSafe API key"}
            </a>
          )}
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
              {isValidating ? (
                <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
              ) : null}
              {isValidating ? "Validating…" : key.trim() ? "Validate and save" : "Save"}
            </Button>
          )}
        </div>
      )}
    </article>
  );
}
