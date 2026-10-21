import {
  GlobeIcon,
  LaptopIcon,
  MoreHorizontalIcon,
  PlusIcon,
  ServerIcon,
  ShieldIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { holds } from "../../../api/modules/access/grants";
import type { DeviceRole } from "../../../api/modules/access/model";
import { ActionTooltip } from "../../../components/action-tooltip";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";
import type { ServerSession } from "../../../state/workspace";
import { DeviceDialog } from "./_device-dialog";
import { PairDeviceDialog } from "./_pair-device-dialog";
import type { ConnectionsState } from "./index";

export type DeviceSummary = NonNullable<
  Awaited<ReturnType<typeof api.access.devices.get>>["data"]
>[number];

export const roleNames: { [Role in DeviceRole]: string } = {
  administration: "Administration",
  management: "Management",
  playback: "Playback",
};

export function grantSummary(grants: { canDeleteFiles: boolean; role: DeviceRole }) {
  return `${roleNames[grants.role]}${grants.role === "playback" ? "" : grants.canDeleteFiles ? " · Can delete files" : " · Cannot delete files"}`;
}

function lastActive(time: number) {
  const minutes = Math.round((Date.now() - time) / 60_000);
  if (minutes < 2) {
    return "Active now";
  }
  if (minutes < 60) {
    return `Last active ${minutes} minutes ago`;
  }
  const hours = Math.round(minutes / 60);
  return hours < 48
    ? `Last active ${hours} hours ago`
    : `Last active ${new Date(time).toLocaleDateString()}`;
}

const kindIcons = { browser: GlobeIcon, desktop: LaptopIcon, server: ServerIcon };

export function AuthorizedDevices({
  session,
  state,
}: {
  session: ServerSession;
  state: ConnectionsState | null;
}) {
  const [devices, setDevices] = useState<DeviceSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [selected, setSelected] = useState<DeviceSummary | null>(null);
  const [confirmingOthers, setConfirmingOthers] = useState(false);
  const reload = useCallback(async () => {
    const { data, error: failure } = await api.access.devices.get();
    if (failure) {
      setError(errorMessage(failure, "Unable to read authorized devices"));
      return;
    }
    setError(null);
    setDevices(data);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const others = (devices ?? []).filter((device) => device.id !== session.caller.id);
  return (
    <section aria-labelledby="devices-title" className="connections-section">
      <div className="connections-section-title">
        <h3 id="devices-title">Authorized devices</h3>
        <Button onClick={() => setPairing(true)} variant="outline">
          <PlusIcon data-icon="inline-start" />
          Pair a device
        </Button>
      </div>
      <div aria-busy={devices === null} className="settings-group">
        <div className="connections-row">
          <span aria-hidden="true" className="connections-device-icon">
            <ShieldIcon />
          </span>
          <div className="connections-row-copy">
            <div className="connections-device-title">
              <strong>
                {session.capabilities.hostNative
                  ? "This computer"
                  : `${session.server.name}'s owner`}
              </strong>
              <Badge variant="outline">Owner</Badge>
            </div>
            <p>
              {session.capabilities.hostNative
                ? "Full access on the host · Cannot be revoked remotely"
                : "The host's own window or recovery command · Cannot be revoked remotely"}
            </p>
          </div>
        </div>
        {devices === null && !error ? (
          <div className="connections-row">
            <p className="connections-muted">Loading devices…</p>
          </div>
        ) : null}
        {devices?.map((device) => {
          const Icon = kindIcons[device.kind];
          const manageable = holds(session.caller, device) && device.id !== session.caller.id;
          return (
            <div className="connections-row" key={device.id}>
              <span aria-hidden="true" className="connections-device-icon">
                <Icon />
              </span>
              <div className="connections-row-copy">
                <div className="connections-device-title">
                  <strong>{device.label}</strong>
                  {device.id === session.caller.id ? (
                    <Badge variant="secondary">This session</Badge>
                  ) : null}
                  {device.kind === "server" ? <Badge variant="outline">Linked server</Badge> : null}
                </div>
                <p>
                  {grantSummary(device)} · {lastActive(device.lastSeenAt)}
                </p>
              </div>
              {manageable ? (
                <ActionTooltip>
                  <Button
                    aria-label={`Manage ${device.label}`}
                    onClick={() => setSelected(device)}
                    size="icon"
                    variant="ghost"
                  >
                    <MoreHorizontalIcon />
                  </Button>
                </ActionTooltip>
              ) : null}
            </div>
          );
        })}
        <div className="connections-footer">
          <span>
            {devices === null
              ? ""
              : `${devices.length + 1} authorized device${devices.length === 0 ? "" : "s"}`}
          </span>
          {others.length > 0 ? (
            <Button
              className="connections-footer-action"
              onClick={() => setConfirmingOthers(true)}
              variant="ghost"
            >
              Revoke other devices
            </Button>
          ) : null}
        </div>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {pairing ? (
        <PairDeviceDialog
          close={() => setPairing(false)}
          onCreated={reload}
          session={session}
          state={state}
        />
      ) : null}
      {selected ? (
        <DeviceDialog
          close={() => setSelected(null)}
          device={selected}
          onChanged={reload}
          session={session}
        />
      ) : null}
      {confirmingOthers ? (
        <DeviceDialog
          close={() => setConfirmingOthers(false)}
          device={null}
          onChanged={reload}
          session={session}
        />
      ) : null}
    </section>
  );
}
