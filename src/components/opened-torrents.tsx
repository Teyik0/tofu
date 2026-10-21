import { useMutation } from "@teyik0/furin/client";
import { useRouter } from "@teyik0/furin/link";
import { useAtom } from "jotai";
import { useEffect, useRef, useState } from "react";
import type { OpenedTorrent } from "../api/modules/desktop/opening";
import { api } from "../lib/client";
import { showTorrent } from "../lib/navigation";
import { modalAtom } from "../state/workspace";

/** Shows the add dialog for each magnet link or .torrent file opened from the system. */
export function OpenedTorrents() {
  const router = useRouter();
  const [modal, open] = useAtom(modalAtom);
  const [waiting, setWaiting] = useState<OpenedTorrent[]>([]);
  // Each opened torrent is presented once, even before the stream confirms its removal.
  const handled = useRef(new Set<string>());
  const dismiss = useMutation((id: string) => api.desktop.openings({ id }).delete());

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const follow = async () => {
      while (!signal.aborted) {
        try {
          // biome-ignore lint/performance/noAwaitInLoops: Each reconnection waits for the previous stream to end.
          const { data } = await api.desktop.openings.get({ fetch: { signal } });
          if (data) {
            for await (const event of data) {
              setWaiting(event.data);
            }
          }
        } catch {
          // The stream reconnects below unless the layout has unmounted.
        }
        if (!signal.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    };
    void follow();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (modal?.type === "open") {
      // Another window added or dismissed this torrent.
      if (!waiting.some((torrent) => torrent.id === modal.torrent.id)) {
        open(null);
      }
      return;
    }
    if (modal !== null) {
      return;
    }
    const next = waiting.find((torrent) => !handled.current.has(torrent.id));
    if (!next) {
      return;
    }
    handled.current.add(next.id);
    if (next.existing) {
      void showTorrent(router, next.existing.destinationId, next.infoHash);
      void dismiss.mutateAsync(next.id);
      return;
    }
    open({ torrent: next, type: "open" });
  }, [dismiss, modal, open, router, waiting]);

  return null;
}
