import { useMutation } from "@teyik0/furin/client";
import { FolderIcon, LinkIcon, LoaderCircleIcon, ShieldCheckIcon } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";
import { api } from "../client";
import type { DashboardState, Destination, TorrentDetail } from "../types";
import { request } from "./api";
import { TorrentFileInput } from "./torrent-file-input";
import { Alert, AlertDescription } from "./ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { Field, FieldContent, FieldDescription, FieldGroup, FieldLabel } from "./ui/field";
import { Input } from "./ui/input";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "./ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import { Textarea } from "./ui/textarea";
import { UpdatesPanel } from "./updates";

export type ModalKind =
  | FormModalKind
  | { type: "plugins" }
  | { type: "automation"; destinationId: string };
export type FormModalKind =
  | { type: "add"; destinationId: string }
  | { type: "drop"; files: File[] }
  | { type: "destination"; destination: Destination | null }
  | { type: "settings" }
  | { type: "remove"; torrent: TorrentDetail }
  | { type: "trackers"; torrent: TorrentDetail }
  | { type: "peer"; torrent: TorrentDetail };

function ModalFrame({
  remove,
  title,
  description,
  children,
  close,
}: {
  remove: boolean;
  title: string;
  description: string;
  children: ReactNode;
  close: () => void;
}) {
  return remove ? (
    <AlertDialog
      onOpenChange={(value) => {
        if (!value) {
          close();
        }
      }}
      open
    >
      <AlertDialogContent className="tofu-modal">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        {children}
      </AlertDialogContent>
    </AlertDialog>
  ) : (
    <Dialog
      onOpenChange={(value) => {
        if (!value) {
          close();
        }
      }}
      open
    >
      <DialogContent
        className="tofu-modal"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {children}
      </DialogContent>
    </Dialog>
  );
}

