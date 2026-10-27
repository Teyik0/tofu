import { useMutation } from "@teyik0/furin/client";
import { Link } from "@teyik0/furin/link";
import { usePluginHost } from "@tofu/plugins/client";
import type { LiveState } from "@tofu/plugins/library-state";
import { CompactAutomationFields } from "@tofu/ui/compact-automation-fields";
import { CheckIcon, LoaderCircleIcon, XIcon, ZapIcon } from "lucide-react";
import { useId } from "react";
import type {
  AutomationDraft,
  AutomationRule,
  AutomationState,
} from "../../../../plugins/src/automation-model";
import { interpretLocally } from "../../../../plugins/src/automation-rules";
import { ActionTooltip } from "../../../../ui/src/action-tooltip";
import { Alert, AlertDescription } from "../../../../ui/src/ui/alert";
import { Badge } from "../../../../ui/src/ui/badge";
import { Button } from "../../../../ui/src/ui/button";
import { Checkbox } from "../../../../ui/src/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../../../../ui/src/ui/field";
import { useAsyncAction } from "../../../../ui/src/use-async-action";
import { api } from "../../client-api";
import { useAutomationDraftForm } from "../../hooks/use-automation-draft-form";
import type { AniListEntry, AniListMedia } from "../../server/types";

export function NotificationAutomation({
  entry,
  rule,
  automation,
  dashboard,
  close,
  id,
}: {
  entry: AniListMedia | AniListEntry;
  rule: AutomationRule | undefined;
  automation: AutomationState;
  dashboard: LiveState;
  close: () => void;
  id: string;
}) {
  const prefix = useId();
  const { refresh } = usePluginHost();
  const { busy, error: actionError, action } = useAsyncAction("Unable to save anime automation");
  const save = useMutation((body: AutomationDraft) =>
    api.anilist.entries({ mediaId: entry.mediaId }).automation.put(body)
  );
  const addToList = useMutation(api.anilist.entries({ mediaId: entry.mediaId }).editor.put);
  const destinations = dashboard.host?.destinations ?? [];
  const listed = "progress" in entry;
  const {
    draft,
    setDraft,
    error: validationError,
    validatedDraft,
  } = useAutomationDraftForm(
    rule ?? {
      ...interpretLocally(
        `Download "${entry.title}"`,
        destinations.find((destination) => destination.id === "default")?.id ??
          destinations[0]?.id ??
          "default",
        automation.preferences
      ),
      afterEpisode: listed ? entry.progress : 0,
      aliases: entry.aliases,
      includeExisting: true,
      title: entry.title,
    }
  );
  if (!draft) {
    return null;
  }
  const error = actionError ?? validationError;
  const active = rule?.enabled === true;
  const SaveIcon = active ? CheckIcon : ZapIcon;
  let saveLabel = listed ? "Enable automation" : "Add to Watching & enable";
  if (active) {
    saveLabel = "Save changes";
  }
  const availableSources = automation.plugins.filter(
    (plugin) => plugin.enabled && draft.sources.includes(plugin.id)
  );

  return (
    <section aria-labelledby={`${prefix}-heading`} className="notification-automation" id={id}>
      <div className="notification-automation-heading">
        <ZapIcon aria-hidden="true" />
        <h4 id={`${prefix}-heading`}>Automatic downloads</h4>
        <Badge variant="secondary">This anime</Badge>
        <ActionTooltip>
          <Button
            aria-label="Close automation settings"
            disabled={busy}
            onClick={close}
            size="icon-sm"
            variant="ghost"
          >
            <XIcon />
          </Button>
        </ActionTooltip>
      </div>
      <p className="notification-automation-intro">
        {rule
          ? "Update this anime’s rule. Its other preferences and download history are kept."
          : "Your default preferences, ready to use. Adjust only what this anime needs."}
      </p>
      {error || rule?.error ? (
        <Alert>
          <AlertDescription>{error ?? rule?.error}</AlertDescription>
        </Alert>
      ) : null}
      {listed ? null : (
        <p className="notification-automation-note">
          Enabling automation also adds this anime to your AniList Watching list.
        </p>
      )}
      {availableSources.length ? null : (
        <Alert>
          <AlertDescription>
            No selected source is enabled. Choose a source below or enable one in{" "}
            <Link to="/plugins">Plugins</Link>.
          </AlertDescription>
        </Alert>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          action(async () => {
            const validated = await validatedDraft();
            if (!validated) {
              return;
            }
            if (!listed) {
              await addToList.mutateAsync({ status: "CURRENT" });
            }
            await save.mutateAsync({ ...validated, enabled: true });
            await refresh();
            close();
          });
        }}
      >
        <CompactAutomationFields
          busy={busy}
          destinations={destinations}
          draft={draft}
          onChange={setDraft}
          prefix={prefix}
        >
          <Field className="notification-automation-catchup" orientation="horizontal">
            <Checkbox
              checked={draft.includeExisting}
              disabled={busy || Boolean(rule)}
              id={`${prefix}-existing`}
              onCheckedChange={(checked) =>
                setDraft({ ...draft, includeExisting: checked === true })
              }
            />
            <div>
              <FieldLabel htmlFor={`${prefix}-existing`}>Include missing episodes</FieldLabel>
              <FieldDescription>
                {rule
                  ? "This choice applies when the rule is first created. Previously skipped releases stay skipped."
                  : "Also find releases already available when this rule is enabled. Your AniList progress is respected."}
              </FieldDescription>
            </div>
          </Field>
        </CompactAutomationFields>
        <div className="notification-automation-footer">
          {rule?.enabled ? (
            <Button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await save.mutateAsync({ ...rule, enabled: false });
                  await refresh();
                  close();
                })
              }
              size="sm"
              variant="link"
            >
              Pause automation
            </Button>
          ) : (
            <p>
              One rule for this anime.
              <br />
              Applies across its notifications.
            </p>
          )}
          <Button disabled={busy || !draft.sources.length || !destinations.length} type="submit">
            {busy ? (
              <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
            ) : (
              <SaveIcon data-icon="inline-start" />
            )}
            {saveLabel}
          </Button>
        </div>
      </form>
    </section>
  );
}
