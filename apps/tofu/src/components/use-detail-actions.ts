// biome-ignore-all lint/suspicious/noArrayIndexKey: piece-map bins have fixed positions and no component state.
import { useMutation } from "@teyik0/furin/client";
import { useState } from "react";
import type { FilePriority } from "../../../../package/plugins/src/torrent-types";
import type { LibraryTorrentDetail, LiveState } from "../api/modules/dashboard/projection";
import { api } from "../lib/client";
import { errorMessage } from "../lib/errors";
import type { ModalKind } from "../state/workspace";
import { request } from "./api";

export interface DetailActionsProps {
  act: (id: string, task: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  data: LiveState;
  open: (modal: ModalKind) => void;
  torrent: LibraryTorrentDetail;
}

export function useDetailActions({ torrent, data }: Pick<DetailActionsProps, "torrent" | "data">) {
  const endpoint = api.torrents({ id: torrent.id });
  const pause = useMutation(endpoint.pause.post);
  const resume = useMutation(endpoint.resume.post);
  const verify = useMutation(endpoint.verify.post);
  const repair = useMutation(endpoint.repair.post);
  const reveal = useMutation(endpoint.reveal.post);
  const announce = useMutation(endpoint.announce.post);
  const setPriority = useMutation((index: number, priority: FilePriority) =>
    endpoint.files({ index }).put({ priority })
  );
  const setTrackers = useMutation(endpoint.trackers.put);
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
      setFileError(errorMessage(cause, "Unable to save the file"));
    } finally {
      setSavingFile(null);
    }
  };
  const tabs = ["Activity", "Files", "Trackers", "Peers", "Information"];
  const latest = data.history.at(-1);
  const trackerLabels = {
    announcing: "Announcing…",
    error: "Error",
    paused: "Paused",
    waiting: "Waiting",
    working: "Connected",
  };

  return {
    announce,
    downloadFile,
    fileError,
    latest,
    pause,
    repair,
    resume,
    reveal,
    savingFile,
    setPriority,
    setTrackers,
    tabs,
    trackerLabels,
    verify,
  };
}
