// biome-ignore-all lint/suspicious/noArrayIndexKey: piece-map bins have fixed positions and no component state.
import { useAtomValue } from "jotai";
import type { FilePriority } from "../../../../package/plugins/src/torrent-types";
import { ActionTooltip } from "../../../../package/ui/src/action-tooltip";
import { bytes, date, duration, percent, ratio, speed } from "../../../../package/ui/src/format";
import { Badge } from "../../../../package/ui/src/ui/badge";
import { Button } from "../../../../package/ui/src/ui/button";
import { Progress } from "../../../../package/ui/src/ui/progress";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../../package/ui/src/ui/select";
import { TabsContent } from "../../../../package/ui/src/ui/tabs";
import type { TorrentHostDetail } from "../api/modules/dashboard/projection";
import { sessionAtom } from "../state/workspace";
import { Icon } from "./icon";
import { TrafficChart } from "./traffic-chart";
import type { DetailActionsProps, useDetailActions } from "./use-detail-actions";

export function DetailActivity({
  model,
  torrent,
  data,
}: Pick<DetailActionsProps, "torrent" | "data"> & { model: ReturnType<typeof useDetailActions> }) {
  const { latest } = model;
  return (
    <TabsContent value="Activity">
      <div className="activity-layout">
        <div className="activity-traffic">
          <div className="section-heading">
            <h3>Session traffic</h3>
            <div className="chart-legend">
              <span data-direction="down">
                <i />
                Download <b className="num">{speed(latest?.download ?? 0)}</b>
              </span>
              <span data-direction="up">
                <i />
                Upload <b className="num">{speed(latest?.upload ?? 0)}</b>
              </span>
            </div>
          </div>
          <TrafficChart samples={data.history} small={false} />
          <p className="chart-caption">Last 2 minutes · all torrents</p>
          <div className="pieces-heading">
            <span>Local availability</span>
            <span className="num">
              {torrent.verifiedPieces?.toLocaleString("en-US") ?? "—"} /{" "}
              {torrent.pieces.toLocaleString("en-US")} pieces
            </span>
          </div>
          <div
            aria-label={`${torrent.verifiedPieces ?? "—"} verified pieces out of ${torrent.pieces}`}
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
        <div className="stats-groups">
          <section aria-label="Transfer">
            <h4>Transfer</h4>
            <dl className="stats-grid">
              <Stat label="Downloaded" value={bytes(torrent.downloaded)} />
              <Stat label="Uploaded" value={bytes(torrent.uploaded)} />
              <Stat label="Ratio" value={ratio(torrent.ratio)} />
            </dl>
          </section>
          <section aria-label="Swarm">
            <h4>Swarm</h4>
            <dl className="stats-grid">
              <Stat
                label="Connected peers"
                value={`${torrent.peers} · ${torrent.seeds} seed${torrent.seeds === 1 ? "" : "s"}`}
              />
              <Stat
                label="Swarm · seeds / peers"
                value={`${torrent.swarmSeeds ?? "—"} / ${torrent.swarmPeers ?? "—"}`}
              />
            </dl>
          </section>
          <section aria-label="Time">
            <h4>Time</h4>
            <dl className="stats-grid">
              <Stat
                label="Time remaining"
                value={torrent.progress === 1 ? "Completed" : duration(torrent.eta)}
              />
              <Stat label="Active time" value={duration(torrent.activeSeconds)} />
              <Stat label="Seeding time" value={duration(torrent.seedSeconds)} />
            </dl>
          </section>
        </div>
      </div>
    </TabsContent>
  );
}

const playable =
  /\.(3gp|aac|ac3|ape|asf|avi|divx|dts|flac|flv|m2ts|m4a|m4v|mka|mkv|mov|mp3|mp4|mpeg|mpg|mts|ogg|ogm|ogv|opus|rm|rmvb|ts|vob|wav|webm|wma|wmv)$/i;

