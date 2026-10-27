import { useEffect, useState } from "react";
import type { Destination } from "../../../../../package/plugins/src/destination-model";
import { OptionSelect } from "../../../../../package/ui/src/option-select";
import { Alert, AlertDescription } from "../../../../../package/ui/src/ui/alert";
import { Button } from "../../../../../package/ui/src/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../../package/ui/src/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "../../../../../package/ui/src/ui/field";
import { Input } from "../../../../../package/ui/src/ui/input";
import { api } from "../../lib/client";
import { errorMessage } from "../../lib/errors";

/** A remote administrator selects an owner-approved root, never an absolute host path. */
export function BoundedDestination({
  destination,
  close,
  done,
}: {
  destination: Destination | null;
  close: () => void;
  done: (id: string | null, destinationId: string | null) => Promise<void>;
}) {
  const [roots, setRoots] = useState<
    NonNullable<Awaited<ReturnType<(typeof api)["storage-roots"]["get"]>>["data"]>
  >([]);
  const [rootId, setRootId] = useState("");
  const [name, setName] = useState(destination?.name ?? "");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let disposed = false;
    const load = async () => {
      const { data, error: failure } = await api["storage-roots"].get();
      if (disposed) {
        return;
      }
      if (failure) {
        setError(errorMessage(failure, "Unable to read the server's storage locations"));
        return;
      }
      setRoots(data);
      setRootId(data[0]?.id ?? "");
    };
    void load();
    return () => {
      disposed = true;
    };
  }, []);
  return (
    <Dialog
      onOpenChange={(open) => {
        if (!(open || busy)) {
          close();
        }
      }}
      open
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{destination ? "Edit thread" : "Create a thread"}</DialogTitle>
          <DialogDescription>
            Choose a storage location approved on the server. Host paths and watched folders are
            configured on the server itself.
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            try {
              const { data, error: failure } = await api.destinations["within-root"].post({
                folder,
                id: destination?.id,
                name,
                rootId,
              });
              if (failure) {
                setError(errorMessage(failure, "Unable to save this thread"));
                return;
              }
              await done(null, data.id);
              close();
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field>
            <FieldLabel htmlFor="bounded-name">Thread name</FieldLabel>
            <Input
              disabled={busy}
              id="bounded-name"
              onChange={(event) => setName(event.target.value)}
              required
              value={name}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="bounded-root">Storage location</FieldLabel>
            <OptionSelect
              disabled={busy}
              id="bounded-root"
              onValueChange={setRootId}
              options={roots.map((root) => ({ label: root.name, value: root.id }))}
              value={rootId}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="bounded-folder">Folder within this location</FieldLabel>
            <Input
              disabled={busy}
              id="bounded-folder"
              onChange={(event) => setFolder(event.target.value)}
              placeholder="Anime / Summer"
              value={folder}
            />
            <FieldDescription>
              Existing files are preserved. Moving existing downloads remains a separate operation.
            </FieldDescription>
          </Field>
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter>
            <Button disabled={busy} onClick={close} type="button" variant="outline">
              Cancel
            </Button>
            <Button disabled={busy || !rootId || !name.trim()} type="submit">
              {busy ? "Saving…" : "Save thread"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
