import { useMutation } from "@teyik0/furin/client";
import { FrownIcon, MehIcon, SmileIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AniListEditor } from "../../api/modules/anilist/editor";
import type { AniListListUpdate } from "../../api/modules/anilist/model";
import type { AniListMedia } from "../../api/modules/anilist/types";
import { type AniListSaveState, createAniListAutosave } from "../../lib/anilist-autosave";
import { aniListScoreScales } from "../../lib/anilist-score";
import { api } from "../../lib/client";

export type Action = (task: () => Promise<void>) => void;

function initialValues(editor: AniListEditor): AniListListUpdate {
  const { entry } = editor;
  return {
    progress: entry?.progress ?? 0,
    status: entry?.status ?? "PLANNING",
    ...(!entry || entry.score === null ? {} : { score: entry.score }),
    ...(!entry || entry.repeat === null ? {} : { repeat: entry.repeat }),
    ...(!entry || entry.priority === null ? {} : { priority: entry.priority }),
    ...(!entry || entry.private === null ? {} : { private: entry.private }),
    ...(!entry || entry.hiddenFromStatusLists === null
      ? {}
      : { hiddenFromStatusLists: entry.hiddenFromStatusLists }),
    ...(!entry || entry.notes === null ? {} : { notes: entry.notes }),
    customLists: entry?.customLists ?? [],
    ...(entry?.startedAt ? { startedAt: entry.startedAt } : {}),
    ...(entry?.completedAt ? { completedAt: entry.completedAt } : {}),
    ...(editor.options.advancedScoringEnabled
      ? {
          advancedScores: editor.options.advancedScoring.map(
            (name) => entry?.advancedScores.find((item) => item.name === name)?.score ?? 0
          ),
        }
      : {}),
  };
}
export interface AniListListEditorProps {
  action: Action;
  busy: boolean;
  editor: AniListEditor;
  media: AniListMedia;
  removed: () => Promise<void>;
  saved: () => Promise<AniListEditor>;
}

export function useAniListListEditor({
  editor,
  media,
  saved,
}: Pick<AniListListEditorProps, "editor" | "media" | "saved">) {
  const [values, setValues] = useState(() => initialValues(editor));
  const [progressEdited, setProgressEdited] = useState(false);
  // An anime outside the list has no status until one is picked or another edit adds it.
  const [statusPicked, setStatusPicked] = useState(false);
  const [saveState, setSaveState] = useState<AniListSaveState>({ error: null, status: "idle" });
  const [confirmDelete, setConfirmDelete] = useState(false);
  const saveEntry = useMutation((body: AniListListUpdate) =>
    api.anilist.entries({ mediaId: media.mediaId }).editor.put(body)
  );
  const deleteEntry = useMutation(() =>
    api.anilist.entries({ mediaId: media.mediaId }).editor.delete()
  );
  const formRef = useRef<HTMLFormElement>(null);
  // Typed fields stay local until they blur; every other control saves as soon as it changes.
  const unsaved = useRef<AniListListUpdate>({});
  const latest = useRef({ listed: editor.entry !== null, saved, values });
  useEffect(() => {
    latest.current = { listed: latest.current.listed || editor.entry !== null, saved, values };
  });
  const [autosave] = useState(() =>
    createAniListAutosave({
      report: setSaveState,
      write: async (changes) => {
        const { listed, values: current } = latest.current;
        // The first write creates the entry, so it carries the whole form.
        await saveEntry.mutateAsync(listed ? changes : { ...current, ...changes });
        latest.current.listed = true;
        await latest.current.saved();
      },
    })
  );
  const edit = (patch: AniListListUpdate) => {
    unsaved.current = { ...unsaved.current, ...patch };
    setValues((current) => ({ ...current, ...patch }));
  };
  const commit = useCallback(() => {
    const changes = unsaved.current;
    if (!Object.keys(changes).length) {
      return;
    }
    if (formRef.current?.checkValidity() === false) {
      setSaveState({ error: "Fix the highlighted fields to save to AniList", status: "failed" });
      return;
    }
    unsaved.current = {};
    void autosave.save(changes);
  }, [autosave]);
  const change = (patch: AniListListUpdate) => {
    edit(patch);
    commit();
  };
  useEffect(() => () => commit(), [commit]);
  const mediaProgress = "progress" in media ? (media.progress as number) : null;
  const format = editor.options.scoreFormat;
  const scoreMaximum = format ? aniListScoreScales[format].max : 10;
  const scoreIcons = [
    { icon: SmileIcon, label: "Happy", sentiment: "positive", value: 3 },
    { icon: MehIcon, label: "Neutral", sentiment: "neutral", value: 2 },
    { icon: FrownIcon, label: "Unhappy", sentiment: "negative", value: 1 },
  ];

  return {
    autosave,
    change,
    commit,
    confirmDelete,
    deleteEntry,
    edit,
    format,
    formRef,
    mediaProgress,
    progressEdited,
    saveState,
    scoreIcons,
    scoreMaximum,
    setConfirmDelete,
    setProgressEdited,
    setStatusPicked,
    statusPicked,
    values,
  };
}
