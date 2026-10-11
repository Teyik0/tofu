import { expect, test } from "bun:test";
import { type AniListSaveState, createAniListAutosave } from "../src/lib/anilist-autosave";
import type { AniListListUpdate } from "../src/types";
import { waitFor } from "./helpers";

test("edits made while AniList is saving are sent together in one follow-up write", async () => {
  const writes: AniListListUpdate[] = [];
  const pending: (() => void)[] = [];
  const autosave = createAniListAutosave({
    report: () => undefined,
    write: (changes) => {
      writes.push(changes);
      return new Promise<void>((resolve) => pending.push(resolve));
    },
  });

  const first = autosave.save({ status: "PAUSED" });
  const second = autosave.save({ score: 2 });
  const third = autosave.save({ notes: "Draft", score: 3 });
  expect(writes).toEqual([{ status: "PAUSED" }]);

  pending.shift()?.();
  await waitFor(
    () => Promise.resolve(writes.length),
    (count) => count === 2
  );
  expect(writes).toEqual([{ status: "PAUSED" }, { notes: "Draft", score: 3 }]);

  pending.shift()?.();
  await Promise.all([first, second, third]);
  expect(writes).toHaveLength(2);
});

test("a failed AniList write is reported and retried together with newer edits", async () => {
  const writes: AniListListUpdate[] = [];
  const states: AniListSaveState[] = [];
  const failures = [new Error("AniList is offline")];
  const autosave = createAniListAutosave({
    report: (state) => states.push(state),
    write: (changes) => {
      writes.push(changes);
      const failure = failures.shift();
      return failure ? Promise.reject(failure) : Promise.resolve();
    },
  });

  await autosave.save({ progress: 4 });
  expect(states.at(-1)).toEqual({ error: "AniList is offline", status: "failed" });

  await autosave.save({ notes: "Back online" });
  expect(writes).toEqual([{ progress: 4 }, { notes: "Back online", progress: 4 }]);
  expect(states.at(-1)).toEqual({ error: null, status: "saved" });
});
