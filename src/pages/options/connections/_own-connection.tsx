import { InfoIcon, ShieldIcon } from "lucide-react";
import { useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";
import type { ServerSession } from "../../../state/workspace";

const roleDescriptions = {
  administration: "Settings, integrations, devices and downloads.",
  management: "Add and manage downloads.",
  owner: "Full access on the host.",
  playback: "Browse the library and play videos.",
} as const;

/** What this device may do on the displayed server, and how to leave it. */
export function OwnConnection({ session }: { session: ServerSession }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { caller, server } = session;
  const signOut = async () => {
    setBusy(true);
    setError(null);
    try {
      const { error: failure } = await api.auth.logout.post();
      if (failure) {
        setError(errorMessage(failure, "Unable to sign out"));
        return;
      }
      window.location.assign("/signed-out");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="connections">
      <div className="connections-intro">
        <h2>Your connection</h2>
        <p>Your access to {server.name}. Server settings are managed by its owner.</p>
      </div>
      <div className="settings-group">
        <div className="connections-row">
          <ShieldIcon aria-hidden="true" className="connections-row-icon" />
          <div className="connections-row-copy">
            <strong>
              {caller.role === "owner"
                ? "Owner"
                : caller.role[0]?.toUpperCase() + caller.role.slice(1)}{" "}
              access
            </strong>
            <p>
              {roleDescriptions[caller.role]}{" "}
              {caller.role === "playback"
                ? ""
                : caller.canDeleteFiles
                  ? "Deleting files is allowed."
                  : "Deleting files is not allowed."}
            </p>
          </div>
          <Badge variant="secondary">Connected</Badge>
        </div>
        <div className="connections-row">
          <div className="connections-row-copy">
            <strong>Playback profile</strong>
            <p>
              {caller.kind === "device" && caller.profileId === caller.id
                ? "This device · Progress is private to this profile."
                : "Shared profile · Progress is shared with other devices in this profile."}
            </p>
          </div>
        </div>
      </div>
      <Alert className="connections-callout">
        <InfoIcon />
        <AlertDescription>
          Appearance and player preferences apply to this device. Downloads and server settings
          apply to {server.name}. Your playback never changes the owner's AniList account.
        </AlertDescription>
      </Alert>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {caller.kind === "device" ? (
        <div className="connections-actions">
          <Button disabled={busy} onClick={() => void signOut()} variant="outline">
            {busy ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
