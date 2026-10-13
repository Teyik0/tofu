// biome-ignore-all lint/suspicious/noArrayIndexKey: piece-map bins have fixed positions and no component state.
import { memo } from "react";
import type { DashboardState, TorrentDetail } from "../types";
import { ActionTooltip } from "./action-tooltip";
import {
  DetailActivity,
  DetailFiles,
  DetailInformation,
  DetailPeers,
  DetailTrackers,
} from "./detail-panels";
import { bytes, percent, torrentStatusLabel } from "./format";
import { Icon } from "./icon";
import type { ModalKind } from "./modal";
import { StatusGlyph } from "./status-glyph";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Tabs, TabsList, TabsTrigger } from "./ui/tabs";
import { useDetailActions } from "./use-detail-actions";

export const Detail = memo(function DetailView({
  torrent,
  data,
  busy,
  act,
  open,
}: {
  torrent: TorrentDetail;
  data: DashboardState;
  busy: boolean;
  act: (id: string, task: () => Promise<unknown>) => Promise<void>;
  open: (modal: ModalKind) => void;
}) {
  const model = useDetailActions({ data, torrent });
  const { verify, repair, reveal, fileError, tabs } = model;
  return (
    <section aria-label="Torrent details" className="detail-pane">
      <div className="detail-top">
        <div className="detail-name">
          <StatusGlyph progress={torrent.progress} size={40} status={torrent.status} />
          <div className="detail-title">
            <strong title={torrent.name}>{torrent.name}</strong>
            <div className="detail-meta">
              <Badge className={`status ${torrent.status}`} variant="secondary">
                {torrentStatusLabel(torrent)}
              </Badge>
              <span className="num">
                {bytes(torrent.downloaded)} of {bytes(torrent.length)}
              </span>
              <span className="num">{percent(torrent.progress)}</span>
              <span className="detail-path" title={torrent.savePath}>
                {torrent.savePath}
              </span>
            </div>
          </div>
        </div>
        <div className="detail-actions">
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
          <ActionTooltip>
            <Button
              aria-label="Copy magnet link"
              onClick={() => void navigator.clipboard.writeText(torrent.magnet)}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <Icon name="copy" />
            </Button>
          </ActionTooltip>
          {data.session.mode === "desktop" && (
            <ActionTooltip>
              <Button
                aria-label="Open folder"
                disabled={busy}
                onClick={() => void act(torrent.id, () => reveal.mutateAsync())}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Icon name="folder" />
              </Button>
            </ActionTooltip>
          )}
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
        </div>
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
              {name === "Trackers" && <Badge variant="secondary">{torrent.trackers.length}</Badge>}
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
                {torrent.storageIssue !== null && (
                  <>
                    <ul className="list-inside list-disc">
                      {torrent.storageIssue.paths.slice(0, 10).map((path) => (
                        <li className="break-all" key={path}>
                          {path}
                        </li>
                      ))}
                    </ul>
                    {torrent.storageIssue.paths.length > 10 && (
                      <p>And {torrent.storageIssue.paths.length - 10} more files.</p>
                    )}
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
                      <Button
                        disabled={busy || torrent.status === "checking"}
                        onClick={() => open({ torrent, type: "locate" })}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        Locate files
                      </Button>
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
          <DetailFiles act={act} busy={busy} model={model} torrent={torrent} />
          <DetailTrackers act={act} busy={busy} model={model} open={open} torrent={torrent} />
          <DetailPeers open={open} torrent={torrent} />
          <DetailInformation torrent={torrent} />
        </div>
      </Tabs>
    </section>
  );
});
