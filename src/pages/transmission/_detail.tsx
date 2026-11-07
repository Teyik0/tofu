import {
  CheckIcon,
  CopyIcon,
  LoaderCircleIcon,
  RadioTowerIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { stateLabels } from "../../api/modules/transmission/mapping";
import type {
  TransmissionTorrent,
  TransmissionTorrentDetail,
} from "../../api/modules/transmission/model";
import { bytes, date, duration, percent, speed } from "../../components/format";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { api } from "../../lib/client";
import { errorMessage } from "../../lib/errors";

export function TorrentDetailDialog({
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
  const [detail, setDetail] = useState<TransmissionTorrentDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const { data, error: failure } = await api.transmission
      .servers({ id: serverId })
      .torrents({ torrentId: String(torrent.id) })
      .get();
    if (failure) {
      setError(errorMessage(failure, "Unable to read this torrent"));
      return;
    }
    setError(null);
    setDetail(data);
  }, [serverId, torrent.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (action: "reannounce" | "verify") => {
    setBusy(true);
    setNotice(null);
    const { error: failure } = await api.transmission.servers({ id: serverId }).action.post({
      action,
      ids: [torrent.id],
    });
    setBusy(false);
    if (failure) {
      setError(errorMessage(failure, "Unable to control this torrent"));
      return;
    }
    setNotice(action === "reannounce" ? "Tracker announce requested." : "Verification requested.");
    await load();
    await refresh();
  };

  return (
    <Dialog onOpenChange={(open) => !open && close()} open>
      <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="break-all pr-8">{detail?.name ?? torrent.name}</DialogTitle>
          <DialogDescription>
            {detail
              ? `${stateLabels[detail.state]} · ${percent(detail.progress)} · ${bytes(detail.sizeWhenDone)}`
              : "Reading the torrent from Transmission…"}
          </DialogDescription>
        </DialogHeader>
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
        {detail === null ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              <Button
                disabled={busy}
                onClick={() => void act("reannounce")}
                size="sm"
                type="button"
                variant="outline"
              >
                {busy ? (
                  <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
                ) : (
                  <RadioTowerIcon data-icon="inline-start" />
                )}
                Ask for more peers
              </Button>
              <Button
                disabled={busy}
                onClick={() => void act("verify")}
                size="sm"
                type="button"
                variant="outline"
              >
                <ShieldCheckIcon data-icon="inline-start" />
                Verify data
              </Button>
            </div>
            <Tabs defaultValue="overview">
              <TabsList>
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="files">Files ({detail.files.length})</TabsTrigger>
                <TabsTrigger value="trackers">Trackers ({detail.trackers.length})</TabsTrigger>
                <TabsTrigger value="peers">Peers ({detail.peers.length})</TabsTrigger>
              </TabsList>
              <TabsContent value="overview">
                <OverviewTab detail={detail} />
              </TabsContent>
              <TabsContent value="files">
                <FilesTab
                  detail={detail}
                  onApplied={async () => {
                    await load();
                    await refresh();
                  }}
                  serverId={serverId}
                />
              </TabsContent>
              <TabsContent value="trackers">
                <TrackersTab detail={detail} />
              </TabsContent>
              <TabsContent value="peers">
                <PeersTab detail={detail} />
              </TabsContent>
            </Tabs>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function timestamp(seconds: number) {
  return seconds > 0 ? date(seconds * 1000) : "—";
}

function kilobytes(value: number) {
  return `${value.toLocaleString("en-US")} kB/s`;
}

function Fact({ children, label }: { children: React.ReactNode; label: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function bandwidthLabel(priority: number) {
  if (priority > 0) {
    return "High";
  }
  return priority < 0 ? "Low" : "Normal";
}

function modeLabel(mode: number, limit: string) {
  // Transmission enum: 0 = session setting, 1 = custom single limit, 2 = unlimited.
  if (mode === 1) {
    return limit;
  }
  if (mode === 2) {
    return "Unlimited";
  }
  return "Session setting";
}

function OverviewTab({ detail }: { detail: TransmissionTorrentDetail }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(detail.magnetLink);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-4 text-sm">
      <dl className="grid gap-3 sm:grid-cols-2">
        <Fact label="Status">
          {stateLabels[detail.state]}
          {detail.errorString ? ` · ${detail.errorString}` : ""}
        </Fact>
        <Fact label="Added">{timestamp(detail.addedDate)}</Fact>
        <Fact label="Completed">{timestamp(detail.doneDate ?? 0)}</Fact>
        <Fact label="Download folder">{detail.downloadDir || "—"}</Fact>
        <Fact label="Downloaded">{bytes(detail.downloadedEver)}</Fact>
        <Fact label="Uploaded">{bytes(detail.uploadedEver)}</Fact>
        <Fact label="Download speed">{speed(detail.rateDownload)}</Fact>
        <Fact label="Upload speed">{speed(detail.rateUpload)}</Fact>
        <Fact label="Time downloading">{duration(detail.secondsDownloading)}</Fact>
        <Fact label="Time seeding">{duration(detail.secondsSeeding)}</Fact>
        <Fact label="Download limit">
          {detail.downloadLimited ? kilobytes(detail.downloadLimit) : "Unlimited"}
        </Fact>
        <Fact label="Upload limit">
          {detail.uploadLimited ? kilobytes(detail.uploadLimit) : "Unlimited"}
        </Fact>
        <Fact label="Honors session limits">{detail.honorsSessionLimits ? "Yes" : "No"}</Fact>
        <Fact label="Bandwidth priority">{bandwidthLabel(detail.bandwidthPriority)}</Fact>
        <Fact label="Share ratio">
          {modeLabel(detail.seedRatioMode, String(detail.seedRatioLimit))}
        </Fact>
        <Fact label="Stop when idle">
          {modeLabel(detail.seedIdleMode, `${detail.seedIdleLimit} min`)}
        </Fact>
        <Fact label="Peers">{detail.peersConnected}</Fact>
        <Fact label="Pieces">
          {detail.pieceCount} × {bytes(detail.pieceSize)}
        </Fact>
        <Fact label="Private torrent">{detail.isPrivate ? "Yes" : "No"}</Fact>
        <Fact label="Created by">{detail.creator || "—"}</Fact>
        <Fact label="Comment">{detail.comment || "—"}</Fact>
        <Fact label="Info hash">
          <code className="text-xs">{detail.infoHash}</code>
        </Fact>
      </dl>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">Magnet link</span>
        <div className="flex items-start gap-2">
          <code className="min-w-0 flex-1 break-all rounded-md border bg-muted/40 p-2 text-xs">
            {detail.magnetLink || "—"}
          </code>
          <Button
            aria-label="Copy magnet link"
            disabled={!detail.magnetLink}
            onClick={() => void copy()}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            {copied ? <CheckIcon className="size-3.5" /> : <CopyIcon className="size-3.5" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

function FilesTab({
  detail,
  onApplied,
  serverId,
}: {
  detail: TransmissionTorrentDetail;
  onApplied: () => Promise<void>;
  serverId: string;
}) {
  const [wanted, setWanted] = useState(
    () => new Set(detail.files.filter((file) => file.wanted).map((file) => file.index))
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = new Set(detail.files.filter((file) => file.wanted).map((file) => file.index));
  const changed = wanted.size !== current.size || [...wanted].some((index) => !current.has(index));
  const apply = async () => {
    setBusy(true);
    setError(null);
    const { error: failure } = await api.transmission
      .servers({ id: serverId })
      .torrents({ torrentId: String(detail.id) })
      .files.put({ wanted: [...wanted].sort((left, right) => left - right) });
    setBusy(false);
    if (failure) {
      setError(errorMessage(failure, "Unable to change the selected files"));
      return;
    }
    await onApplied();
  };
  const toggle = (index: number, checked: boolean) => {
    setWanted((previous) => {
      const next = new Set(previous);
      if (checked) {
        next.add(index);
      } else {
        next.delete(index);
      }
      return next;
    });
  };
  return (
    <div className="flex flex-col gap-3">
      {error === null ? null : (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <ul className="max-h-80 divide-y overflow-y-auto text-sm">
        {detail.files.map((file) => (
          <li className="py-2" key={file.index}>
            <div className="flex items-start gap-3">
              <Checkbox
                checked={wanted.has(file.index)}
                id={`transmission-file-${file.index}`}
                onCheckedChange={(value) => toggle(file.index, value === true)}
              />
              <div className="min-w-0 flex-1">
                <label
                  className="block truncate"
                  htmlFor={`transmission-file-${file.index}`}
                  title={file.name}
                >
                  {file.name}
                </label>
                <p className="text-muted-foreground text-xs">
                  {bytes(file.downloaded)} / {bytes(file.length)} ·{" "}
                  {percent(file.length === 0 ? 0 : file.downloaded / file.length)}
                </p>
                <Progress
                  aria-label={`${file.name} progress`}
                  className="mt-1"
                  value={Math.round(file.length === 0 ? 0 : (file.downloaded / file.length) * 100)}
                />
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex justify-end">
        <Button disabled={busy || !changed} onClick={() => void apply()} size="sm" type="button">
          {busy ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
          Apply file selection
        </Button>
      </div>
    </div>
  );
}

function TrackersTab({ detail }: { detail: TransmissionTorrentDetail }) {
  if (detail.trackers.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No tracker</EmptyTitle>
          <EmptyDescription>
            This torrent uses DHT, peer exchange or local discovery only.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className="max-h-80 divide-y overflow-y-auto text-xs">
      {detail.trackers.map((tracker) => (
        <li className="flex flex-col gap-1 py-2" key={`${tracker.tier}:${tracker.id}`}>
          <code className="break-all">{tracker.announce}</code>
          <span className="text-muted-foreground">
            Tier {tracker.tier} · {tracker.seederCount ?? "—"} seeds · {tracker.leecherCount ?? "—"}{" "}
            leechers · {tracker.lastAnnounceResult ?? "not announced yet"}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PeersTab({ detail }: { detail: TransmissionTorrentDetail }) {
  if (detail.peers.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No connected peer</EmptyTitle>
          <EmptyDescription>
            Ask for more peers, or wait for the next tracker announce.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className="max-h-80 divide-y overflow-y-auto text-xs">
      {detail.peers.map((peer) => (
        <li className="flex flex-col gap-1 py-2" key={`${peer.address}:${peer.clientName}`}>
          <span className="break-all font-medium">{peer.address || "Unknown address"}</span>
          <span className="text-muted-foreground">
            {peer.clientName || "Unknown client"} · {percent(peer.progress)} ·{" "}
            {speed(peer.rateToClient)} down · {speed(peer.rateToPeer)} up
            {peer.isEncrypted ? " · encrypted" : ""}
            {peer.isIncoming ? " · incoming" : ""}
            {peer.peerIsChoked ? " · choked" : ""}
            {peer.peerIsInterested ? " · interested" : ""}
          </span>
        </li>
      ))}
    </ul>
  );
}
