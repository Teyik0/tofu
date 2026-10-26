import { useQuery } from "@teyik0/furin/client";
import { bytes, percent, torrentStatusLabel } from "../../../../components/format";
import { Alert, AlertDescription, AlertTitle } from "../../../../components/ui/alert";
import { Progress } from "../../../../components/ui/progress";
import { Skeleton } from "../../../../components/ui/skeleton";
import { api } from "../../../../lib/client";
import { errorMessage } from "../../../../lib/errors";

export function RemoteTorrentDetail({
  serverId,
  threadId,
  torrentId,
}: {
  serverId: string;
  threadId: string;
  torrentId: string;
}) {
  const { data, error } = useQuery(
    api.desktop.servers({ id: serverId }).threads({ threadId }).torrents({ torrentId }).get.live()
  );
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Unable to load torrent details</AlertTitle>
        <AlertDescription>
          {errorMessage(error, "This server could not return the torrent")}
        </AlertDescription>
      </Alert>
    );
  }
  if (!data) {
    return (
      <div className="flex flex-col gap-4" role="status">
        <span className="sr-only">Loading torrent details…</span>
        <Skeleton className="h-6 w-4/5" />
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }
  const { server, torrent } = data;
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-2">
        <h2 className="wrap-anywhere font-semibold text-xl">{torrent.name}</h2>
        <p className="text-muted-foreground text-sm">On {server.name} · Read-only</p>
      </header>
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap justify-between gap-2 text-sm">
          <span>{torrentStatusLabel(torrent)}</span>
          <span className="text-muted-foreground tabular-nums">
            {percent(torrent.progress)} · {bytes(torrent.length)}
          </span>
        </div>
        <Progress
          aria-label={`Transfer progress for ${torrent.name}`}
          value={torrent.progress === null ? null : torrent.progress * 100}
        />
      </div>
      <section aria-label="Torrent files">
        <h3 className="mb-3 font-medium text-sm">Files · {torrent.files.length}</h3>
        {torrent.files.length === 0 ? (
          <p className="text-muted-foreground text-sm">File metadata is not available yet.</p>
        ) : (
          <ul className="divide-y divide-border">
            {torrent.files.map((file) => (
              <li className="flex flex-col gap-2 py-3" key={file.index}>
                <span className="wrap-anywhere text-sm">{file.name}</span>
                <div className="flex justify-between gap-3 text-muted-foreground text-xs tabular-nums">
                  <span>{bytes(file.length)}</span>
                  <span>{percent(file.progress)}</span>
                </div>
                <Progress
                  aria-label={`Transfer progress for ${file.name}`}
                  value={file.progress === null ? null : file.progress * 100}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
