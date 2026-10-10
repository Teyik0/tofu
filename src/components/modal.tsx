import { Form, getDeepError, useField, useForm } from "@formisch/react";
import { useMutation } from "@teyik0/furin/client";
import { FolderIcon, LinkIcon, LoaderCircleIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { modalFormSchema } from "../api/modules/torrents/model";
import { api } from "../lib/client";
import type { DashboardState, Destination, DestinationInput, FormModalKind } from "../types";
import { DestinationIconPicker } from "./destination-icon";
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

export type { FormModalKind, ModalKind } from "../types";

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

/** Deletes a tab and returns the tab to show when the visible tab no longer exists. */
export function useDeleteDestination(active: string | null) {
  const remove = useMutation((id: string) => api.destinations({ id }).delete());
  return async (id: string) => {
    const result = await remove.mutateAsync(id);
    if (!(result && "removed" in result)) {
      throw new Error("Unable to delete the tab");
    }
    return active === id || active === result.removed ? "default" : null;
  };
}

export function DeleteDestinationModal({
  activeDestination,
  data,
  destination,
  cancel,
  close,
  done,
}: {
  activeDestination: string | null;
  data: DashboardState;
  destination: Destination;
  cancel: () => void;
  close: () => void;
  done: (id: string | null, destinationId: string | null) => Promise<void>;
}) {
  const deleteDestination = useDeleteDestination(activeDestination);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fallback = data.destinations.find((item) =>
    destination.id === "default" ? item.id !== "default" : item.id === "default"
  );
  const remove = async () => {
    setBusy(true);
    setError(null);
    try {
      await done(null, await deleteDestination(destination.id));
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to delete the tab");
    } finally {
      setBusy(false);
    }
  };
  return (
    <ModalFrame
      close={() => {
        if (!busy) {
          cancel();
        }
      }}
      description={`Torrents and automation rules will be reassigned to ${fallback?.name ?? "the default tab"}${destination.id === "default" ? ", which becomes the default tab" : ""}. Existing files stay in their current folders.`}
      remove
      title={`Delete tab ${destination.name}?`}
    >
      {error !== null && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <Button disabled={busy} onClick={() => void remove()} type="button" variant="destructive">
          {busy ? (
            <LoaderCircleIcon className="animate-spin" data-icon="inline-start" />
          ) : (
            <Trash2Icon data-icon="inline-start" />
          )}
          {busy ? "Deleting…" : "Delete tab"}
        </Button>
      </AlertDialogFooter>
    </ModalFrame>
  );
}

export function Modal({
  activeDestination,
  modal,
  data,
  close,
  done,
}: {
  activeDestination: string | null;
  modal: FormModalKind;
  data: DashboardState;
  close: () => void;
  done: (id: string | null, destinationId: string | null) => Promise<void>;
}) {
  const initialDestination =
    modal.type === "add"
      ? data.destinations.find((destination) => destination.id === modal.destinationId)
      : null;
  const upload = useMutation(api.torrents.file.post);
  const createDestination = useMutation(api.destinations.post);
  const updateDestination = useMutation((id: string, body: DestinationInput) =>
    api.destinations({ id }).put(body)
  );
  const addTorrent = useMutation(api.torrents.post);
  const updateTrackers = useMutation((id: string, trackerUrls: string[]) =>
    api.torrents({ id }).trackers.put({ urls: trackerUrls })
  );
  const addPeer = useMutation((id: string, peer: string) =>
    api.torrents({ id }).peers.post({ peer })
  );
  const removeTorrent = useMutation((id: string, deleteFiles: boolean) =>
    api.torrents({ id }).delete({ deleteFiles })
  );
  const chooseDirectory = useMutation(api.directory.post);
  const [droppedFiles, setDroppedFiles] = useState(modal.type === "drop" ? modal.files : []);
  const form = useForm({
    initialInput: {
      destinationIcon:
        modal.type === "destination" ? (modal.destination?.icon ?? "folder") : "folder",
      destinationId: initialDestination?.id ?? "default",
      file: null,
      moveFiles: false,
      name: modal.type === "destination" ? (modal.destination?.name ?? "") : "",
      path:
        modal.type === "destination"
          ? (modal.destination?.downloadPath ?? data.settings.downloadPath)
          : data.settings.downloadPath,
      paused: false,
      pinned: modal.type === "destination" ? (modal.destination?.pinned ?? false) : false,
      removeFiles: false,
      source: "",
      trackers:
        modal.type === "trackers" ? modal.torrent.trackers.map((row) => row.url).join("\n") : "",
    },
    schema: modalFormSchema(modal.type),
  });
  const destinationField = useField(form, { path: ["destinationId"] });
  const pinnedField = useField(form, { path: ["pinned"] });
  const iconField = useField(form, { path: ["destinationIcon"] });
  const nameField = useField(form, { path: ["name"] });
  const pathField = useField(form, { path: ["path"] });
  const sourceField = useField(form, { path: ["source"] });
  const fileField = useField(form, { path: ["file"] });
  const pausedField = useField(form, { path: ["paused"] });
  const trackersField = useField(form, { path: ["trackers"] });
  const removeFilesField = useField(form, { path: ["removeFiles"] });
  const moveFilesField = useField(form, { path: ["moveFiles"] });
  const destinationId = destinationField.input ?? "default";
  const setDestinationId = destinationField.onChange;
  const pinned = pinnedField.input === true;
  const setPinned = pinnedField.onChange;
  const destinationIcon = iconField.input ?? "folder";
  const setDestinationIcon = iconField.onChange;
  const name = nameField.input ?? "";
  const setName = nameField.onChange;
  const path = pathField.input ?? "";
  const setPath = pathField.onChange;
  const source = sourceField.input ?? "";
  const setSource = sourceField.onChange;
  const file = fileField.input ?? null;
  const setFile = fileField.onChange;
  const paused = pausedField.input === true;
  const setPaused = pausedField.onChange;
  const trackers = trackersField.input ?? "";
  const setTrackers = trackersField.onChange;
  const removeFiles = removeFilesField.input === true;
  const setRemoveFiles = removeFilesField.onChange;
  const moveFiles = moveFilesField.input === true;
  const setMoveFiles = moveFilesField.onChange;
  const [serverError, setError] = useState<string | null>(null);
  const error = getDeepError(form) ?? serverError;
  const busy = form.isSubmitting;
  const [deletingDestination, setDeletingDestination] = useState(false);
  const editedDestination = modal.type === "destination" ? modal.destination : null;
  const destinationChanged = Boolean(editedDestination && path !== editedDestination.downloadPath);
  const existingTorrents = editedDestination
    ? data.torrents.filter((torrent) => torrent.destinationId === editedDestination.id)
    : [];
  const offerMove = destinationChanged && existingTorrents.length > 0;
  const checkingTorrent = existingTorrents.find(
    (torrent) => torrent.status === "checking" || torrent.status === "moving"
  );
  if (deletingDestination && modal.type === "destination" && modal.destination) {
    return (
      <DeleteDestinationModal
        activeDestination={activeDestination}
        cancel={() => setDeletingDestination(false)}
        close={close}
        data={data}
        destination={modal.destination}
        done={done}
      />
    );
  }
  const titles = {
    add: "Add a torrent",
    destination: modal.type === "destination" && modal.destination ? "Edit tab" : "Create a tab",
    drop: "Choose destination",
    peer: "Add a peer",
    remove: "Remove torrent",
    trackers: "Manage trackers",
  };
  const descriptions = {
    add: "Drop a file or paste a link to get started.",
    destination: "One tab, one folder. Multiple tabs can use the same folder.",
    drop: "Torrents will start immediately in the selected folder.",
    peer: "Connect directly to a known peer.",
    remove: "Files remain on disk unless you choose to delete them.",
    trackers: "Add, edit, or remove URLs. Downloaded files are preserved.",
  };
  const urls = () =>
    trackers
      .split("\n")
      .map((value) => value.trim())
      .filter(Boolean);
  const browse = async () => {
    try {
      const result = await chooseDirectory.mutateAsync();
      if (result && "path" in result && result.path) {
        setPath(result.path);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to open the folder");
    }
  };
  const submit = async () => {
    setError(null);
    try {
      let selected: string | null = null;
      let savedDestination: string | null = null;
      if (modal.type === "drop") {
        let target = destinationId;
        if (target === "new") {
          const destination = await createDestination.mutateAsync({ downloadPath: path, name });
          if (!(destination && "id" in destination)) {
            throw new Error("Unable to create the tab");
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
            throw new Error("Unable to add the torrent");
          }
          selected = result.id;
          setDroppedFiles((remaining) => remaining.filter((item) => item !== droppedFile));
        }
        savedDestination = target;
      } else if (modal.type === "add") {
        const result = file
          ? await upload.mutateAsync({ destinationId, file, paused: String(paused), trackers })
          : await addTorrent.mutateAsync({
              destinationId,
              paused,
              source: source.trim(),
              trackers: urls(),
            });
        if (!(result && "id" in result)) {
          throw new Error("Unable to add the torrent");
        }
        selected = result.id;
        savedDestination = destinationId;
      } else if (modal.type === "destination") {
        const body: DestinationInput = {
          downloadPath: path,
          icon: destinationIcon,
          moveFiles: offerMove && moveFiles,
          name,
          pinned,
        };
        const result = modal.destination
          ? await updateDestination.mutateAsync(modal.destination.id, body)
          : await createDestination.mutateAsync(body);
        if (!(result && "id" in result)) {
          throw new Error("Unable to save the tab");
        }
        savedDestination = result.id;
      } else if (modal.type === "trackers") {
        await updateTrackers.mutateAsync(modal.torrent.id, urls());
      } else if (modal.type === "peer") {
        await addPeer.mutateAsync(modal.torrent.id, source.trim());
      } else if (modal.type === "remove") {
        await removeTorrent.mutateAsync(modal.torrent.id, removeFiles);
      }
      await done(selected, savedDestination);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "An error occurred");
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
          ? "Moving files…"
          : "One moment…"
        : modal.type === "drop"
          ? "Download"
          : modal.type === "add"
            ? "Add torrent"
            : modal.type === "remove"
              ? "Remove"
              : modal.type === "destination" && !modal.destination
                ? "Create tab"
                : "Save"}
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
      <Form
        className={modal.type === "add" ? "torrent-add-form" : undefined}
        of={form}
        onSubmit={submit}
      >
        <FieldGroup>
          {modal.type === "drop" && (
            <>
              <FieldDescription>
                {droppedFiles.map((item) => item.name).join(", ")}
              </FieldDescription>
              <Field>
                <FieldLabel htmlFor="drop-destination">Destination tab</FieldLabel>
                <Select
                  disabled={busy}
                  items={[
                    ...data.destinations.map((destination) => ({
                      label: destination.name,
                      value: destination.id,
                    })),
                    { label: "Create a new tab…", value: "new" },
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
                      <SelectItem value="new">Create a new tab…</SelectItem>
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
                <span>or use a link</span>
              </div>
              <Field>
                <FieldLabel htmlFor="torrent-source">Magnet link or URL</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <LinkIcon />
                  </InputGroupAddon>
                  <InputGroupInput
                    disabled={Boolean(file) || busy}
                    {...sourceField.props}
                    aria-invalid={Boolean(sourceField.errors)}
                    id="torrent-source"
                    onChange={(event) => setSource(event.target.value)}
                    placeholder="Paste a magnet link or https://…"
                    required={!file}
                    spellCheck={false}
                    value={source}
                  />
                </InputGroup>
              </Field>
              <Field>
                <FieldLabel htmlFor="torrent-destination">Destination tab</FieldLabel>
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
                <summary>Additional trackers</summary>
                <Field className="mt-3">
                  <FieldLabel htmlFor="extra-trackers">One URL per line</FieldLabel>
                  <Textarea
                    {...trackersField.props}
                    aria-invalid={Boolean(trackersField.errors)}
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
                <FieldLabel htmlFor="torrent-paused">Add paused</FieldLabel>
              </Field>
            </>
          )}
          {(modal.type === "destination" || (modal.type === "drop" && destinationId === "new")) && (
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="destination-name">Tab name</FieldLabel>
              <Input
                disabled={busy}
                {...nameField.props}
                aria-invalid={Boolean(nameField.errors)}
                id="destination-name"
                maxLength={80}
                onChange={(event) => setName(event.target.value)}
                required
                value={name}
              />
            </Field>
          )}
          {modal.type === "destination" && (
            <>
              <Field orientation="horizontal">
                <Checkbox
                  checked={pinned}
                  disabled={busy}
                  id="thread-pinned"
                  onCheckedChange={(value) => setPinned(value === true)}
                />
                <FieldContent>
                  <FieldLabel htmlFor="thread-pinned">Pin thread</FieldLabel>
                  <FieldDescription>
                    Show this thread as an icon at the top of the sidebar.
                  </FieldDescription>
                </FieldContent>
              </Field>
              <DestinationIconPicker
                disabled={busy}
                onChange={setDestinationIcon}
                value={destinationIcon}
              />
            </>
          )}
          {(modal.type === "destination" || (modal.type === "drop" && destinationId === "new")) && (
            <Field data-invalid={Boolean(error)}>
              <FieldLabel htmlFor="destination-path">Download folder</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  disabled={busy}
                  {...pathField.props}
                  aria-invalid={Boolean(pathField.errors)}
                  id="destination-path"
                  onChange={(event) => setPath(event.target.value)}
                  required
                  value={path}
                />
                {data.session.mode === "desktop" && (
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton disabled={busy} onClick={() => void browse()} type="button">
                      <FolderIcon />
                      Browse
                    </InputGroupButton>
                  </InputGroupAddon>
                )}
              </InputGroup>
              <FieldDescription>
                {offerMove && moveFiles
                  ? "Downloads in this tab will use the new folder."
                  : "This folder applies to future additions. Existing files stay in their current location."}
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
                  <FieldLabel htmlFor="move-files">Move downloaded files</FieldLabel>
                  <FieldDescription>
                    {existingTorrents.length} torrent{existingTorrents.length > 1 ? "s" : ""} in
                    this tab. Transfers will stop during the move and then resume; paused torrents
                    will remain paused.
                  </FieldDescription>
                </FieldContent>
              </Field>
              {busy === false && moveFiles === true && checkingTorrent !== undefined && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {checkingTorrent.name} is undergoing{" "}
                    {checkingTorrent.status === "checking" ? "verification" : "move"}. Wait for
                    completion before moving its files.
                  </AlertDescription>
                </Alert>
              )}
              {busy === true && moveFiles === true && (
                <FieldDescription role="status">
                  Moving files. This may take some time depending on their size.
                </FieldDescription>
              )}
            </>
          )}
          {modal.type === "trackers" && (
            <Field>
              <FieldLabel htmlFor="tracker-urls">Trackers · one URL per line</FieldLabel>
              <Textarea
                {...trackersField.props}
                aria-invalid={Boolean(trackersField.errors)}
                id="tracker-urls"
                onChange={(event) => setTrackers(event.target.value)}
                rows={8}
                spellCheck={false}
                value={trackers}
              />
              <FieldDescription>HTTP, HTTPS, UDP, WS, and WSS protocols.</FieldDescription>
            </Field>
          )}
          {modal.type === "peer" && (
            <Field>
              <FieldLabel htmlFor="peer-address">IP address or host and port</FieldLabel>
              <Input
                {...sourceField.props}
                aria-invalid={Boolean(sourceField.errors)}
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
                Remove <strong>{modal.torrent.name}</strong> from Tofu?
              </p>
              <Field orientation="horizontal">
                <Checkbox
                  checked={removeFiles}
                  disabled={busy}
                  id="remove-files"
                  onCheckedChange={(value) => setRemoveFiles(value === true)}
                />
                <FieldLabel htmlFor="remove-files">Also delete downloaded files</FieldLabel>
              </Field>
              {removeFiles === true && (
                <Alert variant="destructive">
                  <AlertDescription>Deleting these files is permanent.</AlertDescription>
                </Alert>
              )}
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
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            {submitButton}
          </AlertDialogFooter>
        ) : (
          <DialogFooter className="mt-6">
            {modal.type === "destination" && modal.destination && data.destinations.length > 1 && (
              <Button
                className="sm:mr-auto"
                disabled={busy}
                onClick={() => setDeletingDestination(true)}
                type="button"
                variant="destructive"
              >
                <Trash2Icon data-icon="inline-start" />
                Delete tab
              </Button>
            )}
            <Button disabled={busy} onClick={close} type="button" variant="outline">
              Cancel
            </Button>
            {submitButton}
          </DialogFooter>
        )}
      </Form>
    </ModalFrame>
  );
}
