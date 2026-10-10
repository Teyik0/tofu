import { EdenFetchError } from "@elysia/eden";
import { useMutation } from "@teyik0/furin/client";
import { useSetAtom } from "jotai";
import { DownloadIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { api } from "../lib/client";
import { useRefresh } from "../lib/navigation";
import { modalAtom, selectedTorrentAtom } from "../state/workspace";
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";

export function TorrentDrop({ activeDestination }: { activeDestination: string | null }) {
  const open = useSetAtom(modalAtom);
  const setSelected = useSetAtom(selectedTorrentAtom);
  const refresh = useRefresh();
  const upload = useMutation(api.torrents.file.post);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const depth = useRef(0);
  const dropped = useEffectEvent(async (files: File[]) => {
    setError(null);
    if (activeDestination === null) {
      open({ files, type: "drop" });
      return;
    }
    try {
      for (const file of files) {
        // biome-ignore lint/performance/noAwaitInLoops: add in order and stop on the first failed file.
        const result = await upload.mutateAsync({
          destinationId: activeDestination,
          file,
          paused: "false",
        });
        if (!(result && "id" in result)) {
          throw new Error("Unable to add the torrent");
        }
        setSelected(result.id);
      }
    } catch (cause) {
      const value: unknown = cause instanceof EdenFetchError ? cause.value : null;
      setError(
        value && typeof value === "object" && "error" in value && typeof value.error === "string"
          ? value.error
          : value &&
              typeof value === "object" &&
              "detail" in value &&
              typeof value.detail === "string"
            ? value.detail
            : cause instanceof Error
              ? cause.message
              : "Unable to add the torrent"
      );
    } finally {
      await refresh();
    }
  });
  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files");
    const modalOpen = () =>
      document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]');
    const enter = (event: DragEvent) => {
      if (hasFiles(event) && !modalOpen()) {
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      }
    };
    const over = (event: DragEvent) => {
      if (hasFiles(event)) {
        event.preventDefault();
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = "copy";
        }
      }
    };
    const leave = (event: DragEvent) => {
      if (hasFiles(event)) {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) {
          setDragging(false);
        }
      }
    };
    const drop = (event: DragEvent) => {
      if (!hasFiles(event)) {
        return;
      }
      event.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (modalOpen()) {
        return;
      }
      const files = Array.from(event.dataTransfer?.files ?? []).filter((file) =>
        file.name.toLowerCase().endsWith(".torrent")
      );
      if (files.length > 0) {
        void dropped(files);
      } else {
        setError("Drop a .torrent file.");
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  return (
    <>
      {dragging === true && (
        <div className="torrent-drop-overlay">
          <DownloadIcon />
          <p>Drop your .torrent files</p>
        </div>
      )}
      {error !== null && (
        <Alert className="torrent-drop-error" variant="destructive">
          <AlertDescription>
            {error}
            <Button onClick={() => setError(null)} size="sm" variant="ghost">
              Close
            </Button>
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
