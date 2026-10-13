import type { AniListEditor, AniListMedia } from "@tofu/plugins/domain";
import { Alert, AlertDescription } from "@tofu/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@tofu/ui/alert-dialog";
import { Button } from "@tofu/ui/button";
import { CheckIcon, LoaderCircleIcon, Trash2Icon } from "lucide-react";
import { AniListListAside, AniListListFields } from "./list-editor-fields";
import { type Action, useAniListListEditor } from "./use-list-editor";

export function AniListListEditor({
  editor,
  media,
  busy,
  action,
  saved,
  removed,
}: {
  editor: AniListEditor;
  media: AniListMedia;
  busy: boolean;
  action: Action;
  saved: () => Promise<AniListEditor>;
  removed: () => Promise<void>;
}) {
  const model = useAniListListEditor({ editor, media, saved });
  const { saveState, confirmDelete, setConfirmDelete, deleteEntry, formRef, autosave, commit } =
    model;
  return (
    <>
      <form
        className="anime-list-editor"
        onSubmit={(event) => {
          event.preventDefault();
          commit();
        }}
        ref={formRef}
      >
        <div className="anime-list-layout">
          <AniListListFields busy={busy} editor={editor} media={media} model={model} />
          <AniListListAside busy={busy} editor={editor} model={model} />
        </div>
        <div
          className="anime-list-actions"
          data-empty={!editor.entry && saveState.status === "idle"}
        >
          {editor.entry ? (
            <Button
              className="anime-list-remove"
              disabled={busy}
              onClick={() => setConfirmDelete(true)}
              size="sm"
              type="button"
              variant="ghost"
            >
              <Trash2Icon data-icon="inline-start" />
              Remove from list
            </Button>
          ) : (
            <span />
          )}
          <p className="anime-save-state" data-status={saveState.status} role="status">
            {saveState.status === "saving" ? (
              <>
                <LoaderCircleIcon aria-hidden="true" className="motion-safe:animate-spin" />
                Saving to AniList…
              </>
            ) : saveState.status === "saved" ? (
              <>
                <CheckIcon aria-hidden="true" />
                Saved to AniList
              </>
            ) : saveState.status === "failed" ? (
              <>
                {saveState.error}
                <Button
                  onClick={() => {
                    commit();
                    void autosave.retry();
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Retry
                </Button>
              </>
            ) : null}
          </p>
        </div>
      </form>
      <AlertDialog onOpenChange={setConfirmDelete} open={confirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {media.title} from your list?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes your AniList entry and stops its Tofu automation. Downloaded files and
              torrents are kept.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() =>
                action(async () => {
                  await deleteEntry.mutateAsync();
                  setConfirmDelete(false);
                  await removed();
                })
              }
              variant="destructive"
            >
              Remove from AniList
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function AniListEditorUnavailable({
  authenticated,
  error,
  retry,
}: {
  authenticated: boolean;
  error: string | null;
  retry: () => void;
}) {
  return (
    <Alert>
      <AlertDescription>
        {authenticated
          ? (error ?? "Unable to load your AniList entry")
          : "Connect your AniList account in Plugins to edit your list and favourites."}
        {authenticated ? (
          <Button onClick={retry} size="sm" variant="outline">
            Retry
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
