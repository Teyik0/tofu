import { PlusIcon, ServerIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
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
import { Switch } from "../../../components/ui/switch";
import { Textarea } from "../../../components/ui/textarea";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";
import type { NativeServerAction } from "../../../native/model";

type DesktopServersState = NonNullable<Awaited<ReturnType<typeof api.desktop.servers.get>>["data"]>;

/** Native workspace credentials stay in the host keyring; browsers receive catalog metadata only. */
export function DesktopServers() {
  const [state, setState] = useState<DesktopServersState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<NativeServerAction | null>(null);
  const [address, setAddress] = useState("");
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("Tofu desktop");
  const [temporary, setTemporary] = useState(false);
  const [alias, setAlias] = useState("");
  const [origins, setOrigins] = useState("");
  useEffect(() => {
    const read = async () => {
      const { data, error: failure } = await api.desktop.servers.get();
      if (failure) {
        setError(errorMessage(failure, "Unable to read desktop servers"));
        return;
      }
      setState(data);
    };
    void read();
  }, []);

  const perform = async (input: NativeServerAction) => {
    setBusy(true);
    setError(null);
    try {
      const { data, error: failure } = await api.desktop.servers.post(input);
      if (failure) {
        setError(errorMessage(failure, "Unable to change the desktop server"));
        const catalog = await api.desktop.servers.get();
        if (!catalog.error) {
          setState(catalog.data);
        }
        return;
      }
      setState(data);
      if (input.action === "pair" || input.action === "save-server") {
        setEditing(null);
        setCode("");
        setAddress("");
      }
    } finally {
      setBusy(false);
      setConfirm(null);
    }
  };

  return (
    <section aria-labelledby="desktop-servers-title" className="connections-section">
      <div className="connections-section-title">
        <h3 id="desktop-servers-title">Desktop workspaces</h3>
        <Button
          disabled={busy}
          onClick={() => {
            setAddress("");
            setCode("");
            setEditing("new");
          }}
          size="sm"
          variant="outline"
        >
          <PlusIcon /> Add a server
        </Button>
      </div>
      <p className="connections-muted">
        Choose another server to open in this app. Each workspace keeps its own library and
        settings. Linked libraries below supply media to your personal AniList instead.
      </p>
      <div className="settings-group">
        <div className="connections-row connections-workspace">
          <ServerIcon aria-hidden="true" className="connections-row-icon" />
          <div className="connections-row-copy">
            <strong>This computer</strong>
            <p className="connections-muted">Start the local server when Tofu opens</p>
          </div>
          <Switch
            aria-label="Start the local server when Tofu opens"
            checked={state?.startLocal ?? true}
            disabled={busy || !state}
            onCheckedChange={() => setConfirm({ action: "hosting" })}
          />
        </div>
        {state?.servers.map((server) => (
          <div className="connections-row connections-workspace" key={server.serverId}>
            <ServerIcon aria-hidden="true" className="connections-row-icon" />
            <div className="connections-row-copy">
              <strong>{server.alias || server.name}</strong>
              <p className="connections-muted">{server.origins[0]}</p>
              <Badge variant="outline">{server.status}</Badge>
              {server.temporary ? (
                <span className="connections-muted"> Until Tofu quits</span>
              ) : null}
            </div>
            <div className="connections-actions">
              <Button
                disabled={busy}
                onClick={() => void perform({ action: "open", id: server.serverId })}
                size="sm"
                variant="outline"
              >
                Open
              </Button>
              <Button
                disabled={busy}
                onClick={() => void perform({ action: "reconnect", id: server.serverId })}
                size="sm"
                variant="ghost"
              >
                Reconnect
              </Button>
              <Button
                disabled={busy}
                onClick={() => {
                  setAlias(server.alias);
                  setOrigins(server.origins.join("\n"));
                  setEditing(server.serverId);
                }}
                size="sm"
                variant="ghost"
              >
                Details
              </Button>
              <Button
                disabled={busy}
                onClick={() => setConfirm({ action: "disconnect", id: server.serverId })}
                size="sm"
                variant="ghost"
              >
                Disconnect
              </Button>
              <Button
                disabled={busy}
                onClick={() => setConfirm({ action: "forget", id: server.serverId })}
                size="sm"
                variant="ghost"
              >
                Forget
              </Button>
            </div>
          </div>
        ))}
        {state?.servers.length === 0 ? (
          <p className="connections-row connections-muted">
            No remote desktop workspaces saved on this computer.
          </p>
        ) : null}
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {state?.message ? (
        <p className="connections-muted" role="status">
          {state.message}
        </p>
      ) : null}
      <Dialog
        onOpenChange={(open) => {
          if (!(open || busy)) {
            setEditing(null);
          }
        }}
        open={editing !== null}
      >
        <DialogContent className="connections-dialog">
          <DialogHeader>
            <DialogTitle>
              {editing === "new" ? "Add a desktop workspace" : "Server details"}
            </DialogTitle>
            <DialogDescription>
              Saved on this computer. Remote downloads and accounts stay on their server.
            </DialogDescription>
          </DialogHeader>
          <form
            className="connections-form"
            onSubmit={(event) => {
              event.preventDefault();
              void perform(
                editing === "new"
                  ? { action: "pair", address, code, label, temporary }
                  : { action: "save-server", alias, id: editing ?? undefined, origins }
              );
            }}
          >
            {editing === "new" ? (
              <>
                <Button
                  disabled={busy}
                  onClick={() => void perform({ action: "discover" })}
                  type="button"
                  variant="outline"
                >
                  Find local servers
                </Button>
                {state?.discovered.map((server) => (
                  <Button
                    key={server.address}
                    onClick={() => setAddress(server.address)}
                    type="button"
                    variant="ghost"
                  >
                    {server.name} · {server.address}
                  </Button>
                ))}
                <Field>
                  <FieldLabel htmlFor="desktop-address">
                    Server address or invitation link
                  </FieldLabel>
                  <Input
                    autoComplete="off"
                    id="desktop-address"
                    onChange={(event) => setAddress(event.target.value)}
                    placeholder="https://home.example.ts.net/pair#…"
                    required
                    value={address}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="desktop-code">Invitation code</FieldLabel>
                  <Input
                    autoComplete="off"
                    id="desktop-code"
                    maxLength={32}
                    onChange={(event) => setCode(event.target.value)}
                    value={code}
                  />
                  <FieldDescription>
                    Leave empty when using a complete invitation link.
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="desktop-label">Name for this device</FieldLabel>
                  <Input
                    id="desktop-label"
                    maxLength={64}
                    onChange={(event) => setLabel(event.target.value)}
                    required
                    value={label}
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldLabel htmlFor="desktop-temporary">
                    Keep this connection only until Tofu quits
                  </FieldLabel>
                  <Switch
                    checked={temporary}
                    id="desktop-temporary"
                    onCheckedChange={setTemporary}
                  />
                </Field>
                <p className="connections-muted">
                  A private Tailscale address needs a network route on this computer. A Tofu
                  invitation is also required.
                </p>
              </>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="desktop-alias">Name on this computer</FieldLabel>
                  <Input
                    id="desktop-alias"
                    maxLength={64}
                    onChange={(event) => setAlias(event.target.value)}
                    value={alias}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="desktop-origins">HTTPS addresses, one per line</FieldLabel>
                  <Textarea
                    id="desktop-origins"
                    onChange={(event) => setOrigins(event.target.value)}
                    required
                    value={origins}
                  />
                  <FieldDescription>
                    Each address must verify the saved server identity.
                  </FieldDescription>
                </Field>
              </>
            )}
            {error ? (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            <DialogFooter>
              <Button disabled={busy} type="submit">
                {busy ? "Working…" : editing === "new" ? "Connect to server" : "Save details"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Dialog
        onOpenChange={(open) => {
          if (!(open || busy)) {
            setConfirm(null);
          }
        }}
        open={confirm !== null}
      >
        <DialogContent className="connections-dialog">
          <DialogHeader>
            <DialogTitle>
              {confirm?.action === "hosting"
                ? "Change local server startup?"
                : confirm?.action === "forget"
                  ? "Forget this server?"
                  : "Disconnect this window?"}
            </DialogTitle>
            <DialogDescription>
              {confirm?.action === "hosting"
                ? "Tofu restarts. Turning local hosting off pauses this computer’s downloads. Saved remote servers remain available."
                : confirm?.action === "forget"
                  ? "Remove this server’s saved credentials, cookies and storage from this computer. Downloads on that server continue."
                  : "Close this computer’s remote window. Downloads on the server continue."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button disabled={busy} onClick={() => setConfirm(null)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                if (confirm) {
                  void perform(confirm);
                }
              }}
            >
              {busy ? "Working…" : "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
