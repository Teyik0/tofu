import { Link } from "@teyik0/furin/link";
import { useAtomValue } from "jotai";
import {
  ArrowDownToLineIcon,
  InfoIcon,
  LoaderCircleIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  Trash2Icon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { stateLabels } from "../../api/modules/transmission/mapping";
import type {
  TransmissionServer,
  TransmissionState,
  TransmissionTorrent,
} from "../../api/modules/transmission/model";
import { bytes, duration, percent, speed } from "../../components/format";
import { OptionSelect } from "../../components/option-select";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../../components/ui/empty";
import { Progress } from "../../components/ui/progress";
import { Skeleton } from "../../components/ui/skeleton";
import { api } from "../../lib/client";
import { errorMessage } from "../../lib/errors";
import { sessionAtom } from "../../state/workspace";
import { TorrentDetailDialog } from "./_detail";
import { AddTorrentDialog, LimitsDialog, RemoveTorrentDialog } from "./_dialogs";

const POLL_INTERVAL = 3000;

type Dialog =
  | { kind: "add" }
  | { kind: "limits" }
  | { kind: "remove"; torrent: TransmissionTorrent }
  | { kind: "detail"; torrent: TransmissionTorrent }
  | null;

const ACTION_BATCH = 500;

function actionBatches(ids: number[]) {
  const batches: number[][] = [];
  for (let index = 0; index < ids.length; index += ACTION_BATCH) {
    batches.push(ids.slice(index, index + ACTION_BATCH));
  }
  return batches;
}

function useTransmissionWorkspace() {
  const session = useAtomValue(sessionAtom);
  const [servers, setServers] = useState<TransmissionServer[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [state, setState] = useState<TransmissionState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const request = useRef(0);

  const loadServers = useCallback(async () => {
    try {
      const { data, error: failure } = await api.transmission.servers.get();
      if (failure) {
        setError(errorMessage(failure, "Unable to read the Transmission servers"));
        return;
      }
      setError(null);
      setServers(data);
      setSelected((current) => current ?? data[0]?.id ?? null);
    } catch {
      setError("The server could not be reached. Check the connection and try again.");
    }
  }, []);

  useEffect(() => {
    void loadServers();
  }, [loadServers]);

  const read = useCallback(async () => {
    if (!selected) {
      return;
    }
    const generation = request.current + 1;
    request.current = generation;
    try {
      const { data, error: failure } = await api.transmission.servers({ id: selected }).state.get();
      // A response that started before a server switch must not overwrite the new state.
      if (generation !== request.current) {
        return;
      }
      if (failure) {
        setError(errorMessage(failure, "Unable to read this Transmission server"));
        return;
      }
      setError(null);
      setState(data);
    } catch {
      if (generation === request.current) {
        setError("The server could not be reached. Check the connection and try again.");
      }
    }
  }, [selected]);

  useEffect(() => {
    // Invalidate in-flight reads and drop the previous server snapshot immediately.
    request.current += 1;
    setState(null);
    if (!selected) {
      return;
    }
    void read();
    const timer = setInterval(() => void read(), POLL_INTERVAL);
    return () => clearInterval(timer);
  }, [read, selected]);

  const act = async (action: "start" | "stop" | "start-now" | "verify", ids: number[]) => {
    if (!selected || ids.length === 0) {
      return;
    }
    setBusy(true);
    try {
      const results = await Promise.all(
        actionBatches(ids).map((batch) =>
          api.transmission.servers({ id: selected }).action.post({ action, ids: batch })
        )
      );
      const failure = results.find((result) => result.error !== null)?.error;
      if (failure) {
        setError(errorMessage(failure, "Unable to control these torrents"));
        return;
      }
      await read();
    } catch {
      setError("The server could not be reached. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  return {
    act,
    busy,
    capabilities: {
      administer: session?.capabilities.administer === true,
      deleteFiles: session?.capabilities.deleteFiles === true,
      owner: session?.capabilities.owner === true,
    },
    dialog,
    error,
    read,
    reload: loadServers,
    selected,
    servers,
    setDialog,
    setSelected,
    state,
  };
}

type Workspace = ReturnType<typeof useTransmissionWorkspace>;

export function TransmissionWorkspace() {
  const workspace = useTransmissionWorkspace();
  if (workspace.servers === null) {
    if (workspace.error !== null) {
      return <WorkspaceFailure message={workspace.error} reload={workspace.reload} />;
    }
    return <WorkspaceLoading />;
  }
  if (workspace.servers.length === 0) {
    return <WorkspaceUnconfigured />;
  }
  return (
    <main className="flex h-full min-w-0 flex-col">
      <WorkspaceHeader workspace={workspace} />
      {workspace.error === null ? null : (
        <Alert className="mx-6 mt-4" variant="destructive">
          <AlertDescription>{workspace.error}</AlertDescription>
        </Alert>
      )}
      {workspace.state === null ? null : (
        <SessionBar
          act={workspace.act}
          busy={workspace.busy}
          read={workspace.read}
          session={workspace.state}
        />
      )}
      <section aria-label="Transmission torrents" className="min-h-0 flex-1 overflow-auto px-6">
        <TorrentList
          busy={workspace.busy}
          onDetails={(torrent) => workspace.setDialog({ kind: "detail", torrent })}
          onRemove={(torrent) => workspace.setDialog({ kind: "remove", torrent })}
          onStart={(torrent) => void workspace.act("start-now", [torrent.id])}
          onStop={(torrent) => void workspace.act("stop", [torrent.id])}
          state={workspace.state}
        />
      </section>
      <WorkspaceDialogs workspace={workspace} />
    </main>
  );
}

function WorkspaceFailure({ message, reload }: { message: string; reload: () => Promise<void> }) {
  return (
    <main className="flex h-full flex-col gap-4 p-6">
      <Alert variant="destructive">
        <AlertDescription>{message}</AlertDescription>
      </Alert>
      <div>
        <Button onClick={() => void reload()} type="button" variant="outline">
          Try again
        </Button>
      </div>
    </main>
  );
}

function WorkspaceLoading() {
  return (
    <main className="flex h-full flex-col gap-4 p-6">
      <Skeleton className="h-8 w-48" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-24 w-full" />
    </main>
  );
}

function WorkspaceUnconfigured() {
  return (
    <main className="flex h-full items-center justify-center p-6">
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No Transmission server configured</EmptyTitle>
          <EmptyDescription>
            Add the RPC address of a transmission-daemon in Settings → Connections, then come back
            here to manage its torrents.
          </EmptyDescription>
        </EmptyHeader>
        <Button nativeButton={false} render={<Link to="/options/connections" />} variant="outline">
          Open Connections
        </Button>
      </Empty>
    </main>
  );
}

function WorkspaceHeader({ workspace }: { workspace: Workspace }) {
  const { state } = workspace;
  return (
    <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
      <div className="flex min-w-0 items-center gap-3">
        <ArrowDownToLineIcon aria-hidden="true" className="size-5 text-muted-foreground" />
        <div className="min-w-0">
          <h1 className="truncate font-semibold text-lg">Transmission</h1>
          <p className="truncate text-muted-foreground text-xs">
            {state
              ? `${state.server.name} · ${state.server.origin} · ${state.session.version} (RPC ${state.session.rpcVersion})`
              : "Reading the RPC session…"}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(workspace.servers ?? []).length > 1 ? (
          <OptionSelect
            ariaLabel="Transmission server"
            className="w-48"
            disabled={workspace.busy}
            onValueChange={(value) => workspace.setSelected(value || null)}
            options={(workspace.servers ?? []).map((server) => ({
              label: server.name,
              value: server.id,
            }))}
            value={workspace.selected}
          />
        ) : null}
        {workspace.capabilities.administer ? (
          <Button
            disabled={workspace.busy || !state}
            onClick={() => workspace.setDialog({ kind: "limits" })}
            size="sm"
            type="button"
            variant="outline"
          >
            <SlidersHorizontalIcon data-icon="inline-start" />
            Limits
          </Button>
        ) : null}
        <Button
          disabled={workspace.busy || !state}
          onClick={() => workspace.setDialog({ kind: "add" })}
          size="sm"
          type="button"
        >
          <PlusIcon data-icon="inline-start" />
          Add a torrent
        </Button>
      </div>
    </header>
  );
}

function limitText(enabled: boolean, limit: number) {
  return enabled ? `${limit} kB/s` : "unlimited";
}

function SessionBar({
  act,
  busy,
  read,
  session,
}: {
  act: (action: "start" | "stop" | "start-now" | "verify", ids: number[]) => Promise<void>;
  busy: boolean;
  read: () => Promise<void>;
  session: TransmissionState;
}) {
  const { torrents } = session;
  const running = torrents.filter((torrent) => torrent.state !== "stopped");
  const stopped = torrents.filter((torrent) => torrent.state === "stopped");
  return (
    <section
      aria-label="Transmission session"
      className="flex flex-wrap items-center gap-4 border-b px-6 py-3 text-xs"
    >
      <span className="flex items-center gap-1">
        <ArrowDownToLineIcon aria-hidden="true" className="size-3.5" />
        {speed(session.session.downloadSpeed)}
      </span>
      <span className="flex items-center gap-1">
        <UploadIcon aria-hidden="true" className="size-3.5" />
        {speed(session.session.uploadSpeed)}
      </span>
      <span>
        {session.session.activeTorrentCount} active · {session.session.torrentCount} total
      </span>
      <span>
        Download limit {limitText(session.session.downloadLimited, session.session.downloadLimit)}
      </span>
      <span>
        Upload limit {limitText(session.session.uploadLimited, session.session.uploadLimit)}
      </span>
      {session.session.altSpeedEnabled ? <Badge variant="outline">Alt speed</Badge> : null}
      <div className="ml-auto flex items-center gap-1">
        <Button
          disabled={busy || running.length === 0}
          onClick={() =>
            void act(
              "stop",
              running.map((torrent) => torrent.id)
            )
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          <PauseIcon data-icon="inline-start" />
          Pause all
        </Button>
        <Button
          disabled={busy || stopped.length === 0}
          onClick={() =>
            void act(
              "start-now",
              stopped.map((torrent) => torrent.id)
            )
          }
          size="sm"
          type="button"
          variant="ghost"
        >
          <PlayIcon data-icon="inline-start" />
          Resume all
        </Button>
        <Button
          aria-label="Refresh now"
          disabled={busy}
          onClick={() => void read()}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          {busy ? (
            <LoaderCircleIcon className="animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
        </Button>
      </div>
    </section>
  );
}

function TorrentList({
  busy,
  state,
  onDetails,
  onStart,
  onStop,
  onRemove,
}: {
  busy: boolean;
  state: TransmissionState | null;
  onDetails: (torrent: TransmissionTorrent) => void;
  onStart: (torrent: TransmissionTorrent) => void;
  onStop: (torrent: TransmissionTorrent) => void;
  onRemove: (torrent: TransmissionTorrent) => void;
}) {
  if (state === null) {
    return (
      <div className="flex flex-col gap-3 py-6">
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (state.torrents.length === 0) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>No torrents in Transmission</EmptyTitle>
          <EmptyDescription>
            Add a magnet link or a .torrent URL to start a transfer on the daemon.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <ul className="divide-y">
      {state.torrents.map((torrent) => (
        <li className="py-3" key={torrent.id}>
          <TorrentRow
            busy={busy}
            onDetails={() => onDetails(torrent)}
            onRemove={() => onRemove(torrent)}
            onStart={() => onStart(torrent)}
            onStop={() => onStop(torrent)}
            torrent={torrent}
          />
        </li>
      ))}
    </ul>
  );
}

function ratioLabel(ratio: number | "infinite" | null) {
  if (ratio === null) {
    return "—";
  }
  return ratio === "infinite" ? "∞" : ratio.toFixed(2);
}

function TorrentRow({
  busy,
  torrent,
  onDetails,
  onStart,
  onStop,
  onRemove,
}: {
  busy: boolean;
  torrent: TransmissionTorrent;
  onDetails: () => void;
  onStart: () => void;
  onStop: () => void;
  onRemove: () => void;
}) {
  const stopped = torrent.state === "stopped";
  const label = torrent.name || `Torrent ${torrent.id}`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="truncate font-medium">{torrent.name || `Torrent ${torrent.id}`}</p>
          <p className="truncate text-muted-foreground text-xs">
            {stateLabels[torrent.state]} · {percent(torrent.progress)} ·{" "}
            {bytes(torrent.sizeWhenDone)} · {speed(torrent.rateDownload)} down ·{" "}
            {speed(torrent.rateUpload)} up · {torrent.peersConnected} peers · ETA{" "}
            {duration(torrent.eta)} · ratio {ratioLabel(torrent.ratio)}
          </p>
          {torrent.errorString ? (
            <p className="text-destructive text-xs">{torrent.errorString}</p>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            aria-label={stopped ? `Resume ${label}` : `Pause ${label}`}
            disabled={busy}
            onClick={stopped ? onStart : onStop}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            {stopped ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
          </Button>
          <Button
            aria-label={`Details for ${label}`}
            disabled={busy}
            onClick={onDetails}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <InfoIcon className="size-3.5" />
          </Button>
          <Button
            aria-label={`Remove ${label}`}
            disabled={busy}
            onClick={onRemove}
            size="icon-sm"
            type="button"
            variant="ghost"
          >
            <Trash2Icon className="size-3.5" />
          </Button>
        </div>
      </div>
      <Progress aria-label={`${label} progress`} value={Math.round(torrent.progress * 100)} />
    </div>
  );
}

function WorkspaceDialogs({ workspace }: { workspace: Workspace }) {
  const { dialog, state } = workspace;
  if (!(dialog && state)) {
    return null;
  }
  if (dialog.kind === "add") {
    return (
      <AddTorrentDialog
        close={() => workspace.setDialog(null)}
        owner={workspace.capabilities.owner}
        refresh={workspace.read}
        serverId={state.server.id}
        session={state.session}
      />
    );
  }
  if (dialog.kind === "limits") {
    return (
      <LimitsDialog
        close={() => workspace.setDialog(null)}
        refresh={workspace.read}
        serverId={state.server.id}
        session={state.session}
      />
    );
  }
  if (dialog.kind === "detail") {
    return (
      <TorrentDetailDialog
        close={() => workspace.setDialog(null)}
        refresh={workspace.read}
        serverId={state.server.id}
        torrent={dialog.torrent}
      />
    );
  }
  return (
    <RemoveTorrentDialog
      canDeleteFiles={workspace.capabilities.deleteFiles}
      close={() => workspace.setDialog(null)}
      refresh={workspace.read}
      serverId={state.server.id}
      torrent={dialog.torrent}
    />
  );
}