export function Modal({
  modal,
  data,
  close,
  done,
}: {
  modal: FormModalKind;
  data: DashboardState;
  close: () => void;
  done: (id: string | null, destinationId: string | null) => void;
}) {
  const initialDestination =
    modal.type === "add"
      ? data.destinations.find((destination) => destination.id === modal.destinationId)
      : null;
  const upload = useMutation(api.api.torrents.file.post);
  const createDestination = useMutation(api.api.destinations.post);
  const [droppedFiles, setDroppedFiles] = useState(modal.type === "drop" ? modal.files : []);
  const [destinationId, setDestinationId] = useState(initialDestination?.id ?? "default");
  const [name, setName] = useState(
    modal.type === "destination" ? (modal.destination?.name ?? "") : ""
  );
  const [path, setPath] = useState(
    modal.type === "destination"
      ? (modal.destination?.downloadPath ?? data.settings.downloadPath)
      : data.settings.downloadPath
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [paused, setPaused] = useState(false);
  const [trackers, setTrackers] = useState(
    modal.type === "trackers" ? modal.torrent.trackers.map((row) => row.url).join("\n") : ""
  );
  const [removeFiles, setRemoveFiles] = useState(false);
  const [moveFiles, setMoveFiles] = useState(false);
  const [runInBackground, setRunInBackground] = useState(data.settings.runInBackground);
  const editedDestination =
    modal.type === "destination"
      ? modal.destination
      : modal.type === "settings"
        ? data.destinations.find((destination) => destination.id === "default")
        : null;
  const destinationChanged = Boolean(editedDestination && path !== editedDestination.downloadPath);
  const existingTorrents = editedDestination
    ? data.torrents.filter((torrent) => torrent.destinationId === editedDestination.id)
    : [];
  const offerMove = destinationChanged && existingTorrents.length > 0;
  const checkingTorrent = existingTorrents.find(
    (torrent) => torrent.status === "checking" || torrent.status === "moving"
  );
  const [down, setDown] = useState(
    data.settings.downloadLimit === -1 ? "" : String(data.settings.downloadLimit / 1024)
  );
  const [up, setUp] = useState(
    data.settings.uploadLimit === -1 ? "" : String(data.settings.uploadLimit / 1024)
  );
  const titles = {
    add: "Ajouter un torrent",
    destination:
      modal.type === "destination" && modal.destination ? "Modifier l’onglet" : "Créer un onglet",
    drop: "Choisir la destination",
    peer: "Ajouter un pair",
    remove: "Supprimer le torrent",
    settings: "Préférences",
    trackers: "Gérer les trackers",
  };
  const descriptions = {
    add: "Déposez un fichier ou collez un lien pour commencer.",
    destination: "Un onglet, un dossier. Plusieurs onglets peuvent utiliser le même dossier.",
    drop: "Les torrents démarreront immédiatement dans le dossier choisi.",
    peer: "Connectez-vous directement à un pair connu.",
    remove: "Les fichiers restent sur le disque, sauf si vous demandez leur suppression.",
    settings: "Vos limites s’appliquent immédiatement à tous les transferts.",
    trackers: "Ajoutez, modifiez ou retirez les URLs. Les fichiers téléchargés sont conservés.",
  };
  const urls = () =>
    trackers
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  const browse = async () => {
    try {
      const result = await request<{ path: string | null }>("/directory", "POST", undefined);
      if (result.path) {
        setPath(result.path);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Impossible d’ouvrir le dossier");
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      let selected: string | null = null;
      let savedDestination: string | null = null;
      if (modal.type === "drop") {
        let target = destinationId;
        if (target === "new") {
          const destination = await createDestination.mutateAsync({ downloadPath: path, name });
          if (!(destination && "id" in destination)) {
            throw new Error("Impossible de créer l’onglet");
          }
          target = destination.id;
          setDestinationId(target);
        }
        for (const droppedFile of droppedFiles) {
          // biome-ignore lint/performance/noAwaitInLoops: preserve order and allow retrying only the remaining files.
          const result = await upload.mutateAsync({
            destinationId: target,
            file: droppedFile,
            paused: "false",
          });
          if (!(result && "id" in result)) {
            throw new Error(
              result && "error" in result ? result.error : "Impossible d’ajouter le torrent"
            );
          }
          selected = result.id;
          setDroppedFiles((remaining) => remaining.filter((item) => item !== droppedFile));
        }
        savedDestination = target;
      } else if (modal.type === "add") {
        let result: { id: string };
        if (file) {
          const body = new FormData();
          body.set("file", file);
          body.set("paused", String(paused));
          body.set("destinationId", destinationId);
          body.set("trackers", trackers);
          result = await request("/torrents/file", "POST", body);
        } else {
          result = await request("/torrents", "POST", {
            destinationId,
            paused,
            source: source.trim(),
            trackers: urls(),
          });
        }
        selected = result.id;
        savedDestination = destinationId;
      } else if (modal.type === "destination") {
        const result = await request<Destination>(
          modal.destination ? `/destinations/${modal.destination.id}` : "/destinations",
          modal.destination ? "PUT" : "POST",
          { downloadPath: path, moveFiles: offerMove && moveFiles, name }
        );
        savedDestination = result.id;
      } else if (modal.type === "trackers") {
        await request(`/torrents/${modal.torrent.id}/trackers`, "PUT", { urls: urls() });
      } else if (modal.type === "peer") {
        await request(`/torrents/${modal.torrent.id}/peers`, "POST", { peer: source.trim() });
      } else if (modal.type === "remove") {
        await request(`/torrents/${modal.torrent.id}`, "DELETE", { deleteFiles: removeFiles });
      } else {
        await request("/settings", "PUT", {
          downloadLimit: down === "" ? -1 : Math.round(Number(down) * 1024),
          downloadPath: path,
          moveFiles: offerMove && moveFiles,
          runInBackground,
          uploadLimit: up === "" ? -1 : Math.round(Number(up) * 1024),
        });
      }
      done(selected, savedDestination);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Une erreur est survenue");
    } finally {
      setBusy(false);
    }
  };
  const submitButton = (
    <Button
      disabled={busy}
      type="submit"
      variant={modal.type === "remove" ? "destructive" : "default"}
    >
      {busy === true && <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />}
      {busy
        ? offerMove && moveFiles
          ? "Déplacement en cours…"
          : "Un instant…"
        : modal.type === "drop"
          ? "Télécharger"
          : modal.type === "add"
            ? "Ajouter le torrent"
            : modal.type === "remove"
              ? "Supprimer"
              : modal.type === "destination" && !modal.destination
                ? "Créer l’onglet"
                : "Enregistrer"}
    </Button>
  );
  return (
    <ModalFrame
      close={() => {
        if (!busy) {
          close();
        }
      }}
      description={descriptions[modal.type]}
      remove={modal.type === "remove"}
      title={titles[modal.type]}
    >
      <form className={modal.type === "add" ? "torrent-add-form" : undefined} onSubmit={submit}>
        <FieldGroup>
          {modal.type === "drop" && (
            <>
              <FieldDescription>
                {droppedFiles.map((item) => item.name).join(", ")}
              </FieldDescription>
              <Field>
                <FieldLabel htmlFor="drop-destination">Onglet de destination</FieldLabel>
                <Select
                  disabled={busy}
                  items={[
                    ...data.destinations.map((destination) => ({
                      label: destination.name,
                      value: destination.id,
                    })),
                    { label: "Créer un nouvel onglet…", value: "new" },
                  ]}
                  onValueChange={(value) => {
                    if (value !== null) {
                      setDestinationId(value);
                    }
                  }}
                  value={destinationId}
                >
                  <SelectTrigger className="w-full" id="drop-destination">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {data.destinations.map((destination) => (
                        <SelectItem key={destination.id} value={destination.id}>
                          {destination.name}
                        </SelectItem>
                      ))}
                      <SelectItem value="new">Créer un nouvel onglet…</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                {destinationId !== "new" && (
                  <FieldDescription className="destination-path">
                    {data.destinations.find((destination) => destination.id === destinationId)
                      ?.downloadPath ?? path}
                  </FieldDescription>
                )}
              </Field>
            </>
          )}
          {modal.type === "add" && (
            <>
              <TorrentFileInput
                disabled={busy}
                file={file}
                onChange={(selected) => {
                  setFile(selected);
                  if (selected) {
                    setSource("");
                  }
                }}
                onError={setError}
              />
              <div className="torrent-source-divider">
                <span>ou avec un lien</span>
              </div>
              <Field>
                <FieldLabel htmlFor="torrent-source">Lien magnet ou URL</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <LinkIcon />
                  </InputGroupAddon>
                  <InputGroupInput
                    disabled={Boolean(file) || busy}
                    id="torrent-source"
                    onChange={(event) => setSource(event.target.value)}
                    placeholder="Collez un lien magnet ou https://…"
                    required={!file}
                    spellCheck={false}
                    value={source}
                  />
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="torrent-destination">Onglet de destination</FieldLabel>
                <Select
                  disabled={busy}
                  items={data.destinations.map((destination) => ({
                    label: destination.name,
                    value: destination.id,
                  }))}
                  onValueChange={(value) => {
                    if (value !== null) {
                      setDestinationId(value);
                    }
                  }}
                  value={destinationId}
                >
                  <SelectTrigger className="w-full" id="torrent-destination">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {data.destinations.map((destination) => (
                        <SelectItem key={destination.id} value={destination.id}>
                          {destination.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <FieldDescription className="destination-path">
                  {
                    data.destinations.find((destination) => destination.id === destinationId)
                      ?.downloadPath
                  }
                </FieldDescription>
              </Field>
              <details className="torrent-add-options">
                <summary>Trackers supplémentaires</summary>
                <Field className="mt-3">
                  <FieldLabel htmlFor="extra-trackers">Une URL par ligne</FieldLabel>
                  <Textarea
                    id="extra-trackers"
                    onChange={(event) => setTrackers(event.target.value)}
                    rows={3}
                    value={trackers}
                  />
                </Field>
              </details>
              <Field orientation="horizontal">
                <Checkbox
                  checked={paused}
                  disabled={busy}
                  id="torrent-paused"
                  onCheckedChange={(value) => setPaused(value === true)}
                />
                <FieldLabel htmlFor="torrent-paused">Ajouter en pause</FieldLabel>
              </Field>
            </>
          )}
          {(modal.type === "destination" || (modal.type === "drop" && destinationId === "new")) && (
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="destination-name">Nom de l’onglet</FieldLabel>
              <Input
                aria-invalid={Boolean(error)}
                disabled={busy}
                id="destination-name"
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </Field>
          )}
          {(modal.type === "destination" ||
            modal.type === "settings" ||
            (modal.type === "drop" && destinationId === "new")) && (
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="destination-path">Dossier de téléchargement</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  aria-invalid={Boolean(error)}
                  disabled={busy}
                  id="destination-path"
                  onChange={(event) => setPath(event.target.value)}
                  required
                  value={path}
                />
                {data.session.mode === "desktop" && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton disabled={busy} onClick={() => void browse()} type="button">
                      <FolderIcon />
                      Parcourir
                    </InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
              <FieldDescription>
                {offerMove && moveFiles
                  ? "Les téléchargements de cet onglet utiliseront le nouveau dossier."
                  : "Ce dossier s’applique aux prochains ajouts. Les fichiers existants gardent leur emplacement."}
              </FieldDescription>
            </Field>
          )}
          {offerMove === true && (
            <>
              <Field orientation="horizontal">
                <Checkbox
                  checked={moveFiles}
                  disabled={busy}
                  id="move-files"
                  onCheckedChange={(value) => setMoveFiles(value === true)}
                />
                <FieldContent>
                  <FieldLabel htmlFor="move-files">
                    Déplacer les fichiers déjà téléchargés
                  </FieldLabel>
                  <FieldDescription>
                    {existingTorrents.length} torrent{existingTorrents.length > 1 ? "s" : ""} dans
                    cet onglet. Les transferts seront interrompus pendant le déplacement puis
                    reprendront ; les torrents en pause resteront en pause.
                  </FieldDescription>
                </FieldContent>
              </Field>
              {busy === false && moveFiles === true && checkingTorrent !== undefined && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {checkingTorrent.name} est en cours de{" "}
                    {checkingTorrent.status === "checking" ? "vérification" : "déplacement"}.
                    Attendez la fin avant de déplacer ses fichiers.
                  </AlertDescription>
                </Alert>
              )}
              {busy === true && moveFiles === true && (
                <FieldDescription role="status">
                  Déplacement des fichiers en cours. Cette opération peut prendre du temps selon
                  leur taille.
                </FieldDescription>
              )}
            </>
          )}
          {modal.type === "trackers" && (
            <Field>
              <FieldLabel htmlFor="tracker-urls">Trackers · une URL par ligne</FieldLabel>
              <Textarea
                id="tracker-urls"
                onChange={(event) => setTrackers(event.target.value)}
                rows={8}
                spellCheck={false}
                value={trackers}
              />
              <FieldDescription>Protocoles HTTP, HTTPS, UDP, WS et WSS.</FieldDescription>
            </Field>
          )}
          {modal.type === "peer" && (
            <Field>
              <FieldLabel htmlFor="peer-address">Adresse IP ou hôte et port</FieldLabel>
              <Input
                id="peer-address"
                onChange={(event) => setSource(event.target.value)}
                placeholder="192.168.1.10:51413"
                required
                value={source}
              />
            </Field>
          )}
          {modal.type === "remove" && (
            <>
              <p>
                Retirer <strong>{modal.torrent.name}</strong> de Tofu ?
              </p>
              <Field orientation="horizontal">
                <Checkbox
                  checked={removeFiles}
                  disabled={busy}
                  id="remove-files"
                  onCheckedChange={(value) => setRemoveFiles(value === true)}
                />
                <FieldLabel htmlFor="remove-files">
                  Supprimer également les fichiers téléchargés
                </FieldLabel>
              </Field>
              {removeFiles === true && (
                <Alert variant="destructive">
                  <AlertDescription>
                    Cette suppression des fichiers est définitive.
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
          {modal.type === "settings" && (
            <>
              <FieldGroup className="grid grid-cols-2 gap-4">
                <Field>
                  <FieldLabel htmlFor="limit-download">Réception · Kio/s</FieldLabel>
                  <Input
                    id="limit-download"
                    min="0"
                    onChange={(event) => setDown(event.target.value)}
                    placeholder="Illimitée"
                    step="1"
                    type="number"
                    value={down}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="limit-upload">Envoi · Kio/s</FieldLabel>
                  <Input
                    id="limit-upload"
                    min="0"
                    onChange={(event) => setUp(event.target.value)}
                    placeholder="Illimité"
                    step="1"
                    type="number"
                    value={up}
                  />
                </Field>
              </FieldGroup>
              <FieldDescription>
                Un champ vide signifie illimité. 0 suspend le trafic.
              </FieldDescription>
              {data.session.mode === "desktop" && (
                <Field orientation="horizontal">
                  <Checkbox
                    checked={runInBackground}
                    disabled={busy}
                    id="run-in-background"
                    onCheckedChange={(value) => setRunInBackground(value === true)}
                  />
                  <FieldContent>
                    <FieldLabel htmlFor="run-in-background">Tourner en arrière-plan</FieldLabel>
                    <FieldDescription>
                      Fermer la fenêtre libère l’interface. Les transferts et automatisations
                      continuent. Retrouvez Tofu ou son interface web depuis l’icône de la barre de
                      menus. « Quitter Tofu » arrête le serveur.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              )}
              {data.session.mode === "desktop" && data.settings.runInBackground && (
                <Button
                  disabled={busy}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    void request("/desktop/background", "POST", {})
                      .catch((cause: unknown) => {
                        setError(
                          cause instanceof Error
                            ? cause.message
                            : "Passage en arrière-plan impossible"
                        );
                      })
                      .finally(() => setBusy(false));
                  }}
                  type="button"
                  variant="outline"
                >
                  Passer en arrière-plan maintenant
                </Button>
              )}
              <UpdatesPanel disabled={busy} />
              <Alert>
                <ShieldCheckIcon />
                <AlertDescription>
                  Vos transferts et préférences sont enregistrés sur cette machine.
                </AlertDescription>
              </Alert>
            </>
          )}
          {error !== null && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </FieldGroup>
        {modal.type === "remove" ? (
          <AlertDialogFooter className="mt-6">
            <AlertDialogCancel disabled={busy}>Annuler</AlertDialogCancel>
            {submitButton}
          </AlertDialogFooter>
        ) : (
          <DialogFooter className="mt-6">
            <Button disabled={busy} onClick={close} type="button" variant="outline">
              Annuler
            </Button>
            {submitButton}
          </DialogFooter>
        )}
      </form>
    </ModalFrame>
  );
}
