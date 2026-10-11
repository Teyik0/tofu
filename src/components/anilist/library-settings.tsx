import { useState } from "react";
import { useAsyncAction } from "../../hooks/use-async-action";
import { useRefresh } from "../../lib/navigation";
import type { AniListState, AutomationState, DashboardState } from "../../types";
import { OptionSelect } from "../option-select";
import { Alert, AlertDescription } from "../ui/alert";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../ui/dialog";
import { Field, FieldLabel } from "../ui/field";
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
  const refresh = useRefresh();
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
