import { CopyIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { encode } from "uqr";
import { holds } from "../../../api/modules/access/grants";
import type { DeviceRole } from "../../../api/modules/access/model";
import { OptionSelect } from "../../../components/option-select";
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
import { Field, FieldDescription, FieldLabel } from "../../../components/ui/field";
import { Input } from "../../../components/ui/input";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";
import type { ServerSession } from "../../../state/workspace";
import { serverAddresses } from "./_server-addresses";
import type { ConnectionsState } from "./index";

type Invitation = NonNullable<Awaited<ReturnType<typeof api.access.invitations.post>>["data"]>;

const roles: { description: string; label: string; value: DeviceRole }[] = [
  {
    description: "Browse the library, play videos and keep its own progress.",
    label: "Playback",
    value: "playback",
  },
  {
    description: "Playback, plus add, pause, resume and remove downloads in existing threads.",
    label: "Management",
    value: "management",
  },
  {
    description: "Management, plus settings, integrations and devices. Never host folders or apps.",
    label: "Administration",
    value: "administration",
  },
];

const expiries = [
  { label: "10 minutes", value: "10" },
  { label: "1 hour", value: "60" },
  { label: "24 hours", value: "1440" },
];

/** A real, scannable QR code drawn from the encoded module matrix. */
function QrCode({ value, label }: { value: string; label: string }) {
  const matrix = useMemo(() => encode(value, { border: 2 }).data, [value]);
  const size = matrix.length;
  return (
    <svg
      aria-label={label}
      className="connections-qr"
      role="img"
      shapeRendering="crispEdges"
      viewBox={`0 0 ${size} ${size}`}
    >
      <rect fill="#fff" height={size} width={size} />
      <path
        d={matrix
          .flatMap((row, y) => row.map((dark, x) => (dark ? `M${x} ${y}h1v1h-1z` : "")))
          .join("")}
        fill="#1d211b"
      />
    </svg>
  );
}

function Remaining({ until }: { until: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.max(0, Math.ceil((until - now) / 60_000));
  return (
    <>
      Expires at {new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (
      {minutes > 0 ? `in ${minutes} min` : "expired"})
    </>
  );
}

export function PairDeviceDialog({
  session,
  state,
  close,
  onCreated,
}: {
  session: ServerSession;
  state: ConnectionsState | null;
  close: () => void;
  onCreated: () => Promise<void>;
}) {
  const [label, setLabel] = useState("New device");
  const [role, setRole] = useState<DeviceRole>("playback");
  const [canDeleteFiles, setCanDeleteFiles] = useState(false);
  const [expiry, setExpiry] = useState("10");
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const addresses = state ? serverAddresses(state) : [];
  const [address, setAddress] = useState(addresses[0]?.url ?? "");
  const link = invitation && address ? `${address}/pair#i=${invitation.secret}` : null;

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data, error: failure } = await api.access.invitations.post({
        canDeleteFiles: role !== "playback" && canDeleteFiles,
        expiresInMinutes: Number(expiry),
        label: label.trim(),
        role,
      });
      if (failure) {
        setError(errorMessage(failure, "Unable to create the invitation"));
        return;
      }
      setInvitation(data);
      await onCreated();
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(what);
    } catch {
      setError(`Clipboard unavailable. Select and copy the ${what} below.`);
    }
  };

  const revoke = async () => {
    if (!invitation) {
      return;
    }
    const { error: failure } = await api.access
      .invitations({ id: invitation.invitation.id })
      .delete();
    if (failure) {
      setError(errorMessage(failure, "Unable to revoke the invitation"));
      return;
    }
    close();
  };

  return (
    <Dialog onOpenChange={(open) => !open && close()} open>
      <DialogContent className="connections-dialog">
        <DialogHeader>
          <DialogTitle>{invitation ? "Invitation ready" : "Pair a device"}</DialogTitle>
          <DialogDescription>
            {invitation
              ? `Open this link or scan the code on the device you want to connect to ${session.server.name}. It works once, at the address it was opened with.`
              : `Create a one-time invitation for ${session.server.name}.`}
          </DialogDescription>
        </DialogHeader>
        {invitation ? (
          <div className="connections-invitation">
            {addresses.length === 0 ? (
              <Alert>
                <AlertDescription>
                  Turn on remote access first so other devices can reach this server. You can still
                  use the code on a device that already knows its address.
                </AlertDescription>
              </Alert>
            ) : addresses.length > 1 ? (
              <OptionSelect
                ariaLabel="Address for this invitation"
                className="w-full"
                disabled={false}
                onValueChange={setAddress}
                options={addresses.map((item) => ({
                  label: `${item.label} · ${item.url}`,
                  value: item.url,
                }))}
                value={address}
              />
            ) : null}
            {link ? (
              <QrCode
                label={`QR code for an invitation to ${new URL(address).host}`}
                value={link}
              />
            ) : null}
            <div className="connections-code">
              <span>Code</span>
              <strong>{invitation.code}</strong>
              <Button
                aria-label="Copy invitation code"
                onClick={() => void copy(invitation.code, "code")}
                size="icon"
                variant="ghost"
              >
                <CopyIcon />
              </Button>
            </div>
            <p className="connections-muted">
              <Remaining until={invitation.invitation.expiresAt} />. Anyone with this invitation can
              connect with {roles.find((item) => item.value === invitation.invitation.role)?.label}{" "}
              access until it is used. It cannot be shown again after you close this window.
            </p>
            {copied ? (
              <p className="connections-notice" role="status">
                The {copied} is copied.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="connections-form">
            <Field>
              <FieldLabel htmlFor="invitation-label">Device name</FieldLabel>
              <Input
                id="invitation-label"
                maxLength={64}
                onChange={(event) => setLabel(event.target.value)}
                value={label}
              />
            </Field>
            <Field>
              <FieldLabel id="invitation-role-label">Access</FieldLabel>
              <RadioGroup
                aria-labelledby="invitation-role-label"
                onValueChange={(value) => {
                  setRole(value as DeviceRole);
                  if (value === "playback") {
                    setCanDeleteFiles(false);
                  }
                }}
                value={role}
              >
                {roles.map((item) => {
                  const allowed = holds(session.caller, {
                    canDeleteFiles: false,
                    role: item.value,
                  });
                  return (
                    <label
                      className="connections-radio"
                      data-disabled={!allowed}
                      htmlFor={`pair-role-${item.value}`}
                      key={item.value}
                    >
                      <RadioGroupItem
                        disabled={!allowed}
                        id={`pair-role-${item.value}`}
                        value={item.value}
                      />
                      <span>
                        <strong>{item.label}</strong>
                        <small>
                          {allowed ? item.description : "You can grant only permissions you hold."}
                        </small>
                      </span>
                    </label>
                  );
                })}
              </RadioGroup>
            </Field>
            <label className="connections-check" htmlFor="pair-delete-files">
              <Checkbox
                checked={canDeleteFiles}
                disabled={role === "playback" || !session.caller.canDeleteFiles}
                id="pair-delete-files"
                onCheckedChange={(checked) => setCanDeleteFiles(checked === true)}
              />
              <span>
                <strong>Allow deleting downloaded files</strong>
                <small>
                  {role === "playback"
                    ? "Requires Management or Administration access."
                    : session.caller.canDeleteFiles
                      ? "Removing a torrent with its files cannot be undone."
                      : "You can grant only permissions you hold."}
                </small>
              </span>
            </label>
            <Field>
              <FieldLabel htmlFor="invitation-expiry">Invitation expires after</FieldLabel>
              <OptionSelect
                ariaLabel="Invitation expires after"
                className="w-full"
                disabled={false}
                id="invitation-expiry"
                onValueChange={setExpiry}
                options={expiries}
                value={expiry}
              />
              <FieldDescription>Unused invitations stop working after this time.</FieldDescription>
            </Field>
          </div>
        )}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        <DialogFooter>
          {invitation ? (
            <>
              <Button onClick={() => void revoke()} variant="ghost">
                Revoke invitation
              </Button>
              {link ? (
                <Button onClick={() => void copy(link, "link")} variant="outline">
                  Copy link
                </Button>
              ) : null}
              <Button onClick={close}>Done</Button>
            </>
          ) : (
            <>
              <Button onClick={close} variant="ghost">
                Cancel
              </Button>
              <Button disabled={busy || !label.trim()} onClick={() => void create()}>
                {busy ? "Creating…" : "Create invitation"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
