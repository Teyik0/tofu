import { EdenFetchError } from "@elysia/eden";
import { useMutation } from "@teyik0/furin/client";
import { useRouter } from "@teyik0/furin/link";
import { startTransition, useActionState, useRef } from "react";
import { api } from "../../lib/client";
import { usePluginDrafts } from "../../pages/plugins/_route";
import type { PluginState } from "../../types";
import { Alert, AlertDescription } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";

type PluginCommand =
  | { type: "configure"; configuration: Parameters<ReturnType<typeof api.plugins>["put"]>[0] }
  | { type: "test" };
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

export function PluginCard({ plugin }: { plugin: PluginState }) {
  const router = useRouter();
  const configure = useMutation(api.plugins({ id: plugin.id }).put);
  const testConnection = useMutation(api.plugins({ id: plugin.id }).test.post);
  const { drafts, updateDraft } = usePluginDrafts();
  const key = drafts[plugin.id]?.apiKey ?? "";
  const limit = drafts[plugin.id]?.dailyLimit ?? String(plugin.dailyLimit);
  const setKey = (apiKey: string) => updateDraft(plugin.id, { apiKey });
  const setLimit = (dailyLimit: string) => updateDraft(plugin.id, { dailyLimit });
  const keyInput = useRef<HTMLInputElement>(null);
  const keyed = plugin.id === "jev" || plugin.id === "c411";
  const errorId = `plugin-error-${plugin.id}`;
  const [feedback, dispatchAction, isPending] = useActionState<PluginFeedback, PluginCommand>(
    async (_previous, command) => {
      if (
        command.type === "configure" &&
        command.configuration.enabled &&
        keyed &&
        !plugin.hasApiKey &&
        !command.configuration.apiKey
      ) {
        keyInput.current?.focus();
        return {
          error: `Add your ${plugin.id === "jev" ? "TypeSafe" : "C411"} API key before enabling this plugin.`,
          keyRequired: true,
        };
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
          startTransition(() =>
            updateDraft(plugin.id, (current) =>
              current.apiKey.trim() === configuration.apiKey ? { apiKey: "" } : {}
            )
          );
        }
        return { error: null, keyRequired: false };
      } catch (cause) {
        const value: unknown = cause instanceof EdenFetchError ? cause.value : null;
        return {
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
        };
      }
    },
    { error: null, keyRequired: false }
  );
  const keyRequired = feedback.keyRequired && !plugin.hasApiKey && !key.trim();
  const error = isPending || (feedback.keyRequired && !keyRequired) ? null : feedback.error;
  const save = (enabled: boolean) => {
    dispatchAction({
      configuration: {
        enabled,
        ...(key.trim() ? { apiKey: key.trim() } : {}),
        dailyLimit: Number(limit),
      },
      type: "configure",
    });
  };
  const dirty = key.trim() !== "" || limit !== String(plugin.dailyLimit);
  const formId = `plugin-form-${plugin.id}`;
  return (
    <article aria-busy={isPending} aria-label={plugin.name} className="plugin-card plugins-plugin">
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
          disabled={isPending}
          id={`plugin-${plugin.id}`}
          onCheckedChange={(enabled) => startTransition(() => save(enabled))}
        />
      </Field>
      {keyed === true && (
        <form action={() => save(plugin.enabled)} id={formId}>
          <FieldGroup className="plugins-configuration">
            <Field
              className="plugins-credential"
              data-invalid={keyRequired || undefined}
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
                aria-invalid={keyRequired || undefined}
                autoComplete="off"
                disabled={isPending}
                id={`key-${plugin.id}`}
                onChange={(event) => setKey(event.target.value)}
                placeholder={plugin.hasApiKey ? "Saved · type to replace" : "Your personal key"}
                ref={keyInput}
                type="password"
                value={key}
              />
            </Field>
            {plugin.id === "jev" && (
              <Field className="plugins-limit" orientation="horizontal">
                <FieldContent>
                  <FieldLabel htmlFor="jev-daily-limit">Daily call limit</FieldLabel>
                  <FieldDescription>
                    {plugin.callsToday} call{plugin.callsToday === 1 ? "" : "s"} today · cached
                    evaluations are not billed again.
                  </FieldDescription>
                </FieldContent>
                <Input
                  disabled={isPending}
                  id="jev-daily-limit"
                  max="100000"
                  min="1"
                  onChange={(event) => setLimit(event.target.value)}
                  required
                  type="number"
                  value={limit}
                />
              </Field>
            )}
          </FieldGroup>
        </form>
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
              disabled={isPending}
              onClick={() => startTransition(() => dispatchAction({ type: "test" }))}
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
              disabled={isPending || !dirty}
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
