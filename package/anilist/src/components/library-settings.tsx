import { usePluginHost } from "@tofu/plugins/client";
import type { LiveState } from "@tofu/plugins/library-state";
import { useState } from "react";
import type { AutomationState } from "../../../plugins/src/automation-model";
import { OptionSelect } from "../../../ui/src/option-select";
import { Alert, AlertDescription } from "../../../ui/src/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../ui/src/ui/dialog";
import { Field, FieldLabel } from "../../../ui/src/ui/field";
import { useAsyncAction } from "../../../ui/src/use-async-action";
import type { AniListState } from "../server/types";
import { AniListPanel } from "./panel";

export function LibrarySettings({
  state,
  automationState,
  dashboard,
  close,
}: {
  state: AniListState;
  automationState: AutomationState;
  dashboard: LiveState;
  close: () => void;
}) {
  const { refresh } = usePluginHost();
  const { busy, error, action } = useAsyncAction("Unable to update AniList");
  const [target, setTarget] = useState("default");
  const plugin = automationState.plugins.find((item) => item.id === "anilist");
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
      open
    >
      <DialogContent className="anilist-settings-dialog">
        <DialogHeader>
          <DialogTitle>AniList settings</DialogTitle>
          <DialogDescription>
            Connect your account and set default tracking preferences. Each anime can override them.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <Alert>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <AniListPanel
          action={action}
          automations={automationState.automations}
          busy={busy}
          destinationField={
            <Field>
              <FieldLabel htmlFor="anime-default-destination">Default destination</FieldLabel>
              <OptionSelect
                disabled={busy}
                id="anime-default-destination"
                onValueChange={setTarget}
                options={(dashboard.host?.destinations ?? []).map((destination) => ({
                  label: destination.name,
                  value: destination.id,
                }))}
                value={target}
              />
            </Field>
          }
          destinations={dashboard.host?.destinations ?? []}
          key={target}
          plugin={plugin}
          preferences={automationState.preferences}
          reload={refresh}
          state={state}
          target={target}
        />
      </DialogContent>
    </Dialog>
  );
}
