import { usePluginHost } from "@tofu/plugins/client";
import type { AniListState, AutomationState, DashboardState } from "@tofu/plugins/domain";
import { Alert, AlertDescription } from "@tofu/ui/alert";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@tofu/ui/dialog";
import { Field, FieldLabel } from "@tofu/ui/field";
import { OptionSelect } from "@tofu/ui/option-select";
import { useAsyncAction } from "@tofu/ui/use-async-action";
import { useState } from "react";
import { AniListPanel } from "./panel";
export function LibrarySettings({
  state,
  automationState,
  dashboard,
  close,
}: {
  state: AniListState;
  automationState: AutomationState;
  dashboard: DashboardState;
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
                options={dashboard.destinations.map((destination) => ({
                  label: destination.name,
                  value: destination.id,
                }))}
                value={target}
              />
            </Field>
          }
          destinations={dashboard.destinations}
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
