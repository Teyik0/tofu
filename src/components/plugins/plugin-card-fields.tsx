import { Form } from "@formisch/react";
import { ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";
import { pluginCredentialPages } from "../../api/modules/plugins/model";
import { Button, buttonVariants } from "../ui/button";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import type { PluginCardProps, usePluginCard } from "./use-plugin-card";

export function PluginCredentials({
  model,
  plugin,
  form,
}: Pick<PluginCardProps, "plugin" | "form"> & { model: ReturnType<typeof usePluginCard> }) {
  const {
    keyField,
    limitField,
    key,
    limit,
    keyInput,
    errorId,
    keyInvalid,
    configurePlugin,
    formId,
  } = model;
  return (
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
  );
}

export function PluginActions({
  model,
  plugin,
  desktop,
}: Pick<PluginCardProps, "plugin" | "desktop"> & { model: ReturnType<typeof usePluginCard> }) {
  const {
    router,
    openCredentials,
    key,
    keyed,
    setFeedback,
    isValidating,
    isOpening,
    setOpening,
    busy,
    run,
    dirty,
    formId,
  } = model;
  return (
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
  );
}
