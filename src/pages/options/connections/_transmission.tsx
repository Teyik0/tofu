import { LoaderCircleIcon, PencilIcon, PlusIcon, ServerIcon, Trash2Icon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { TransmissionServer } from "../../../api/modules/transmission/model";
import { Alert, AlertDescription } from "../../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../../components/ui/field";
import { Input } from "../../../components/ui/input";
import { Switch } from "../../../components/ui/switch";
import { api } from "../../../lib/client";
import { errorMessage } from "../../../lib/errors";

/** Transmission RPC daemons controlled from this server, configured by its administrators. */
export function TransmissionServers() {
  const [servers, setServers] = useState<TransmissionServer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<TransmissionServer | "new" | null>(null);
  const [confirm, setConfirm] = useState<TransmissionServer | null>(null);

  const read = useCallback(async () => {
    const { data, error: failure } = await api.transmission.servers.get();
    if (failure) {
      setError(errorMessage(failure, "Unable to read Transmission servers"));
      return;
    }
    setError(null);
    setServers(data);
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  const test = async (server: TransmissionServer) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    const { data, error: failure } = await api.transmission.servers({ id: server.id }).state.get();
    setBusy(false);
    if (failure) {
      setError(`${server.name}: ${errorMessage(failure, "Transmission could not be reached")}`);
      return;
    }
    setNotice(
      `${server.name}: Transmission ${data.session.version}, ${data.session.torrentCount} torrent(s)`
    );
  };

  const remove = async (server: TransmissionServer) => {
    setBusy(true);
    const { error: failure } = await api.transmission.servers({ id: server.id }).delete();
    setBusy(false);
    setConfirm(null);
    if (failure) {
      setError(errorMessage(failure, "Unable to delete this Transmission server"));
      return;
    }
    await read();
  };

  return (
    <section aria-labelledby="transmission-servers-title" className="connections-section">
      <div className="connections-section-title">
        <h3 id="transmission-servers-title">Transmission</h3>
        <Button
          disabled={busy}
          onClick={() => {
            setError(null);
            setNotice(null);
            setEditing("new");
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon data-icon="inline-start" />
          Add server
        </Button>
      </div>
      <p className="connections-row-copy">
        Manage torrents running on a transmission-daemon through its RPC interface. Files stay on
        the daemon host; this server only reads and controls them.
      </p>
      {error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice === null ? null : (
        <Alert>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      )}
      {servers === null ? (
        <p className="connections-row-copy">Loading Transmission servers…</p>
      ) : servers.length === 0 ? (
        <p className="connections-row-copy">No Transmission server configured.</p>
      ) : (
        <div className="settings-group">
          {servers.map((server) => (
            <div className="connections-row" key={server.id}>
              <ServerIcon aria-hidden="true" className="connections-row-icon" />
              <div className="connections-row-copy">
                <strong>{server.name}</strong>
                <code className="connections-address">
                  {server.origin}
                  {server.rpcPath}
                </code>
                <p>
                  {server.enabled ? "Enabled" : "Disabled"}
                  {server.username ? ` · ${server.username}` : ""}
                  {server.hasPassword ? " · password stored" : ""}
                </p>
              </div>
              <Button
                disabled={busy}
                onClick={() => void test(server)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Test
              </Button>
              <Button
                aria-label={`Edit ${server.name}`}
                disabled={busy}
                onClick={() => setEditing(server)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <PencilIcon className="size-3.5" />
              </Button>
              <Button
                aria-label={`Delete ${server.name}`}
                disabled={busy}
                onClick={() => setConfirm(server)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Trash2Icon className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      )}
      {editing === null ? null : (
        <ServerDialog
          close={() => setEditing(null)}
          refresh={read}
          server={editing === "new" ? null : editing}
        />
      )}
      {confirm === null ? null : (
        <AlertDialog onOpenChange={(open) => !open && setConfirm(null)} open>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove {confirm.name}?</AlertDialogTitle>
              <AlertDialogDescription>
                Tofu forgets this RPC address and its stored credentials. Torrents and files on the
                daemon are untouched.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
              <Button
                disabled={busy}
                onClick={() => void remove(confirm)}
                type="button"
                variant="destructive"
              >
                Remove server
              </Button>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </section>
  );
}

function ServerDialog({
  close,
  refresh,
  server,
}: {
  close: () => void;
  refresh: () => Promise<void>;
  server: TransmissionServer | null;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(server?.name ?? "Transmission");
  const [origin, setOrigin] = useState(server?.origin ?? "");
  const [rpcPath, setRpcPath] = useState(server?.rpcPath ?? "/transmission/rpc");
  const [username, setUsername] = useState(server?.username ?? "");
  const [password, setPassword] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [enabled, setEnabled] = useState(server?.enabled ?? true);

  const submit = async () => {
    if (!(name.trim() && origin.trim() && rpcPath.trim())) {
      setError("Enter a name, an origin and the RPC path.");
      return;
    }
    setBusy(true);
    setError(null);
    const body = {
      enabled,
      name: name.trim(),
      origin: origin.trim(),
      password: clearPassword ? null : password || undefined,
      rpcPath: rpcPath.trim(),
      username: username.trim() || null,
    };
    const { error: failure } =
      server === null
        ? await api.transmission.servers.post(body)
        : await api.transmission.servers({ id: server.id }).put(body);
    setBusy(false);
    if (failure) {
      setError(errorMessage(failure, "Unable to save this Transmission server"));
      return;
    }
    await refresh();
    close();
  };

  return (
    <Dialog onOpenChange={(open) => !open && close()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {server === null ? "Add a Transmission server" : `Edit ${server.name}`}
          </DialogTitle>
          <DialogDescription>
            Point this at the daemon's RPC endpoint. Credentials are stored in this server's data
            directory.
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="transmission-name">Name</FieldLabel>
            <Input
              id="transmission-name"
              onChange={(event) => setName(event.target.value)}
              value={name}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="transmission-origin">Origin</FieldLabel>
            <Input
              id="transmission-origin"
              onChange={(event) => setOrigin(event.target.value)}
              placeholder="http://192.0.2.10:9091"
              value={origin}
            />
            <FieldDescription>Scheme, host and port, without the RPC path.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="transmission-rpc-path">RPC path</FieldLabel>
            <Input
              id="transmission-rpc-path"
              onChange={(event) => setRpcPath(event.target.value)}
              placeholder="/transmission/rpc"
              value={rpcPath}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="transmission-username">Username (optional)</FieldLabel>
            <Input
              autoComplete="username"
              id="transmission-username"
              onChange={(event) => setUsername(event.target.value)}
              value={username}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="transmission-password">Password (optional)</FieldLabel>
            <Input
              autoComplete="current-password"
              disabled={clearPassword}
              id="transmission-password"
              onChange={(event) => setPassword(event.target.value)}
              placeholder={server?.hasPassword ? "Leave blank to keep the stored password" : ""}
              type="password"
              value={password}
            />
          </Field>
          {server?.hasPassword ? (
            <Field orientation="horizontal">
              <Switch
                checked={clearPassword}
                onCheckedChange={(value) => {
                  setClearPassword(value);
                  if (value) {
                    setPassword("");
                  }
                }}
              />
              <FieldLabel>Clear the stored password</FieldLabel>
            </Field>
          ) : null}
          <Field orientation="horizontal">
            <Switch checked={enabled} onCheckedChange={setEnabled} />
            <FieldLabel>Enabled</FieldLabel>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button disabled={busy} onClick={close} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()} type="button">
            {busy ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
            {busy ? "Saving…" : "Save server"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
