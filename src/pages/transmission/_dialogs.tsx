import { LoaderCircleIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";
import type {
  TransmissionSession,
  TransmissionTorrent,
} from "../../api/modules/transmission/model";
import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { api } from "../../lib/client";
import { errorMessage } from "../../lib/errors";

export function AddTorrentDialog({
  close,
  refresh,
  serverId,
  session,
}: {
  close: () => void;
  refresh: () => Promise<void>;
  serverId: string;
  session: TransmissionSession;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [source, setSource] = useState("");
  const [downloadDir, setDownloadDir] = useState("");
  const [paused, setPaused] = useState(false);
  const submit = async () => {
    if (!source.trim()) {
      setError("Enter a magnet link, a torrent URL or a .torrent file URL.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: failure } = await api.transmission.servers({ id: serverId }).torrents.post({
      downloadDir: downloadDir.trim() || undefined,
      paused,
      source: source.trim(),
    });
    setBusy(false);
    if (failure) {
      setError(errorMessage(failure, "Unable to add this torrent"));
      return;
    }
    await refresh();
    close();
  };
  return (
    <Dialog onOpenChange={(open) => !open && close()} open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add a torrent</DialogTitle>
          <DialogDescription>
            Sent to Transmission with its own metadata. Nothing is added to this Tofu server.
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="transmission-source">Magnet link or torrent URL</FieldLabel>
            <Textarea
              id="transmission-source"
              onChange={(event) => setSource(event.target.value)}
              placeholder="magnet:?xt=urn:btih:… or https://…/file.torrent"
              rows={3}
              value={source}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="transmission-download-dir">Download folder (optional)</FieldLabel>
            <Input
              id="transmission-download-dir"
              onChange={(event) => setDownloadDir(event.target.value)}
              placeholder={session.downloadDir}
              value={downloadDir}
            />
          </Field>
          <Field orientation="horizontal">
            <Checkbox
              checked={paused}
              id="transmission-paused"
              onCheckedChange={(value) => setPaused(value === true)}
            />
            <FieldLabel htmlFor="transmission-paused">Add paused</FieldLabel>
          </Field>
        </FieldGroup>
        <DialogFooter>
          <Button disabled={busy} onClick={close} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()} type="button">
            {busy ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
            {busy ? "Adding…" : "Add torrent"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function numberValue(value: string, integer: boolean) {
  const parsed = integer ? Number.parseInt(value, 10) : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function LimitsDialog({
  close,
  refresh,
  serverId,
  session,
}: {
  close: () => void;
  refresh: () => Promise<void>;
  serverId: string;
  session: TransmissionSession;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloadLimited, setDownloadLimited] = useState(session.downloadLimited);
  const [downloadLimit, setDownloadLimit] = useState(String(session.downloadLimit));
  const [uploadLimited, setUploadLimited] = useState(session.uploadLimited);
  const [uploadLimit, setUploadLimit] = useState(String(session.uploadLimit));
  const [altSpeedEnabled, setAltSpeedEnabled] = useState(session.altSpeedEnabled);
  const [peerLimitGlobal, setPeerLimitGlobal] = useState(String(session.peerLimitGlobal));
  const [peerLimitPerTorrent, setPeerLimitPerTorrent] = useState(
    String(session.peerLimitPerTorrent)
  );
  const [seedRatioLimited, setSeedRatioLimited] = useState(session.seedRatioLimited);
  const [seedRatioLimit, setSeedRatioLimit] = useState(String(session.seedRatioLimit));
  const [idleSeedingLimitEnabled, setIdleSeedingLimitEnabled] = useState(
    session.idleSeedingLimitEnabled
  );
  const [idleSeedingLimit, setIdleSeedingLimit] = useState(String(session.idleSeedingLimit));

  const submit = async () => {
    const down = numberValue(downloadLimit, true);
    const up = numberValue(uploadLimit, true);
    const peers = numberValue(peerLimitGlobal, true);
    const perTorrent = numberValue(peerLimitPerTorrent, true);
    const ratio = numberValue(seedRatioLimit, false);
    const idle = numberValue(idleSeedingLimit, true);
    if (
      (downloadLimited && down === undefined) ||
      (uploadLimited && up === undefined) ||
      peers === undefined ||
      perTorrent === undefined ||
      (seedRatioLimited && ratio === undefined) ||
      (idleSeedingLimitEnabled && idle === undefined)
    ) {
      setError("Enter whole numbers; speed limits use kilobytes per second and idle minutes.");
      return;
    }
    setBusy(true);
    setError(null);
    const { error: failure } = await api.transmission.servers({ id: serverId }).limits.put({
      altSpeedEnabled,
      downloadLimit: down,
      downloadLimited,
      idleSeedingLimit: idle,
      idleSeedingLimitEnabled,
      peerLimitGlobal: peers,
      peerLimitPerTorrent: perTorrent,
      seedRatioLimit: ratio,
      seedRatioLimited,
      uploadLimit: up,
      uploadLimited,
    });
    setBusy(false);
    if (failure) {
      setError(errorMessage(failure, "Unable to update the transfer limits"));
      return;
    }
    await refresh();
    close();
  };

  return (
    <Dialog onOpenChange={(open) => !open && close()} open>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Transfer limits</DialogTitle>
          <DialogDescription>
            Applied to the whole Transmission session. Speeds use kilobytes per second.
          </DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <FieldSet>
          <FieldLegend variant="label">Speed</FieldLegend>
          <FieldGroup>
            <Field orientation="horizontal">
              <Checkbox
                checked={downloadLimited}
                id="transmission-download-limited"
                onCheckedChange={(value) => setDownloadLimited(value === true)}
              />
              <FieldLabel htmlFor="transmission-download-limited">
                Limit the download speed
              </FieldLabel>
              <Input
                aria-label="Download limit in kilobytes per second"
                className="w-28"
                disabled={!downloadLimited}
                min={0}
                onChange={(event) => setDownloadLimit(event.target.value)}
                type="number"
                value={downloadLimit}
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                checked={uploadLimited}
                id="transmission-upload-limited"
                onCheckedChange={(value) => setUploadLimited(value === true)}
              />
              <FieldLabel htmlFor="transmission-upload-limited">Limit the upload speed</FieldLabel>
              <Input
                aria-label="Upload limit in kilobytes per second"
                className="w-28"
                disabled={!uploadLimited}
                min={0}
                onChange={(event) => setUploadLimit(event.target.value)}
                type="number"
                value={uploadLimit}
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                checked={altSpeedEnabled}
                id="transmission-alt-speed"
                onCheckedChange={(value) => setAltSpeedEnabled(value === true)}
              />
              <FieldLabel htmlFor="transmission-alt-speed">
                Use the alternative speed limits
              </FieldLabel>
            </Field>
          </FieldGroup>
        </FieldSet>
        <FieldSet>
          <FieldLegend variant="label">Peers</FieldLegend>
          <FieldGroup>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="transmission-peers-global">Maximum peers overall</FieldLabel>
              <Input
                className="w-28"
                id="transmission-peers-global"
                min={1}
                onChange={(event) => setPeerLimitGlobal(event.target.value)}
                type="number"
                value={peerLimitGlobal}
              />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="transmission-peers-torrent">
                Maximum peers per torrent
              </FieldLabel>
              <Input
                className="w-28"
                id="transmission-peers-torrent"
                min={1}
                onChange={(event) => setPeerLimitPerTorrent(event.target.value)}
                type="number"
                value={peerLimitPerTorrent}
              />
            </Field>
          </FieldGroup>
        </FieldSet>
        <FieldSet>
          <FieldLegend variant="label">Seeding</FieldLegend>
          <FieldGroup>
            <Field orientation="horizontal">
              <Checkbox
                checked={seedRatioLimited}
                id="transmission-seed-ratio-limited"
                onCheckedChange={(value) => setSeedRatioLimited(value === true)}
              />
              <FieldLabel htmlFor="transmission-seed-ratio-limited">
                Stop at a share ratio of
              </FieldLabel>
              <Input
                aria-label="Share ratio"
                className="w-24"
                disabled={!seedRatioLimited}
                min={0}
                onChange={(event) => setSeedRatioLimit(event.target.value)}
                step="0.01"
                type="number"
                value={seedRatioLimit}
              />
            </Field>
            <Field orientation="horizontal">
              <Checkbox
                checked={idleSeedingLimitEnabled}
                id="transmission-idle-limited"
                onCheckedChange={(value) => setIdleSeedingLimitEnabled(value === true)}
              />
              <FieldLabel htmlFor="transmission-idle-limited">
                Stop seeding after this idle time
              </FieldLabel>
              <Input
                aria-label="Idle minutes before stopping"
                className="w-24"
                disabled={!idleSeedingLimitEnabled}
                min={0}
                onChange={(event) => setIdleSeedingLimit(event.target.value)}
                type="number"
                value={idleSeedingLimit}
              />
              <span className="text-muted-foreground text-xs">minutes</span>
            </Field>
          </FieldGroup>
        </FieldSet>
        <DialogFooter>
          <Button disabled={busy} onClick={close} type="button" variant="ghost">
            Cancel
          </Button>
          <Button disabled={busy} onClick={() => void submit()} type="button">
            {busy ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
            {busy ? "Applying…" : "Apply limits"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RemoveTorrentDialog({
  close,
  refresh,
  serverId,
  torrent,
}: {
  close: () => void;
  refresh: () => Promise<void>;
  serverId: string;
  torrent: TransmissionTorrent;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteLocalData, setDeleteLocalData] = useState(false);
  const remove = async () => {
    setBusy(true);
    setError(null);
    const { error: failure } = await api.transmission.servers({ id: serverId }).torrents.delete({
      deleteLocalData,
      ids: [torrent.id],
    });
    setBusy(false);
    if (failure) {
      setError(errorMessage(failure, "Unable to remove this torrent"));
      return;
    }
    await refresh();
    close();
  };
  return (
    <AlertDialog onOpenChange={(open) => !open && close()} open>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {torrent.name || "this torrent"}?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the torrent from Transmission. Downloaded files handled by Transmission are
            kept unless you delete them here.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {error === null ? null : (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Field orientation="horizontal">
          <Checkbox
            checked={deleteLocalData}
            id="transmission-delete-data"
            onCheckedChange={(value) => setDeleteLocalData(value === true)}
          />
          <FieldLabel htmlFor="transmission-delete-data">
            Also delete the downloaded files on the Transmission host
          </FieldLabel>
        </Field>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button disabled={busy} onClick={() => void remove()} type="button" variant="destructive">
            {busy ? (
              <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
            ) : (
              <Trash2Icon data-icon="inline-start" />
            )}
            {busy ? "Removing…" : "Remove torrent"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
