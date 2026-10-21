import { getDeepError, handleSubmit, useField } from "@formisch/react";
import { useMutation } from "@teyik0/furin/client";
import { useRouter } from "@teyik0/furin/link";
import { useRef, useState } from "react";
import type { PluginConfiguration, PluginState } from "../../api/modules/plugins/model";
import { api } from "../../lib/client";
import { errorMessage } from "../../lib/errors";
import type { PluginForm } from "../../lib/plugin-forms";
import { confirmPluginConfiguration } from "../../lib/plugin-forms";

type PluginCommand = { type: "configure"; configuration: PluginConfiguration } | { type: "test" };
interface PluginFeedback {
  error: string | null;
  keyRequired: boolean;
}
export interface PluginCardProps {
  desktop: boolean;
  form: PluginForm;
  plugin: PluginState;
}

export function usePluginCard({ plugin, form }: Pick<PluginCardProps, "plugin" | "form">) {
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
          // The server invalidates the plugins layout, which reloads the browser's plugin state.
          await configure.mutateAsync(configuration);
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
      setFeedback({
        error: errorMessage(cause, "Unable to update plugin"),
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

  return {
    busy,
    configurePlugin,
    dirty,
    error,
    errorId,
    formId,
    isOpening,
    isValidating,
    key,
    keyed,
    keyField,
    keyInput,
    keyInvalid,
    keyRequired,
    limit,
    limitField,
    notice,
    openCredentials,
    router,
    run,
    save,
    setFeedback,
    setOpening,
  };
}
