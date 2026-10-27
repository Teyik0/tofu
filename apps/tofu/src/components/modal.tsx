import { Form, type FormStore, getDeepError, useField, useForm } from "@formisch/react";
import { useMutation } from "@teyik0/furin/client";
import { useAtomValue } from "jotai";
import { FolderIcon, LinkIcon, LoaderCircleIcon, Trash2Icon } from "lucide-react";
import { type ComponentProps, type ReactNode, useState } from "react";
import type {
  Destination,
  DestinationInput,
} from "../../../../package/plugins/src/destination-model";
import { bytes } from "../../../../package/ui/src/format";
import { Alert, AlertDescription } from "../../../../package/ui/src/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../../package/ui/src/ui/alert-dialog";
import { Button } from "../../../../package/ui/src/ui/button";
import { Checkbox } from "../../../../package/ui/src/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../package/ui/src/ui/dialog";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../../../../package/ui/src/ui/field";
import { Input } from "../../../../package/ui/src/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "../../../../package/ui/src/ui/input-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../../package/ui/src/ui/select";
import { Textarea } from "../../../../package/ui/src/ui/textarea";
import { useAsyncAction } from "../../../../package/ui/src/use-async-action";
import type {
  LibraryTorrent,
  LibraryTorrentDetail,
  LiveState,
} from "../api/modules/dashboard/projection";
import type { OpenedTorrent } from "../api/modules/desktop/opening";
import {
  addTorrentFormSchema,
  destinationFormSchema,
  dropTorrentFormSchema,
  locateTorrentSchema,
  openTorrentFormSchema,
  peerFormSchema,
  removeTorrentFormSchema,
  trackersFormSchema,
} from "../api/modules/torrents/model";
import { api } from "../lib/client";
import { errorMessage } from "../lib/errors";
import { playSoundCue } from "../lib/sound-cues";
import { sessionAtom } from "../state/workspace";
import { BoundedDestination } from "./connections/storage-locations";
import { DestinationIconPicker } from "./destination-icon";
import { TorrentFileInput } from "./torrent-file-input";

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
  data: LiveState;
  destination: Destination;
  cancel: () => void;
  close: () => void;
  done: (id: string | null, destinationId: string | null) => Promise<void>;
}) {
  const deleteDestination = useDeleteDestination(activeDestination);
  const { busy, error, run } = useAsyncAction("Unable to delete the tab");
  const fallback = data.destinations.find((item) =>
    destination.id === "default" ? item.id !== "default" : item.id === "default"
  );
  const remove = () =>
    run(async () => {
      await done(null, await deleteDestination(destination.id));
      close();
    });
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

type ModalSchema =
  | typeof addTorrentFormSchema
  | typeof dropTorrentFormSchema
  | typeof openTorrentFormSchema
  | typeof destinationFormSchema
  | typeof trackersFormSchema
  | typeof peerFormSchema
  | typeof locateTorrentSchema
  | typeof removeTorrentFormSchema;

interface ModalProps {
  activeDestination: string | null;
  close: () => void;
  data: LiveState;
  done: (id: string | null, destinationId: string | null) => Promise<void>;
  modal: FormModalKind;
}
type OperationProps<Kind extends FormModalKind["type"]> = Omit<ModalProps, "modal"> & {
  modal: Extract<FormModalKind, { type: Kind }>;
};

function useModalSubmission(done: ModalProps["done"], close: () => void) {
  const { error, run, setError } = useAsyncAction("An error occurred");
  const submit = (task: () => Promise<{ id: string | null; destinationId: string | null }>) => () =>
    run(async () => {
      const result = await task();
      await done(result.id, result.destinationId);
      close();
    });
  return { error, setError, submit };
}

function ModalForm<Schema extends ModalSchema>({
  form,
  error,
  title,
  description,
  close,
  submit,
  label,
  pendingLabel,
  variant,
  className,
  children,
  footer,
}: {
  form: FormStore<Schema>;
  error: string | null;
  title: string;
  description: string;
  close: () => void;
  submit: () => Promise<void>;
  label: string;
  pendingLabel?: string;
  variant: "default" | "destructive";
  className?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const busy = form.isSubmitting;
  const failure = getDeepError(form) ?? error;
  const submitLabel = busy ? (pendingLabel ?? "One moment…") : label;
  const button = (
    <Button disabled={busy} type="submit" variant={variant}>
      {busy ? <LoaderCircleIcon className="animate-spin" data-icon="inline-start" /> : null}
      {submitLabel}
    </Button>
  );
  return (
    <ModalFrame
      close={() => {
        if (!busy) {
          close();
        }
      }}
      description={description}
      remove={variant === "destructive"}
      title={title}
    >
      <Form className={className} of={form} onSubmit={submit}>
        <FieldGroup>
          {children}
          {failure ? (
            <Alert variant="destructive">
              <AlertDescription>{failure}</AlertDescription>
            </Alert>
          ) : null}
        </FieldGroup>
        {variant === "destructive" ? (
          <AlertDialogFooter className="mt-6">
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            {button}
          </AlertDialogFooter>
        ) : (
          <DialogFooter className="mt-6">
            {footer}
            <Button disabled={busy} onClick={close} type="button" variant="outline">
              Cancel
            </Button>
            {button}
          </DialogFooter>
        )}
      </Form>
    </ModalFrame>
  );
}

function DestinationPicker({
  id,
  value,
  options,
  disabled,
  onChange,
  path,
}: {
  id: string;
  value: string;
  options: { id: string; name: string }[];
  disabled: boolean;
  onChange: (value: string) => void;
  path: string | undefined;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>Destination tab</FieldLabel>
      <Select
        disabled={disabled}
        items={options.map((item) => ({ label: item.name, value: item.id }))}
        onValueChange={(next) => {
          if (next !== null) {
            onChange(next);
          }
        }}
        value={value}
      >
        <SelectTrigger className="w-full" id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent alignItemWithTrigger={false}>
          <SelectGroup>
            {options.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {value === "new" ? null : (
        <FieldDescription className="destination-path">{path}</FieldDescription>
      )}
    </Field>
  );
}

function DestinationFields({
  name,
  path,
  nameProps,
  pathProps,
  nameInvalid,
  pathInvalid,
  busy,
  hostNative,
  onName,
  onPath,
  onError,
  description,
  children,
}: {
  name: string;
  path: string;
  nameProps: ComponentProps<typeof Input>;
  pathProps: ComponentProps<typeof InputGroupInput>;
  nameInvalid: boolean;
  pathInvalid: boolean;
  busy: boolean;
  /** The host's own window can browse folders with its native dialog. */
  hostNative: boolean;
  onName: (value: string) => void;
  onPath: (value: string) => void;
  onError: (message: string) => void;
  description: string;
  children?: ReactNode;
}) {
  const directory = useMutation(api.directory.post);
  const browse = async () => {
    try {
      const result = await directory.mutateAsync();
      if (result && "path" in result && result.path) {
        onPath(result.path);
      }
    } catch (cause) {
      onError(errorMessage(cause, "Unable to open the folder"));
    }
  };
  return (
    <>
      <Field data-invalid={nameInvalid}>
        <FieldLabel htmlFor="destination-name">Tab name</FieldLabel>
        <Input
          disabled={busy}
          {...nameProps}
          aria-invalid={nameInvalid}
          id="destination-name"
          maxLength={80}
          onChange={(event) => onName(event.target.value)}
          required
          value={name}
        />
      </Field>
      {children}
      <Field data-invalid={pathInvalid}>
        <FieldLabel htmlFor="destination-path">Download folder</FieldLabel>
        <InputGroup>
          <InputGroupInput
            disabled={busy}
            {...pathProps}
            aria-invalid={pathInvalid}
            id="destination-path"
            onChange={(event) => onPath(event.target.value)}
            required
            value={path}
          />
          {hostNative ? (
            <InputGroupAddon align="inline-end">
              <InputGroupButton disabled={busy} onClick={() => void browse()} type="button">
                <FolderIcon />
                Browse
              </InputGroupButton>
            </InputGroupAddon>
          ) : null}
        </InputGroup>
        <FieldDescription>{description}</FieldDescription>
      </Field>
    </>
  );
}

const futureFolderDescription =
  "This folder applies to future additions. Existing files stay in their current location.";

function AddTorrentModal({ modal, data, close, done }: OperationProps<"add">) {
  const upload = useMutation(api.torrents.file.post);
  const addTorrent = useMutation(api.torrents.post);
  const submission = useModalSubmission(done, close);
  const form = useForm({
    initialInput: {
      destinationId:
        data.destinations.find((item) => item.id === modal.destinationId)?.id ?? "default",
      file: null,
      paused: false,
      source: "",
      trackers: "",
    },
    schema: addTorrentFormSchema,
  });
  const destinationField = useField(form, { path: ["destinationId"] });
  const fileField = useField(form, { path: ["file"] });
  const sourceField = useField(form, { path: ["source"] });
  const pausedField = useField(form, { path: ["paused"] });
  const trackersField = useField(form, { path: ["trackers"] });
  const busy = form.isSubmitting;
  const file = fileField.input ?? null;
  const destinationId = destinationField.input ?? "default";
  const submit = submission.submit(async () => {
    const result = file
      ? await upload.mutateAsync({
          destinationId,
          file,
          paused: pausedField.input ? "true" : "false",
          trackers: trackersField.input ?? "",
        })
      : await addTorrent.mutateAsync({
          destinationId,
          paused: pausedField.input === true,
          source: sourceField.input?.trim() ?? "",
          trackers: trackerLines(trackersField.input ?? ""),
        });
    if (!(result && "id" in result)) {
      throw new Error("Unable to add the torrent");
    }
    playSoundCue("added");
    return { destinationId, id: result.id };
  });
  return (
    <ModalForm
      className="torrent-add-form"
      close={close}
      description="Drop a file or paste a link to get started."
      error={submission.error}
      form={form}
      label="Add torrent"
      submit={submit}
      title="Add a torrent"
      variant="default"
    >
      <TorrentFileInput
        disabled={busy}
        file={file}
        onChange={(next) => {
          fileField.onChange(next);
          if (next) {
            sourceField.onChange("");
          }
        }}
        onError={submission.setError}
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
            onChange={(event) => sourceField.onChange(event.target.value)}
            placeholder="Paste a magnet link or https://…"
            required={!file}
            spellCheck={false}
            value={sourceField.input ?? ""}
          />
        </InputGroup>
      </Field>
      <DestinationPicker
        disabled={busy}
        id="torrent-destination"
        onChange={destinationField.onChange}
        options={data.destinations}
        path={data.host?.destinations.find((item) => item.id === destinationId)?.downloadPath}
        value={destinationId}
      />
      <details className="torrent-add-options">
        <summary>Additional trackers</summary>
        <Field className="mt-3">
          <FieldLabel htmlFor="extra-trackers">One URL per line</FieldLabel>
          <Textarea
            {...trackersField.props}
            aria-invalid={Boolean(trackersField.errors)}
            id="extra-trackers"
            onChange={(event) => trackersField.onChange(event.target.value)}
            rows={3}
            value={trackersField.input ?? ""}
          />
        </Field>
      </details>
      <Field orientation="horizontal">
        <Checkbox
          checked={pausedField.input === true}
          disabled={busy}
          id="torrent-paused"
          onCheckedChange={(value) => pausedField.onChange(value === true)}
        />
        <FieldLabel htmlFor="torrent-paused">Add paused</FieldLabel>
      </Field>
    </ModalForm>
  );
}

function OpenTorrentModal({ modal, data, close, done }: OperationProps<"open">) {
  const { torrent } = modal;
  const accept = useMutation(
    (body: { destinationId: string; paused: boolean; trackers: string[] }) =>
      api.desktop.openings({ id: torrent.id }).post(body)
  );
  const dismiss = useMutation(() => api.desktop.openings({ id: torrent.id }).delete());
  const submission = useModalSubmission(done, close);
  const form = useForm({
    initialInput: {
      destinationId:
        data.destinations.find((item) => item.id === torrent.destinationId)?.id ?? "default",
      paused: false,
      trackers: "",
    },
    schema: openTorrentFormSchema,
  });
  const destinationField = useField(form, { path: ["destinationId"] });
  const pausedField = useField(form, { path: ["paused"] });
  const trackersField = useField(form, { path: ["trackers"] });
  const busy = form.isSubmitting;
  const destinationId = destinationField.input ?? "default";
  const submit = submission.submit(async () => {
    const result = await accept.mutateAsync({
      destinationId,
      paused: pausedField.input === true,
      trackers: trackerLines(trackersField.input ?? ""),
    });
    if (!(result && "id" in result)) {
      throw new Error("Unable to add the torrent");
    }
    playSoundCue("added");
    return { destinationId, id: result.id };
  });
  const cancel = async () => {
    close();
    try {
      await dismiss.mutateAsync();
    } catch {
      // The torrent was already added or dismissed from another window.
    }
  };
  const details = [
    torrent.length === null ? null : bytes(torrent.length),
    torrent.fileCount === null
      ? null
      : `${torrent.fileCount} file${torrent.fileCount > 1 ? "s" : ""}`,
  ].filter(Boolean);
  return (
    <ModalForm
      className="torrent-add-form"
      close={() => void cancel()}
      description="Choose where to download this torrent."
      error={submission.error}
      form={form}
      label="Download"
      submit={submit}
      title="Add a torrent"
      variant="default"
    >
      <Field>
        <FieldLabel>Torrent</FieldLabel>
        <p className="break-all font-medium">{torrent.name}</p>
        <FieldDescription>
          {details.length ? details.join(" · ") : "Details appear once the metadata is received."}
        </FieldDescription>
      </Field>
      <DestinationPicker
        disabled={busy}
        id="opened-torrent-destination"
        onChange={destinationField.onChange}
        options={data.destinations}
        path={data.host?.destinations.find((item) => item.id === destinationId)?.downloadPath}
        value={destinationId}
      />
      <details className="torrent-add-options">
        <summary>Additional trackers</summary>
        <Field className="mt-3">
          <FieldLabel htmlFor="opened-torrent-trackers">One URL per line</FieldLabel>
          <Textarea
            {...trackersField.props}
            aria-invalid={Boolean(trackersField.errors)}
            id="opened-torrent-trackers"
            onChange={(event) => trackersField.onChange(event.target.value)}
            rows={3}
            value={trackersField.input ?? ""}
          />
        </Field>
      </details>
      <Field orientation="horizontal">
        <Checkbox
          checked={pausedField.input === true}
          disabled={busy}
          id="opened-torrent-paused"
          onCheckedChange={(value) => pausedField.onChange(value === true)}
        />
        <FieldLabel htmlFor="opened-torrent-paused">Add paused</FieldLabel>
      </Field>
    </ModalForm>
  );
}

function DropTorrentModal({ modal, data, close, done }: OperationProps<"drop">) {
  const hostNative = useAtomValue(sessionAtom)?.capabilities.hostNative === true;
  const upload = useMutation(api.torrents.file.post);
  const createDestination = useMutation(api.destinations.post);
  const submission = useModalSubmission(done, close);
  const [files, setFiles] = useState(modal.files);
  const form = useForm({
    initialInput: {
      destinationId: "default",
      name: "",
      path: data.host?.settings.downloadPath ?? "",
    },
    schema: dropTorrentFormSchema,
  });
  const destination = useField(form, { path: ["destinationId"] });
  const name = useField(form, { path: ["name"] });
  const path = useField(form, { path: ["path"] });
  const busy = form.isSubmitting;
  const destinationId = destination.input ?? "default";
  const submit = submission.submit(async () => {
    let target = destinationId;
    if (target === "new") {
      const created = await createDestination.mutateAsync({
        downloadPath: path.input ?? "",
        name: name.input ?? "",
      });
      if (!(created && "id" in created)) {
        throw new Error("Unable to create the tab");
      }
      target = created.id;
      destination.onChange(target);
    }
    let selected: string | null = null;
    for (const file of files) {
      // biome-ignore lint/performance/noAwaitInLoops: Keep order and retry only files that have not been added.
      const result = await upload.mutateAsync({ destinationId: target, file, paused: "false" });
      if (!(result && "id" in result)) {
        throw new Error("Unable to add the torrent");
      }
      selected = result.id;
      setFiles((remaining) => remaining.filter((item) => item !== file));
    }
    playSoundCue("added");
    return { destinationId: target, id: selected };
  });
  return (
    <ModalForm
      close={close}
      description="Torrents will start immediately in the selected folder."
      error={submission.error}
      form={form}
      label="Download"
      submit={submit}
      title="Choose destination"
      variant="default"
    >
      <FieldDescription>{files.map((file) => file.name).join(", ")}</FieldDescription>
      <DestinationPicker
        disabled={busy}
        id="drop-destination"
        onChange={destination.onChange}
        options={
          data.host
            ? [...data.destinations, { id: "new", name: "Create a new tab…" }]
            : data.destinations
        }
        path={
          data.host?.destinations.find((item) => item.id === destinationId)?.downloadPath ??
          (data.host ? path.input : undefined)
        }
        value={destinationId}
      />
      {destinationId === "new" ? (
        <DestinationFields
          busy={busy}
          description={futureFolderDescription}
          hostNative={hostNative}
          name={name.input ?? ""}
          nameInvalid={Boolean(name.errors)}
          nameProps={name.props}
          onError={submission.setError}
          onName={name.onChange}
          onPath={path.onChange}
          path={path.input ?? ""}
          pathInvalid={Boolean(path.errors)}
          pathProps={path.props}
        />
      ) : null}
    </ModalForm>
  );
}

function useDestinationForm({
  modal,
  data,
  close,
  done,
}: Pick<OperationProps<"destination">, "modal" | "data" | "close" | "done">) {
  const create = useMutation(api.destinations.post);
  const update = useMutation((id: string, body: DestinationInput) =>
    api.destinations({ id }).put(body)
  );
  const submission = useModalSubmission(done, close);
  const { destination } = modal;
  let deleteTorrentFile: "inherit" | "always" | "never" = "inherit";
  if (destination?.deleteTorrentFileAfterAdd === true) {
    deleteTorrentFile = "always";
  } else if (destination?.deleteTorrentFileAfterAdd === false) {
    deleteTorrentFile = "never";
  }
  const form = useForm({
    initialInput: {
      autoAddTorrentFiles: destination ? destination.autoAddTorrentFilesSince !== null : false,
      deleteTorrentFile,
      destinationIcon: destination?.icon ?? "folder",
      moveFiles: false,
      name: destination?.name ?? "",
      path: destination?.downloadPath ?? data.host?.settings.downloadPath ?? "",
      pinned: destination?.pinned ?? false,
    },
    schema: destinationFormSchema,
  });
  const name = useField(form, { path: ["name"] });
  const path = useField(form, { path: ["path"] });
  const icon = useField(form, { path: ["destinationIcon"] });
  const pinned = useField(form, { path: ["pinned"] });
  const move = useField(form, { path: ["moveFiles"] });
  const autoAdd = useField(form, { path: ["autoAddTorrentFiles"] });
  const deleteFile = useField(form, { path: ["deleteTorrentFile"] });
  const [deleting, setDeleting] = useState(false);
  const existing = destination
    ? data.torrents.filter((torrent) => torrent.destinationId === destination.id)
    : [];
  const offerMove = Boolean(
    destination && path.input !== destination.downloadPath && existing.length
  );
  const checking = existing.find(
    (torrent) => torrent.status === "checking" || torrent.status === "moving"
  );
  const busy = form.isSubmitting;
  const submit = submission.submit(async () => {
    const body: DestinationInput = {
      autoAddTorrentFiles: autoAdd.input === true,
      deleteTorrentFileAfterAdd:
        deleteFile.input === "inherit" || deleteFile.input === undefined
          ? null
          : deleteFile.input === "always",
      downloadPath: path.input ?? "",
      icon: icon.input ?? "folder",
      moveFiles: offerMove && move.input === true,
      name: name.input ?? "",
      pinned: pinned.input === true,
    };
    const result = destination
      ? await update.mutateAsync(destination.id, body)
      : await create.mutateAsync(body);
    if (!(result && "id" in result)) {
      throw new Error("Unable to save the tab");
    }
    return { destinationId: result.id, id: null };
  });
  return {
    autoAdd,
    busy,
    checking,
    deleteFile,
    deleting,
    destination,
    existing,
    form,
    icon,
    move,
    name,
    offerMove,
    path,
    pinned,
    setDeleting,
    submission,
    submit,
  };
}

function DestinationModal(props: Parameters<typeof OwnerDestinationModal>[0]) {
  const session = useAtomValue(sessionAtom);
  return session?.capabilities.owner ? (
    <OwnerDestinationModal {...props} />
  ) : (
    <BoundedDestination
      close={props.close}
      destination={props.modal.destination}
      done={props.done}
    />
  );
}

function OwnerDestinationModal({
  activeDestination,
  modal,
  data,
  close,
  done,
}: OperationProps<"destination">) {
  const hostNative = useAtomValue(sessionAtom)?.capabilities.hostNative === true;
  const model = useDestinationForm({ close, data, done, modal });
  const {
    submission,
    destination,
    form,
    name,
    path,
    icon,
    pinned,
    move,
    deleting,
    setDeleting,
    offerMove,
    busy,
    submit,
  } = model;
  if (deleting && destination) {
    return (
      <DeleteDestinationModal
        activeDestination={activeDestination}
        cancel={() => setDeleting(false)}
        close={close}
        data={data}
        destination={destination}
        done={done}
      />
    );
  }
  return (
    <ModalForm
      close={close}
      description="One tab, one folder. Multiple tabs can use the same folder."
      error={submission.error}
      footer={
        destination && data.destinations.length > 1 ? (
          <Button
            className="sm:mr-auto"
            disabled={busy}
            onClick={() => setDeleting(true)}
            type="button"
            variant="destructive"
          >
            <Trash2Icon data-icon="inline-start" />
            Delete tab
          </Button>
        ) : null
      }
      form={form}
      label={destination ? "Save" : "Create tab"}
      pendingLabel={offerMove && move.input ? "Moving files…" : undefined}
      submit={submit}
      title={destination ? "Edit tab" : "Create a tab"}
      variant="default"
    >
      <DestinationFields
        busy={busy}
        description={
          offerMove && move.input
            ? "Downloads in this tab will use the new folder."
            : futureFolderDescription
        }
        hostNative={hostNative}
        name={name.input ?? ""}
        nameInvalid={Boolean(name.errors)}
        nameProps={name.props}
        onError={submission.setError}
        onName={name.onChange}
        onPath={path.onChange}
        path={path.input ?? ""}
        pathInvalid={Boolean(path.errors)}
        pathProps={path.props}
      >
        <Field orientation="horizontal">
          <Checkbox
            checked={pinned.input === true}
            disabled={busy}
            id="thread-pinned"
            onCheckedChange={(value) => pinned.onChange(value === true)}
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
          onChange={icon.onChange}
          value={icon.input ?? "folder"}
        />
      </DestinationFields>
      <DestinationTorrentFileOptions data={data} model={model} />
      <DestinationMoveOptions model={model} />
    </ModalForm>
  );
}

function trackerLines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function TrackersModal({ modal, data, close, done }: OperationProps<"trackers">) {
  const update = useMutation((urls: string[]) =>
    api.torrents({ id: modal.torrent.id }).trackers.put({ urls })
  );
  const submission = useModalSubmission(done, close);
  const form = useForm({
    initialInput: {
      trackers: (data.detailHost?.id === modal.torrent.id ? data.detailHost.trackers : [])
        .map((item) => item.url)
        .join("\n"),
    },
    schema: trackersFormSchema,
  });
  const field = useField(form, { path: ["trackers"] });
  const submit = submission.submit(async () => {
    await update.mutateAsync(trackerLines(field.input ?? ""));
    return { destinationId: null, id: null };
  });
  return (
    <ModalForm
      close={close}
      description="Add, edit, or remove URLs. Downloaded files are preserved."
      error={submission.error}
      form={form}
      label="Save"
      submit={submit}
      title="Manage trackers"
      variant="default"
    >
      <Field>
        <FieldLabel htmlFor="tracker-urls">Trackers · one URL per line</FieldLabel>
        <Textarea
          {...field.props}
          aria-invalid={Boolean(field.errors)}
          id="tracker-urls"
          onChange={(event) => field.onChange(event.target.value)}
          rows={8}
          spellCheck={false}
          value={field.input ?? ""}
        />
        <FieldDescription>HTTP, HTTPS, UDP, WS, and WSS protocols.</FieldDescription>
      </Field>
    </ModalForm>
  );
}

function PeerModal({ modal, close, done }: OperationProps<"peer">) {
  const add = useMutation((peer: string) =>
    api.torrents({ id: modal.torrent.id }).peers.post({ peer })
  );
  const submission = useModalSubmission(done, close);
  const form = useForm({ initialInput: { source: "" }, schema: peerFormSchema });
  const field = useField(form, { path: ["source"] });
  const submit = submission.submit(async () => {
    await add.mutateAsync(field.input?.trim() ?? "");
    return { destinationId: null, id: null };
  });
  return (
    <ModalForm
      close={close}
      description="Connect directly to a known peer."
      error={submission.error}
      form={form}
      label="Save"
      submit={submit}
      title="Add a peer"
      variant="default"
    >
      <Field>
        <FieldLabel htmlFor="peer-address">IP address or host and port</FieldLabel>
        <Input
          {...field.props}
          aria-invalid={Boolean(field.errors)}
          id="peer-address"
          onChange={(event) => field.onChange(event.target.value)}
          placeholder="192.168.1.10:51413"
          required
          value={field.input ?? ""}
        />
      </Field>
    </ModalForm>
  );
}

function RemoveTorrentModal({ modal, close, done }: OperationProps<"remove">) {
  const remove = useMutation((deleteFiles: boolean) =>
    api.torrents({ id: modal.torrent.id }).delete({ deleteFiles })
  );
  const submission = useModalSubmission(done, close);
  const form = useForm({ initialInput: { removeFiles: false }, schema: removeTorrentFormSchema });
  const field = useField(form, { path: ["removeFiles"] });
  const submit = submission.submit(async () => {
    await remove.mutateAsync(field.input === true);
    playSoundCue("removed");
    return { destinationId: null, id: null };
  });
  return (
    <ModalForm
      close={close}
      description="Files remain on disk unless you choose to delete them."
      error={submission.error}
      form={form}
      label="Remove"
      submit={submit}
      title="Remove torrent"
      variant="destructive"
    >
      <p>
        Remove <strong>{modal.torrent.name}</strong> from Tofu?
      </p>
      <Field orientation="horizontal">
        <Checkbox
          checked={field.input === true}
          disabled={form.isSubmitting}
          id="remove-files"
          onCheckedChange={(value) => field.onChange(value === true)}
        />
        <FieldLabel htmlFor="remove-files">Also delete downloaded files</FieldLabel>
      </Field>
      {field.input ? (
        <Alert variant="destructive">
          <AlertDescription>Deleting these files is permanent.</AlertDescription>
        </Alert>
      ) : null}
    </ModalForm>
  );
}

export function Modal(props: ModalProps) {
  switch (props.modal.type) {
    case "add":
      return <AddTorrentModal {...props} modal={props.modal} />;
    case "drop":
      return <DropTorrentModal {...props} modal={props.modal} />;
    case "open":
      return <OpenTorrentModal {...props} modal={props.modal} />;
    case "destination":
      return <DestinationModal {...props} modal={props.modal} />;
    case "trackers":
      return <TrackersModal {...props} modal={props.modal} />;
    case "peer":
      return <PeerModal {...props} modal={props.modal} />;
    case "locate":
      return <LocateTorrentModal {...props} modal={props.modal} />;
    case "remove":
      return <RemoveTorrentModal {...props} modal={props.modal} />;
    default:
      return null;
  }
}

function LocateTorrentModal({ modal, data, close, done }: OperationProps<"locate">) {
  const hostNative = useAtomValue(sessionAtom)?.capabilities.hostNative === true;
  const locate = useMutation((downloadPath: string) =>
    api.torrents({ id: modal.torrent.id }).locate.post({ downloadPath })
  );
  const directory = useMutation(api.directory.post);
  const submission = useModalSubmission(done, close);
  const form = useForm({
    initialInput: {
      downloadPath: data.detailHost?.id === modal.torrent.id ? data.detailHost.savePath : "",
    },
    schema: locateTorrentSchema,
  });
  const field = useField(form, { path: ["downloadPath"] });
  const submit = submission.submit(async () => {
    await locate.mutateAsync(field.input?.trim() ?? "");
    return { destinationId: null, id: modal.torrent.id };
  });
  const browse = async () => {
    try {
      const result = await directory.mutateAsync();
      if (result && "path" in result && result.path) {
        field.onChange(result.path);
      }
    } catch (cause) {
      submission.setError(errorMessage(cause, "Unable to open the folder"));
    }
  };
  return (
    <ModalForm
      close={close}
      description="Choose the existing folder containing this torrent's files. Tofu verifies the data without moving files. Missing or invalid pieces require an explicit repair."
      error={submission.error}
      form={form}
      label="Verify folder"
      pendingLabel="Verifying…"
      submit={submit}
      title="Locate files"
      variant="default"
    >
      <Field data-invalid={Boolean(field.errors)}>
        <FieldLabel htmlFor="locate-folder">Folder containing torrent files</FieldLabel>
        <InputGroup>
          <InputGroupInput
            {...field.props}
            aria-invalid={Boolean(field.errors)}
            disabled={form.isSubmitting}
            id="locate-folder"
            onChange={(event) => field.onChange(event.target.value)}
            required
            value={field.input ?? ""}
          />
          {hostNative && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                aria-label="Browse for torrent files"
                disabled={form.isSubmitting}
                onClick={() => void browse()}
                type="button"
                variant="ghost"
              >
                <FolderIcon />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <FieldDescription>
          Keep the paths declared by the torrent inside this folder, such as{" "}
          {data.detailHost?.files[0]?.path ?? "the original file name"}.
        </FieldDescription>
      </Field>
    </ModalForm>
  );
}

function DestinationTorrentFileOptions({
  data,
  model,
}: {
  data: LiveState;
  model: ReturnType<typeof useDestinationForm>;
}) {
  const { autoAdd, deleteFile, busy } = model;
  const global = data.host?.settings.deleteTorrentFileAfterAdd ? "delete" : "keep";
  const items = [
    { label: `Use the global setting (${global})`, value: "inherit" },
    { label: "Always delete", value: "always" },
    { label: "Always keep", value: "never" },
  ];
  return (
    <>
      <Field orientation="horizontal">
        <Checkbox
          checked={autoAdd.input === true}
          disabled={busy}
          id="thread-auto-add"
          onCheckedChange={(value) => autoAdd.onChange(value === true)}
        />
        <FieldContent>
          <FieldLabel htmlFor="thread-auto-add">Add .torrent files from this folder</FieldLabel>
          <FieldDescription>
            New .torrent files saved in the download folder start downloading in this thread.
          </FieldDescription>
        </FieldContent>
      </Field>
      <Field>
        <FieldLabel htmlFor="thread-delete-torrent-file">.torrent file after adding</FieldLabel>
        <Select
          disabled={busy}
          items={items}
          onValueChange={(next) => {
            if (next === "inherit" || next === "always" || next === "never") {
              deleteFile.onChange(next);
            }
          }}
          value={deleteFile.input ?? "inherit"}
        >
          <SelectTrigger className="w-full" id="thread-delete-torrent-file">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectGroup>
              {items.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <FieldDescription>
          Applies to files opened from your file manager or added from this folder.
        </FieldDescription>
      </Field>
    </>
  );
}

function DestinationMoveOptions({ model }: { model: ReturnType<typeof useDestinationForm> }) {
  const { offerMove, move, busy, existing, checking } = model;
  return offerMove ? (
    <>
      <Field orientation="horizontal">
        <Checkbox
          checked={move.input === true}
          disabled={busy}
          id="move-files"
          onCheckedChange={(value) => move.onChange(value === true)}
        />
        <FieldContent>
          <FieldLabel htmlFor="move-files">Move downloaded files</FieldLabel>
          <FieldDescription>
            {existing.length} torrent{existing.length > 1 ? "s" : ""} in this tab. Transfers will
            stop during the move and then resume; paused torrents will remain paused.
          </FieldDescription>
        </FieldContent>
      </Field>
      {!busy && move.input && checking ? (
        <Alert variant="destructive">
          <AlertDescription>
            {checking.name} is undergoing {checking.status === "checking" ? "verification" : "move"}
            . Wait for completion before moving its files.
          </AlertDescription>
        </Alert>
      ) : null}
      {busy && move.input ? (
        <FieldDescription role="status">
          Moving files. This may take some time depending on their size.
        </FieldDescription>
      ) : null}
    </>
  ) : null;
}

export type FormModalKind =
  | { type: "add"; destinationId: string }
  | { type: "drop"; files: File[] }
  | { type: "open"; torrent: OpenedTorrent }
  | { type: "destination"; destination: Destination | null }
  | { type: "remove"; torrent: LibraryTorrent }
  | { type: "trackers"; torrent: LibraryTorrentDetail }
  | { type: "locate"; torrent: LibraryTorrentDetail }
  | { type: "peer"; torrent: LibraryTorrentDetail };