export function DetailFiles({
  model,
  torrent,
  busy,
  act,
  host,
}: Pick<DetailActionsProps, "torrent" | "busy" | "act"> & {
  host: TorrentHostDetail | null;
  model: ReturnType<typeof useDetailActions>;
}) {
  const { setPriority, savingFile, downloadFile } = model;
  const manage = useAtomValue(sessionAtom)?.capabilities.manage === true;
  return (
    <TabsContent value="Files">
      <div className="section-heading">
        <h3>
          {torrent.files.length} file{torrent.files.length > 1 ? "s" : ""}
        </h3>
        <span className="muted">{manage ? "Choose what to download." : "Play or save files."}</span>
      </div>
      {torrent.files.length === 0 ? (
        <p className="panel-empty">Waiting for torrent metadata.</p>
      ) : (
        <ul className="detail-files">
          {torrent.files.map((file) => (
            <li key={file.index}>
              <div className="detail-file-heading">
                <Icon name="file" />
                <div className="detail-file-copy">
                  <strong>{host?.files[file.index]?.path ?? file.name}</strong>
                  <span className="mono">
                    {bytes(file.length)} · {percent(file.progress)}
                  </span>
                </div>
              </div>
              <div className="detail-file-controls">
                <Select
                  disabled={busy || !manage}
                  items={[
                    { label: "Skip", value: "skip" },
                    { label: "Normal", value: "normal" },
                    { label: "High", value: "high" },
                  ]}
                  onValueChange={(value) =>
                    void act(torrent.id, () =>
                      setPriority.mutateAsync(file.index, value as FilePriority)
                    )
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
                </Select>{" "}
                {(file.progress === 1 || torrent.status !== "paused") &&
                  playable.test(file.name) && (
                    <ActionTooltip>
                      <Button
                        aria-label={`Play ${file.name}`}
                        onClick={() =>
                          // The player needs a full page load for its cross-origin isolation.
                          window.location.assign(`/player/${torrent.id}?file=${file.index}`)
                        }
                        size="icon-sm"
                        type="button"
                        variant="ghost"
                      >
                        <Icon name="play" />
                      </Button>
                    </ActionTooltip>
                  )}
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
              </div>
              <Progress
                aria-label={`Progress for ${file.name}`}
                value={file.progress === null ? null : file.progress * 100}
              />
            </li>
          ))}
        </ul>
      )}
    </TabsContent>
  );
}

export function DetailTrackers({
  model,
  torrent,
  busy,
  act,
  open,
  host,
}: Pick<DetailActionsProps, "torrent" | "busy" | "act" | "open"> & {
  host: TorrentHostDetail;
  model: ReturnType<typeof useDetailActions>;
}) {
  const { announce, setTrackers, trackerLabels } = model;
  return (
    <TabsContent value="Trackers">
      <div className="section-heading">
        <h3>
          Trackers <span className="muted">{host.trackers.length}</span>
        </h3>
        <div className="inline-actions">
          <Button
            disabled={busy || torrent.status === "paused" || !host.trackers.length}
            onClick={() => void act(torrent.id, () => announce.mutateAsync())}
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
      {host.trackers.length ? (
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
              {host.trackers.map((row) => (
                <tr key={row.url}>
                  <td className="tracker-url" title={row.message ?? row.url}>
                    <Icon name="globe" size={15} />
                    <span>{row.url}</span>
                    {row.message !== null && <small className="danger-text">{row.message}</small>}
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
                    {row.lastAnnounce ? duration((Date.now() - row.lastAnnounce) / 1000) : "—"}
                    {row.interval !== null && <small>Interval: {duration(row.interval)}</small>}
                  </td>
                  <td>
                    <div className="inline-actions">
                      <ActionTooltip>
                        <Button
                          aria-label={`Edit ${row.url}`}
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
                            void act(torrent.id, () =>
                              setTrackers.mutateAsync({
                                urls: host.trackers
                                  .filter((tracker) => tracker.url !== row.url)
                                  .map((tracker) => tracker.url),
                              })
                            )
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
  );
}

export function DetailPeers({
  torrent,
  open,
  host,
}: Pick<DetailActionsProps, "torrent" | "open"> & { host: TorrentHostDetail }) {
  return (
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
      {host.peerList.length ? (
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
              {host.peerList.map((peer) => (
                <tr key={peer.id}>
                  <td className="mono">{peer.address}</td>
                  <td>{peer.client}</td>
                  <td className="mono">{peer.transport}</td>
                  <td className="mono">{speed(peer.downloadSpeed)}</td>
                  <td className="mono">{speed(peer.uploadSpeed)}</td>
                  <td className="mono">{peer.progress === null ? "—" : percent(peer.progress)}</td>
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
  );
}

export function DetailInformation({
  torrent,
  host,
}: Pick<DetailActionsProps, "torrent"> & { host: TorrentHostDetail | null }) {
  return (
    <TabsContent value="Information">
      <dl className="info-grid">
        <Stat label="Torrent hash" value={torrent.id} />
        {host ? <Stat label="Folder" value={host.savePath} /> : null}
        <Stat label="Added on" value={date(torrent.addedAt)} />
        <Stat label="Completed on" value={date(torrent.completedAt)} />
        <Stat label="Last transfer" value={date(torrent.lastTransferAt)} />
        <Stat label="Data received over the network" value={bytes(torrent.received)} />
        <Stat label="Piece size" value={bytes(torrent.pieceLength)} />
        <Stat label="Visibility" value={torrent.private ? "Private torrent" : "Public torrent"} />
        <Stat label="Created with" value={torrent.createdBy || "—"} />
        <Stat label="Comment" value={torrent.comment || "—"} />
      </dl>
    </TabsContent>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
