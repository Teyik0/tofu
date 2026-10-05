// biome-ignore-all lint/suspicious/noArrayIndexKey: piece-map bins have fixed positions and no component state.
import { memo, useState } from "react";
import type { DashboardState, FilePriority, SpeedSample, TorrentDetail } from "../types";
import { ActionTooltip } from "./action-tooltip";
import { request } from "./api";
import { bytes, date, duration, percent, ratio, speed, statusLabels } from "./format";
import { Icon } from "./icon";
import type { ModalKind } from "./modal";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Progress } from "./ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export const TrafficChart = memo(function TrafficChartView({
  samples,
  small,
}: {
  samples: SpeedSample[];
  small: boolean;
}) {
  const maximum = Math.max(1024, ...samples.flatMap((sample) => [sample.download, sample.upload]));
  const points = (key: "download" | "upload") =>
    samples
      .map(
        (sample, index) =>
          `${(index / Math.max(1, samples.length - 1)) * 600},${90 - (sample[key] / maximum) * 78}`
      )
      .join(" ");
  return (
    <div className={small ? "sparkline" : "traffic-chart"}>
      {!small && (
        <div className="chart-scale">
          <span>{speed(maximum)}</span>
          <span>0 B/s</span>
        </div>
      )}
      <svg
        aria-label="Actual download and upload speed history"
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 600 100"
      >
        <path d="M0 12H600 M0 51H600 M0 90H600" fill="none" opacity=".08" stroke="currentColor" />
        <polyline
          fill="none"
          points={points("download")}
          stroke="var(--chart-download)"
          strokeWidth={small ? 3 : 2}
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          fill="none"
          points={points("upload")}
          stroke="var(--chart-upload)"
          strokeWidth={small ? 3 : 2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {!small && (
        <div className="chart-legend">
          <span>
            <i className="download-dot" />
            Download
          </span>
          <span>
            <i className="upload-dot" />
            Upload
          </span>
          <span className="muted">Last 2 minutes · all torrents</span>
        </div>
      )}
    </div>
  );
});
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

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
  act: (path: string, method: string, body: object | undefined) => Promise<void>;
  open: (modal: ModalKind) => void;
}) {
  const base = `/torrents/${torrent.id}`;
  const [fileError, setFileError] = useState<string | null>(null);
  const [savingFile, setSavingFile] = useState<number | null>(null);
  const downloadFile = async (index: number, name: string) => {
    setFileError(null);
    setSavingFile(index);
    try {
      await request(`${base}/files/${index}/availability`, "GET", undefined);
      const link = document.createElement("a");
      link.href = `/api${base}/files/${index}/content`;
      link.download = name;
      link.click();
    } catch (cause) {
      setFileError(cause instanceof Error ? cause.message : "Unable to save the file");
    } finally {
      setSavingFile(null);
    }
  };
  const tabs = ["Activity", "Files", "Trackers", "Peers", "Information"];
  const trackerLabels = {
    announcing: "Annonce…",
    error: "Error",
    paused: "Paused",
    waiting: "Waiting",
    working: "Connected",
  };
  return (
    <section aria-label="Torrent details" className="detail-pane">
      <div className="detail-top">
        <div className="detail-name">
          <Icon name={torrent.progress === 1 ? "check" : "download"} />
          <strong>{torrent.name}</strong>
          <Badge className={`status ${torrent.status}`} variant="secondary">
            {statusLabels[torrent.status]}
          </Badge>
        </div>
        <div className="detail-actions">
          <ActionTooltip>
            <Button
              aria-label="Verify files"
              disabled={busy || !torrent.pieces}
              onClick={() => void act(`${base}/verify`, "POST", undefined)}
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
                onClick={() => void act(`${base}/reveal`, "POST", undefined)}
                size="icon-sm"
                type="button"
                variant="ghost"
              >
                <Icon name="folder" />
              </Button>
            </ActionTooltip>
          )}
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
      <Tabs defaultValue="Activity">
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
              </AlertDescription>
            </Alert>
          )}
          <TabsContent value="Activity">
            <div className="activity-layout">
              <div>
                <div className="section-heading">
                  <h3>Live traffic</h3>
                  <span className="live">
                    <i />
                    Live updates
                  </span>
                </div>
                <TrafficChart samples={data.history} small={false} />
                <div className="pieces-heading">
                  <span>Local availability</span>
                  <span className="mono">
                    {torrent.verifiedPieces.toLocaleString("en-US")} /{" "}
                    {torrent.pieces.toLocaleString("en-US")} pieces
                  </span>
                </div>
                <div
                  aria-label={`${torrent.verifiedPieces} verified pieces out of ${torrent.pieces}`}
                  className="pieces"
                  role="img"
                >
                  {torrent.pieceMap.map((value, index) => (
                    <i
                      key={`piece-${torrent.id}-${index}`}
                      style={{
                        background:
                          value === 0
                            ? "var(--progress-track)"
                            : `color-mix(in srgb, var(--chart-download) ${(0.25 + value * 0.75) * 100}%, transparent)`,
                      }}
                    />
                  ))}
                </div>
              </div>
              <dl className="stats-grid">
                <Stat
                  label="Downloaded"
                  value={`${bytes(torrent.downloaded)} / ${bytes(torrent.length)}`}
                />
                <Stat label="Uploaded" value={bytes(torrent.uploaded)} />
                <Stat label="Ratio" value={ratio(torrent.ratio)} />
                <Stat
                  label="Time remaining"
                  value={torrent.progress === 1 ? "Completed" : duration(torrent.eta)}
                />
                <Stat
                  label="Connected peers"
                  value={`${torrent.peers} · ${torrent.seeds} seed${torrent.seeds === 1 ? "" : "s"}`}
                />
                <Stat
                  label="Swarm · seeds / peers"
                  value={`${torrent.swarmSeeds ?? "—"} / ${torrent.swarmPeers ?? "—"}`}
                />
                <Stat label="Active time" value={duration(torrent.activeSeconds)} />
                <Stat label="Seeding time" value={duration(torrent.seedSeconds)} />
              </dl>
            </div>
          </TabsContent>
          <TabsContent value="Files">
            <div className="section-heading">
              <h3>
                {torrent.files.length} file{torrent.files.length > 1 ? "s" : ""}
              </h3>
              <span className="muted">Choose what to download.</span>
            </div>
            {torrent.files.length === 0 ? (
              <p className="panel-empty">Waiting for torrent metadata.</p>
            ) : (
              <div className="table-scroll">
                <table className="inner-table">
                  <thead>
                    <tr>
                      <th>File name</th>
                      <th>Size</th>
                      <th>Progress</th>
                      <th>Priority</th>
                      <th>
                        <span className="sr-only">Download</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {torrent.files.map((file) => (
                      <tr key={file.index}>
                        <td>
                          <span className="file-name">
                            <Icon name="file" />
                            {file.path}
                          </span>
                        </td>
                        <td className="mono">{bytes(file.length)}</td>
                        <td>
                          <div className="file-progress">
                            <Progress
                              aria-label={`Progress for ${file.name}`}
                              value={file.progress * 100}
                            />
                            <span className="mono">{percent(file.progress)}</span>
                          </div>
                        </td>
                        <td>
                          <Select
                            disabled={busy}
                            items={[
                              { label: "Skip", value: "skip" },
                              { label: "Normal", value: "normal" },
                              { label: "High", value: "high" },
                            ]}
                            onValueChange={(value) =>
                              void act(`${base}/files/${file.index}`, "PUT", {
                                priority: value as FilePriority,
                              })
                            }
                            value={file.priority}
                          >
                            <SelectTrigger aria-label={`Priority for ${file.name}`} size="sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent alignItemWithTrigger={false}>
                              <SelectGroup>
                                <SelectItem value="skip">Skip</SelectItem>
                                <SelectItem value="normal">Normal</SelectItem>
                                <SelectItem value="high">High</SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </td>
                        <td>
                          {file.progress === 1 && (
                            <ActionTooltip>
                              <Button
                                aria-label={`Save ${file.name}`}
                                disabled={busy || savingFile !== null}
                                onClick={() => void downloadFile(file.index, file.name)}
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                              >
                                <Icon name="download" />
                              </Button>
                            </ActionTooltip>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </TabsContent>
          <TabsContent value="Trackers">
            <div className="section-heading">
              <h3>
                Trackers <span className="muted">{torrent.trackers.length}</span>
              </h3>
              <div className="inline-actions">
                <Button
                  disabled={busy || torrent.status === "paused" || !torrent.trackers.length}
                  onClick={() => void act(`${base}/announce`, "POST", undefined)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Icon name="refresh" size={15} />
                  Reannounce
                </Button>
                <Button
                  onClick={() => open({ torrent, type: "trackers" })}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Icon name="edit" size={15} />
                  Manage trackers
                </Button>
              </div>
            </div>
            {torrent.trackers.length ? (
              <div className="table-scroll">
                <table className="inner-table">
                  <thead>
                    <tr>
                      <th>Tracker URL</th>
                      <th>Status</th>
                      <th>Sources</th>
                      <th>Peers</th>
                      <th>Last announce</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {torrent.trackers.map((row) => (
                      <tr key={row.url}>
                        <td className="tracker-url" title={row.message ?? row.url}>
                          <Icon name="globe" size={15} />
                          <span>{row.url}</span>
                          {row.message !== null && (
                            <small className="danger-text">{row.message}</small>
                          )}
                        </td>
                        <td>
                          <Badge
                            className={`tracker-status ${row.status}`}
                            variant={row.status === "error" ? "destructive" : "secondary"}
                          >
                            {trackerLabels[row.status]}
                          </Badge>
                        </td>
                        <td className="mono">{row.seeds ?? "—"}</td>
                        <td className="mono">{row.leeches ?? "—"}</td>
                        <td className="mono">
                          {row.lastAnnounce
                            ? duration((Date.now() - row.lastAnnounce) / 1000)
                            : "—"}
                          {row.interval !== null && (
                            <small>Interval: {duration(row.interval)}</small>
                          )}
                        </td>
                        <td>
                          <div className="inline-actions">
                            <ActionTooltip>
                              <Button
                                aria-label={`Modifier ${row.url}`}
                                onClick={() => open({ torrent, type: "trackers" })}
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                              >
                                <Icon name="edit" size={15} />
                              </Button>
                            </ActionTooltip>
                            <ActionTooltip>
                              <Button
                                aria-label={`Remove ${row.url}`}
                                className="danger-text"
                                disabled={busy}
                                onClick={() =>
                                  void act(`${base}/trackers`, "PUT", {
                                    urls: torrent.trackers
                                      .filter((tracker) => tracker.url !== row.url)
                                      .map((tracker) => tracker.url),
                                  })
                                }
                                size="icon-sm"
                                type="button"
                                variant="ghost"
                              >
                                <Icon name="trash" size={15} />
                              </Button>
                            </ActionTooltip>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="panel-empty">
                No trackers. Discovery can use DHT or direct peers.
                <Button
                  onClick={() => open({ torrent, type: "trackers" })}
                  size="sm"
                  type="button"
                  variant="link"
                >
                  Add a tracker
                </Button>
              </div>
            )}
          </TabsContent>
          <TabsContent value="Peers">
            <div className="section-heading">
              <h3>
                Connected peers <span className="muted">{torrent.peers}</span>
              </h3>
              <Button
                disabled={torrent.status === "paused"}
                onClick={() => open({ torrent, type: "peer" })}
                size="sm"
                type="button"
                variant="outline"
              >
                <Icon name="plus" size={15} />
                Add a peer
              </Button>
            </div>
            {torrent.peerList.length ? (
              <div className="table-scroll">
                <table className="inner-table">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>Client</th>
                      <th>Transport</th>
                      <th>Download</th>
                      <th>Upload</th>
                      <th>Progress</th>
                      <th>Flags</th>
                    </tr>
                  </thead>
                  <tbody>
                    {torrent.peerList.map((peer) => (
                      <tr key={peer.id}>
                        <td className="mono">{peer.address}</td>
                        <td>{peer.client}</td>
                        <td className="mono">{peer.transport}</td>
                        <td className="mono">{speed(peer.downloadSpeed)}</td>
                        <td className="mono">{speed(peer.uploadSpeed)}</td>
                        <td className="mono">
                          {peer.progress === null ? "—" : percent(peer.progress)}
                        </td>
                        <td
                          className="mono"
                          title="I: interested; i: peer interested; C: upload choked; c: download choked"
                        >
                          {peer.flags}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="panel-empty">
                {torrent.status === "paused"
                  ? "Connections are closed while paused."
                  : "No peers connected yet."}
              </p>
            )}
          </TabsContent>
          <TabsContent value="Information">
            <dl className="info-grid">
              <Stat label="Torrent hash" value={torrent.id} />
              <Stat label="Folder" value={torrent.savePath} />
              <Stat label="Added on" value={date(torrent.addedAt)} />
              <Stat label="Completed on" value={date(torrent.completedAt)} />
              <Stat label="Last transfer" value={date(torrent.lastTransferAt)} />
              <Stat label="Data received over the network" value={bytes(torrent.received)} />
              <Stat label="Piece size" value={bytes(torrent.pieceLength)} />
              <Stat
                label="Visibility"
                value={torrent.private ? "Private torrent" : "Public torrent"}
              />
              <Stat label="Created with" value={torrent.createdBy || "—"} />
              <Stat label="Commentaire" value={torrent.comment || "—"} />
            </dl>
          </TabsContent>
        </div>
      </Tabs>
    </section>
  );
});
