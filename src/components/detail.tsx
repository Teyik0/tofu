// biome-ignore-all lint/suspicious/noArrayIndexKey: piece-map bins have fixed positions and no component state.
import { cn } from "cn";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { sessionAtom } from "../state/workspace";
import type { LibraryTorrentDetail, LiveState } from "../types";
import { ActionTooltip } from "./action-tooltip";
import {
  DetailActivity,
  DetailFiles,
  DetailInformation,
  DetailPeers,
  DetailTrackers,
} from "./detail-panels";
import { bytes, duration, percent, ratio, speed, torrentStatusLabel } from "./format";
import { Icon } from "./icon";
import type { ModalKind } from "./modal";
import { StatusGlyph } from "./status-glyph";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { useDetailActions } from "./use-detail-actions";

export const Detail = memo(function DetailView({
  torrent,
  data,
  busy,
  act,
  open,
}: {
  torrent: LibraryTorrentDetail;
  data: LiveState;
  busy: boolean;
  act: (id: string, task: () => Promise<unknown>) => Promise<void>;
  open: (modal: ModalKind) => void;
}) {
  const model = useDetailActions({ data, torrent });
  const { verify, repair, reveal, pause, resume, fileError } = model;
  const destination = data.destinations.find((item) => item.id === torrent.destinationId);
  const stopped = torrent.status === "paused" || torrent.status === "error";
  const capabilities = useAtomValue(sessionAtom)?.capabilities;
  const manage = capabilities?.manage === true;
  // Paths, peers and trackers arrive only for administrators, through the live stream.
  const host = data.detailHost?.id === torrent.id ? data.detailHost : null;
  const tabs = model.tabs.filter((name) => host || (name !== "Trackers" && name !== "Peers"));
  return (
    <section aria-label="Torrent details" className="detail-pane">
      <div className="detail-toolbar">
        <div className="detail-breadcrumb">
          <Icon name="folder" size={14} />
          <span>{destination?.name ?? "Downloads"}</span>
          <Icon name="chevron" size={12} />
          <span>Torrent details</span>
        </div>
        <div className="detail-actions">
          {manage ? (
            <ActionTooltip>
              <Button
                aria-label="Verify files"
                disabled={busy || !torrent.pieces}
                onClick={() => void act(torrent.id, () => verify.mutateAsync())}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Icon name="shield" />
              </Button>
            </ActionTooltip>
          ) : null}
          {host ? (
            <ActionTooltip>
              <Button
                aria-label="Copy magnet link"
                onClick={() => void navigator.clipboard.writeText(host.magnet)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Icon name="copy" />
              </Button>
            </ActionTooltip>
          ) : null}
          {manage ? (
            <>
              <span aria-hidden="true" className="toolbar-divider" />
              <ActionTooltip>
                <Button
                  aria-label="Remove torrent"
                  className="danger-text"
                  onClick={() => open({ torrent, type: "remove" })}
                  size="icon-sm"
                  type="button"
                  variant="ghost"
                >
                  <Icon name="trash" />
                </Button>
              </ActionTooltip>
            </>
          ) : null}
        </div>
      </div>
      <div className="detail-top">
        <div className="detail-name">
          <StatusGlyph progress={torrent.progress} size={40} status={torrent.status} />
          <div className="detail-title">
            <h2 title={torrent.name}>{torrent.name}</h2>
            <p>
              {torrent.files.length} file{torrent.files.length === 1 ? "" : "s"} ·{" "}
              {bytes(torrent.length)}
            </p>
          </div>
        </div>
      </div>
      <div className="detail-transfer">
        <div className="detail-status-row">
          <Badge className={cn("status", torrent.status)} variant="secondary">
            {torrentStatusLabel(torrent)}
          </Badge>
          {manage ? (
            <Button
              disabled={busy}
              onClick={() =>
                void act(torrent.id, () =>
                  torrent.storageIssue
                    ? repair.mutateAsync()
                    : stopped
                      ? resume.mutateAsync()
                      : pause.mutateAsync()
                )
              }
              size="sm"
              variant="outline"
            >
              <Icon name={stopped ? "play" : "pause"} />
              {torrent.storageIssue ? "Repair download" : stopped ? "Resume" : "Pause"}
            </Button>
          ) : null}
        </div>
        <div className="detail-progress-heading">
          <span>
            {torrent.progress === null
              ? "Waiting for metadata"
              : `${percent(torrent.progress)} complete`}
          </span>
          <span>
            {stopped
              ? torrentStatusLabel(torrent)
              : torrent.progress === 1
                ? "Complete"
                : torrent.eta === null
                  ? "Calculating…"
                  : `${duration(torrent.eta)} remaining`}
          </span>
        </div>
        <Progress
          aria-label="Torrent progress"
          value={torrent.progress === null ? null : torrent.progress * 100}
        />
        <dl className="detail-metrics">
          <div>
            <dt>↓ Download</dt>
            <dd>{speed(torrent.downloadSpeed)}</dd>
          </div>
          <div>
            <dt>↑ Upload</dt>
            <dd>{speed(torrent.uploadSpeed)}</dd>
          </div>
          <div>
            <dt>Peers</dt>
            <dd>{torrent.peers}</dd>
          </div>
          <div>
            <dt>Ratio</dt>
            <dd>{ratio(torrent.ratio)}</dd>
          </div>
        </dl>
        {capabilities && !manage && stopped ? (
          <p className="detail-note">
            This download is paused on {data.server.name}. Ask someone with Management access to
            resume it.
          </p>
        ) : null}
        {host ? (
          <div className="detail-destination">
            <Icon name="folder" />
            <div>
              <span>Save location</span>
              <code>{host.savePath}</code>
            </div>
            {Boolean(capabilities?.hostNative) && (
              <ActionTooltip>
                <Button
                  aria-label="Open folder"
                  disabled={busy}
                  onClick={() => void act(torrent.id, () => reveal.mutateAsync())}
                  size="icon-sm"
                  variant="ghost"
                >
                  <Icon name="folder" />
                </Button>
              </ActionTooltip>
            )}
          </div>
        ) : null}
      </div>
      {fileError !== null && (
        <Alert variant="destructive">
          <AlertDescription>{fileError}</AlertDescription>
        </Alert>
      )}
      <Tabs className="detail-tabs" defaultValue="Activity">
        <TabsList aria-label="Details" className="tabs" variant="line">
          {tabs.map((name) => (
            <TabsTrigger key={name} value={name}>
              {name}
              {name === "Files" && <Badge variant="secondary">{torrent.files.length}</Badge>}
              {name === "Trackers" && host && (
                <Badge variant="secondary">{host.trackers.length}</Badge>
              )}
              {name === "Peers" && <Badge variant="secondary">{torrent.peers}</Badge>}
            </TabsTrigger>
          ))}
        </TabsList>
        <div className="detail-content">
          {torrent.error !== null && (
            <Alert variant="destructive">
              <AlertDescription>
                <Icon name="alert" />
                {torrent.error}
                {torrent.storageIssue !== null && manage && (
                  <>
                    {host?.storageIssue ? (
                      <>
                        <ul className="list-inside list-disc">
                          {host.storageIssue.paths.slice(0, 10).map((path) => (
                            <li className="break-all" key={path}>
                              {path}
                            </li>
                          ))}
                        </ul>
                        {host.storageIssue.paths.length > 10 && (
                          <p>And {host.storageIssue.paths.length - 10} more files.</p>
                        )}
                      </>
                    ) : null}
                    <div className="flex flex-wrap gap-2">
                      <Button
                        disabled={busy || torrent.status === "checking"}
                        onClick={() => void act(torrent.id, () => repair.mutateAsync())}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        {torrent.storageIssue.kind === "missing-files" ||
                        torrent.storageIssue.kind === "modified-files"
                          ? "Repair download"
                          : "Retry storage"}
                      </Button>
                      {capabilities?.owner ? (
                        <Button
                          disabled={busy || torrent.status === "checking"}
                          onClick={() => open({ torrent, type: "locate" })}
                          size="sm"
                          type="button"
                          variant="outline"
                        >
                          Locate files
                        </Button>
                      ) : null}
                    </div>
                    {torrent.status === "paused" && (
                      <p>Repair checks the remaining data and keeps this torrent paused.</p>
                    )}
                  </>
                )}
              </AlertDescription>
            </Alert>
          )}
          <DetailActivity data={data} model={model} torrent={torrent} />
          <DetailFiles act={act} busy={busy} host={host} model={model} torrent={torrent} />
          {host ? (
            <>
              <DetailTrackers
                act={act}
                busy={busy}
                host={host}
                model={model}
                open={open}
                torrent={torrent}
              />
              <DetailPeers host={host} open={open} torrent={torrent} />
            </>
          ) : null}
          <DetailInformation host={host} torrent={torrent} />
        </div>
      </Tabs>
    </section>
  );
});
