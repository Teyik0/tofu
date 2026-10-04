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
          <span>0 o/s</span>
        </div>
      )}
      <svg
        aria-label="Historique réel des débits de réception et d’envoi"
        preserveAspectRatio="none"
        role="img"
        viewBox="0 0 600 100"
      >
        <path d="M0 12H600 M0 51H600 M0 90H600" fill="none" opacity=".08" stroke="currentColor" />
        <polyline
          fill="none"
          points={points("download")}
          stroke="#66834c"
          strokeWidth={small ? 3 : 2}
          vectorEffect="non-scaling-stroke"
        />
        <polyline
          fill="none"
          points={points("upload")}
          stroke="#a59a80"
          strokeWidth={small ? 3 : 2}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      {!small && (
        <div className="chart-legend">
          <span>
            <i className="download-dot" />
            Réception
          </span>
          <span>
            <i className="upload-dot" />
            Envoi
          </span>
          <span className="muted">Les 2 dernières minutes · tous les torrents</span>
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
      setFileError(cause instanceof Error ? cause.message : "Impossible d’enregistrer le fichier");
    } finally {
      setSavingFile(null);
    }
  };
  const tabs = ["Activité", "Fichiers", "Trackers", "Pairs", "Informations"];
  const trackerLabels = {
    announcing: "Annonce…",
    error: "Erreur",
    paused: "En pause",
    waiting: "En attente",
    working: "Connecté",
  };
  return (
    <section aria-label="Détails du torrent" className="detail-pane">
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
              aria-label="Vérifier les fichiers"
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
              aria-label="Copier le lien magnet"
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
                aria-label="Ouvrir le dossier"
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
              aria-label="Supprimer le torrent"
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
      <Tabs defaultValue="Activité">
        <TabsList aria-label="Détails" className="tabs" variant="line">
          {tabs.map((name) => (
            <TabsTrigger key={name} value={name}>
              {name}
              {name === "Fichiers" && <Badge variant="secondary">{torrent.files.length}</Badge>}
              {name === "Trackers" && <Badge variant="secondary">{torrent.trackers.length}</Badge>}
              {name === "Pairs" && <Badge variant="secondary">{torrent.peers}</Badge>}
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
          <TabsContent value="Activité">
            <div className="activity-layout">
              <div>
                <div className="section-heading">
                  <h3>Trafic en temps réel</h3>
                  <span className="live">
                    <i />
                    Actualisation en direct
                  </span>
                </div>
                <TrafficChart samples={data.history} small={false} />
                <div className="pieces-heading">
                  <span>Disponibilité locale</span>
                  <span className="mono">
                    {torrent.verifiedPieces.toLocaleString("fr-FR")} /{" "}
                    {torrent.pieces.toLocaleString("fr-FR")} pièces
                  </span>
                </div>
                <div
                  aria-label={`${torrent.verifiedPieces} pièces vérifiées sur ${torrent.pieces}`}
                  className="pieces"
                  role="img"
                >
                  {torrent.pieceMap.map((value, index) => (
                    <i
                      key={`piece-${torrent.id}-${index}`}
                      style={{
                        background:
                          value === 0 ? "#e8e9e3" : `rgba(102, 131, 76, ${0.25 + value * 0.75})`,
                      }}
                    />
                  ))}
                </div>
              </div>
              <dl className="stats-grid">
                <Stat
                  label="Téléchargé"
                  value={`${bytes(torrent.downloaded)} / ${bytes(torrent.length)}`}
                />
                <Stat label="Envoyé" value={bytes(torrent.uploaded)} />
                <Stat label="Ratio" value={ratio(torrent.ratio)} />
                <Stat
                  label="Temps restant"
                  value={torrent.progress === 1 ? "Terminé" : duration(torrent.eta)}
                />
                <Stat
                  label="Pairs connectés"
                  value={`${torrent.peers} · ${torrent.seeds} sources`}
                />
                <Stat
                  label="Essaim · sources / pairs"
                  value={`${torrent.swarmSeeds ?? "—"} / ${torrent.swarmPeers ?? "—"}`}
                />
                <Stat label="Temps actif" value={duration(torrent.activeSeconds)} />
                <Stat label="Temps en partage" value={duration(torrent.seedSeconds)} />
              </dl>
            </div>
          </TabsContent>
          <TabsContent value="Fichiers">
            <div className="section-heading">
              <h3>
                {torrent.files.length} fichier{torrent.files.length > 1 ? "s" : ""}
              </h3>
              <span className="muted">Choisissez ce que vous téléchargez.</span>
            </div>
            {torrent.files.length === 0 ? (
              <p className="panel-empty">En attente des métadonnées du torrent.</p>
            ) : (
              <div className="table-scroll">
                <table className="inner-table">
                  <thead>
                    <tr>
                      <th>Nom du fichier</th>
                      <th>Taille</th>
                      <th>Progression</th>
                      <th>Priorité</th>
                      <th>
                        <span className="sr-only">Télécharger</span>
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
                              aria-label={`Progression de ${file.name}`}
                              value={file.progress * 100}
                            />
                            <span className="mono">{percent(file.progress)}</span>
                          </div>
                        </td>
                        <td>
                          <Select
                            disabled={busy}
                            items={[
                              { label: "Ignorer", value: "skip" },
                              { label: "Normale", value: "normal" },
                              { label: "Haute", value: "high" },
                            ]}
                            onValueChange={(value) =>
                              void act(`${base}/files/${file.index}`, "PUT", {
                                priority: value as FilePriority,
                              })
                            }
                            value={file.priority}
                          >
                            <SelectTrigger aria-label={`Priorité de ${file.name}`} size="sm">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent alignItemWithTrigger={false}>
                              <SelectGroup>
                                <SelectItem value="skip">Ignorer</SelectItem>
                                <SelectItem value="normal">Normale</SelectItem>
                                <SelectItem value="high">Haute</SelectItem>
                              </SelectGroup>
                            </SelectContent>
                          </Select>
                        </td>
                        <td>
                          {file.progress === 1 && (
                            <ActionTooltip>
                              <Button
                                aria-label={`Enregistrer ${file.name}`}
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
                  Réannoncer
                </Button>
                <Button
                  onClick={() => open({ torrent, type: "trackers" })}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  <Icon name="edit" size={15} />
                  Gérer les trackers
                </Button>
              </div>
            </div>
            {torrent.trackers.length ? (
              <div className="table-scroll">
                <table className="inner-table">
                  <thead>
                    <tr>
                      <th>URL du tracker</th>
                      <th>État</th>
                      <th>Sources</th>
                      <th>Pairs</th>
                      <th>Dernière annonce</th>
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
                            <small>Intervalle : {duration(row.interval)}</small>
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
                                aria-label={`Supprimer ${row.url}`}
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
                Aucun tracker. La découverte peut utiliser la DHT ou des pairs directs.
                <Button
                  onClick={() => open({ torrent, type: "trackers" })}
                  size="sm"
                  type="button"
                  variant="link"
                >
                  Ajouter un tracker
                </Button>
              </div>
            )}
          </TabsContent>
          <TabsContent value="Pairs">
            <div className="section-heading">
              <h3>
                Pairs connectés <span className="muted">{torrent.peers}</span>
              </h3>
              <Button
                disabled={torrent.status === "paused"}
                onClick={() => open({ torrent, type: "peer" })}
                size="sm"
                type="button"
                variant="outline"
              >
                <Icon name="plus" size={15} />
                Ajouter un pair
              </Button>
            </div>
            {torrent.peerList.length ? (
              <div className="table-scroll">
                <table className="inner-table">
                  <thead>
                    <tr>
                      <th>Adresse</th>
                      <th>Client</th>
                      <th>Transport</th>
                      <th>Réception</th>
                      <th>Envoi</th>
                      <th>Progression</th>
                      <th>Indicateurs</th>
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
                          title="I : intéressé ; i : pair intéressé ; C : envoi bloqué ; c : réception bloquée"
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
                  ? "Les connexions sont fermées pendant la pause."
                  : "Aucun pair connecté pour le moment."}
              </p>
            )}
          </TabsContent>
          <TabsContent value="Informations">
            <dl className="info-grid">
              <Stat label="Hash du torrent" value={torrent.id} />
              <Stat label="Dossier" value={torrent.savePath} />
              <Stat label="Ajouté le" value={date(torrent.addedAt)} />
              <Stat label="Terminé le" value={date(torrent.completedAt)} />
              <Stat label="Dernier transfert" value={date(torrent.lastTransferAt)} />
              <Stat label="Données reçues sur le réseau" value={bytes(torrent.received)} />
              <Stat label="Taille des pièces" value={bytes(torrent.pieceLength)} />
              <Stat
                label="Visibilité"
                value={torrent.private ? "Torrent privé" : "Torrent public"}
              />
              <Stat label="Créé avec" value={torrent.createdBy || "—"} />
              <Stat label="Commentaire" value={torrent.comment || "—"} />
            </dl>
          </TabsContent>
        </div>
      </Tabs>
    </section>
  );
});
