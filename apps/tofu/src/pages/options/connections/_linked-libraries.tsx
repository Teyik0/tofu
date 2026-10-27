import { LibraryIcon, PlusIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Alert, AlertDescription } from "../../../../../../package/ui/src/ui/alert";
import { Badge } from "../../../../../../package/ui/src/ui/badge";
import { Button } from "../../../../../../package/ui/src/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../../../package/ui/src/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../../../../../../package/ui/src/ui/field";
import { Input } from "../../../../../../package/ui/src/ui/input";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";

type LinkedServer = NonNullable<
  Awaited<ReturnType<(typeof api)["linked-libraries"]["get"]>>["data"]
>[number];

const stateLabels = {
  active: "Linked",
  "identity-changed": "Identity changed",
  revoked: "Access removed",
} as const;

/** Reads an invitation link (`https://server/pair#i=…`) or keeps a typed code. */
function parseInvitation(value: string) {
  const url = URL.parse(value.trim());
  const secret = url ? new URLSearchParams(url.hash.slice(1)).get("i") : null;
  return url && secret ? { address: url.origin, secret } : null;
}

/**
 * Other Tofu servers this one uses as playback sources for its own AniList. Each link holds an
 * invitation from that server; its owner can revoke it at any time.
 */
export function LinkedLibraries() {
  const [links, setLinks] = useState<LinkedServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [invitation, setInvitation] = useState("");
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const reload = useCallback(async () => {
    const { data, error: failure } = await api["linked-libraries"].get();
    if (failure) {
      setError(errorMessage(failure, "Unable to read linked servers"));
      return;
    }
    setError(null);
    setLinks(data);
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  const parsed = parseInvitation(invitation);

  const link = async () => {
    setBusy(true);
    setFormError(null);
    try {
      const { error: failure } = await api["linked-libraries"].post({
        address: parsed?.address ?? address,
        code: parsed ? undefined : invitation.trim(),
        label: label.trim() || "Linked Tofu",
        secret: parsed?.secret,
      });
      if (failure) {
        setFormError(errorMessage(failure, "Unable to link this server"));
        return;
      }
      setAdding(false);
      setInvitation("");
      setAddress("");
      await reload();
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (item: LinkedServer) => {
    const { data, error: failure } = await api["linked-libraries"]({ id: item.id }).delete();
    if (failure) {
      setError(errorMessage(failure, "Unable to remove this link"));
      return;
    }
    setNotice(
      data.revokedRemotely
        ? `${item.name} is no longer used.`
        : `Removed here. ${item.name} could not be reached; revoke this server's access on ${item.name}.`
    );
    await reload();
  };

  return (
    <section aria-labelledby="linked-title" className="connections-section">
      <div className="connections-section-title">
        <h3 id="linked-title">Libraries from other servers</h3>
        <Button onClick={() => setAdding(true)} variant="outline">
          <PlusIcon data-icon="inline-start" />
          Link a server
        </Button>
      </div>
      <div className="settings-group">
        {links?.length ? (
          links.map((item) => (
            <div className="connections-row" key={item.id}>
              <span aria-hidden="true" className="connections-device-icon">
                <LibraryIcon />
              </span>
              <div className="connections-row-copy">
                <div className="connections-device-title">
                  <strong>{item.name}</strong>
                  <Badge variant={item.state === "active" ? "secondary" : "destructive"}>
                    {stateLabels[item.state]}
                  </Badge>
                </div>
                <code className="connections-address">{item.origin}</code>
                <p>
                  {item.state === "active"
                    ? "Episodes it holds can play from this server's AniList. Your AniList account stays here."
                    : item.state === "revoked"
                      ? `${item.name} removed access for this server. Ask for a new invitation.`
                      : "This address now answers as another server. Nothing is sent to it."}
                </p>
              </div>
              <Button onClick={() => void unlink(item)} variant="ghost">
                Remove
              </Button>
            </div>
          ))
        ) : (
          <div className="connections-row">
            <p className="connections-muted">
              {links === null
                ? "Loading linked servers…"
                : "Link another Tofu server to play the episodes it already has from your AniList library."}
            </p>
          </div>
        )}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice ? (
        <p className="connections-notice" role="status">
          {notice}
        </p>
      ) : null}
      <Dialog onOpenChange={setAdding} open={adding}>
        <DialogContent className="connections-dialog">
          <DialogHeader>
            <DialogTitle>Link a server</DialogTitle>
            <DialogDescription>
              Ask that server's owner for an invitation. Playback access is enough.
            </DialogDescription>
          </DialogHeader>
          <div className="connections-form">
            <Field>
              <FieldLabel htmlFor="linked-invitation">Invitation link or code</FieldLabel>
              <Input
                autoComplete="off"
                id="linked-invitation"
                onChange={(event) => setInvitation(event.target.value)}
                placeholder="https://home-nas.example.ts.net/pair#i=… or ABCDE-FGHJK"
                value={invitation}
              />
            </Field>
            {parsed ? null : (
              <Field>
                <FieldLabel htmlFor="linked-address">Server address</FieldLabel>
                <Input
                  id="linked-address"
                  inputMode="url"
                  onChange={(event) => setAddress(event.target.value)}
                  placeholder="https://home-nas.example.ts.net"
                  value={address}
                />
                <FieldDescription>Needed only with a code.</FieldDescription>
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="linked-label">Name shown on that server</FieldLabel>
              <Input
                id="linked-label"
                maxLength={64}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Linked Tofu"
                value={label}
              />
            </Field>
          </div>
          {formError ? (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setAdding(false)} variant="ghost">
              Cancel
            </Button>
            <Button
              disabled={busy || !(parsed || (invitation.trim() && address.trim()))}
              onClick={() => void link()}
            >
              {busy ? "Linking…" : "Link server"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
