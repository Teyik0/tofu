import type { AniListListUpdate } from "../api/modules/anilist/model";
import { errorMessage } from "./errors";

export interface AniListSaveState {
  error: string | null;
  status: "idle" | "saving" | "saved" | "failed";
}

/**
 * Writes list edits to AniList one request at a time. Edits made while a write is in
 * flight are merged into the next write, and failed edits are kept for the next attempt.
 */
export function createAniListAutosave({
  write,
  report,
}: {
  write: (changes: AniListListUpdate) => Promise<void>;
  report: (state: AniListSaveState) => void;
}) {
  let queued: AniListListUpdate = {};
  let running: Promise<void> | null = null;
  const drain = async () => {
    while (Object.keys(queued).length) {
      const changes = queued;
      queued = {};
      report({ error: null, status: "saving" });
      try {
        // biome-ignore lint/performance/noAwaitInLoops: AniList writes must stay ordered.
        await write(changes);
      } catch (cause) {
        queued = { ...changes, ...queued };
        report({
          error: errorMessage(cause, "Unable to save to AniList"),
          status: "failed",
        });
        return;
      }
    }
    report({ error: null, status: "saved" });
  };
  const flush = () => {
    running ??= drain().finally(() => {
      running = null;
    });
    return running;
  };
  return {
    retry: flush,
    save: (changes: AniListListUpdate) => {
      queued = { ...queued, ...changes };
      return flush();
    },
  };
}
