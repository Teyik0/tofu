import { useState } from "react";
import { holds } from "../../../api/modules/access/grants";
import type { DeviceRole } from "../../../api/modules/access/model";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Checkbox } from "../../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Field, FieldLabel } from "../../../components/ui/field";
import { Input } from "../../../components/ui/input";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";
import type { ServerSession } from "../../../state/workspace";
import { type DeviceSummary, roleNames } from "./_authorized-devices";

/**
 * Edits one device's name and grants, or revokes it; with no device, revokes every device the
 * current session may manage. Results are shown only once the server confirms them.
 */
export function DeviceDialog({
  device,
  session,
  close,
  onChanged,
}: {
  device: DeviceSummary | null;
  session: ServerSession;
  close: () => void;
  onChanged: () => Promise<void>;
}) {
  const [label, setLabel] = useState(device?.label ?? "");
  const [role, setRole] = useState<DeviceRole>(device?.role ?? "playback");
  const [canDeleteFiles, setCanDeleteFiles] = useState(device?.canDeleteFiles ?? false);
  const [revoking, setRevoking] = useState(device === null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (task: () => Promise<{ error: unknown }>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      const { error: failure } = await task();
      if (failure) {
        setError(errorMessage(failure, fallback));
        return;
      }
      await onChanged();
      close();
    } catch {
      setError(`${fallback}. ${session.server.name} could not be reached; nothing changed.`);
    } finally {
      setBusy(false);
    }
  };

  if (revoking) {
    return (
      <Dialog onOpenChange={(open) => !open && close()} open>
        <DialogContent className="connections-dialog">
          <DialogHeader>
            <DialogTitle>
              {device ? `Revoke ${device.label}?` : "Revoke other devices?"}
            </DialogTitle>
            <DialogDescription>
              {device
                ? `${device.label} loses access to ${session.server.name} immediately. Playback in progress stops; files already sent stay on that device.`
                : `Every device you manage loses access to ${session.server.name} immediately. This session stays signed in.`}
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button
              disabled={busy}
              onClick={device ? () => setRevoking(false) : close}
              variant="ghost"
            >
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void run(
                  () =>
                    device
                      ? api.access.devices({ id: device.id }).delete()
                      : api.access.devices["revoke-others"].post(),
                  "Unable to revoke access"
                )
              }
              variant="destructive"
            >
              {busy ? "Revoking…" : "Revoke"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog onOpenChange={(open) => !open && close()} open>
      <DialogContent className="connections-dialog">
        <DialogHeader>
          <DialogTitle>Edit access</DialogTitle>
          <DialogDescription>
            Changes apply to {session.server.name} as soon as they are saved.
          </DialogDescription>
        </DialogHeader>
        <div className="connections-form">
          <Field>
            <FieldLabel htmlFor="device-label">Device name</FieldLabel>
            <Input
              id="device-label"
              maxLength={64}
              onChange={(event) => setLabel(event.target.value)}
              value={label}
            />
          </Field>
          <Field>
            <FieldLabel id="device-role-label">Access</FieldLabel>
            <RadioGroup
              aria-labelledby="device-role-label"
              onValueChange={(value) => {
                setRole(value as DeviceRole);
                if (value === "playback") {
                  setCanDeleteFiles(false);
                }
              }}
              value={role}
            >
              {(Object.keys(roleNames) as DeviceRole[]).map((item) => {
                const allowed = holds(session.caller, { canDeleteFiles: false, role: item });
                return (
                  <label
                    className="connections-radio"
                    data-disabled={!allowed}
                    htmlFor={`device-role-${item}`}
                    key={item}
                  >
                    <RadioGroupItem disabled={!allowed} id={`device-role-${item}`} value={item} />
                    <span>
                      <strong>{roleNames[item]}</strong>
                      {allowed ? null : <small>You can grant only permissions you hold.</small>}
                    </span>
                  </label>
                );
              })}
            </RadioGroup>
          </Field>
          <label className="connections-check" htmlFor="device-delete-files">
            <Checkbox
              checked={canDeleteFiles}
              disabled={role === "playback" || !session.caller.canDeleteFiles}
              id="device-delete-files"
              onCheckedChange={(checked) => setCanDeleteFiles(checked === true)}
            />
            <span>
              <strong>Allow deleting downloaded files</strong>
              <small>
                {role === "playback"
                  ? "Requires Management or Administration access."
                  : "Removing a torrent with its files cannot be undone."}
              </small>
            </span>
          </label>
        </div>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          <Button className="mr-auto" onClick={() => setRevoking(true)} variant="ghost">
            Revoke access
          </Button>
          <Button onClick={close} variant="ghost">
            Cancel
          </Button>
          <Button
            disabled={busy || !label.trim()}
            onClick={() =>
              void run(
                () =>
                  api.access.devices({ id: device?.id ?? "" }).patch({
                    canDeleteFiles: role !== "playback" && canDeleteFiles,
                    label: label.trim(),
                    role,
                  }),
                "Unable to change access"
              )
            }
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
