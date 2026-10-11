import { useMutation } from "@teyik0/furin/client";
import type { AniListEditor, AniListListUpdate, AniListMedia } from "@tofu/plugins/domain";
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
import { Checkbox } from "@tofu/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@tofu/ui/field";
import { Input } from "@tofu/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@tofu/ui/input-group";
import { OptionSelect } from "@tofu/ui/option-select";
import { Separator } from "@tofu/ui/separator";
import { Textarea } from "@tofu/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@tofu/ui/toggle-group";
import {
  CheckIcon,
  FrownIcon,
  LoaderCircleIcon,
  MehIcon,
  SmileIcon,
  StarIcon,
  Trash2Icon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../client-api";
import { type AniListSaveState, createAniListAutosave } from "../lib/anilist-autosave";
import { aniListScoreScales } from "../lib/anilist-score";
import { AniListDatePicker } from "./date-picker";
import { aniListStatusLabels } from "./status";

type Action = (task: () => Promise<void>) => void;

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
  const commit = () => {
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
  };
  const change = (patch: AniListListUpdate) => {
    edit(patch);
    commit();
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: Closing the dialog flushes the last typed edit once.
  useEffect(() => () => commit(), []);
  const mediaProgress = "progress" in media ? (media.progress as number) : null;
  const format = editor.options.scoreFormat;
  const scoreMaximum = format ? aniListScoreScales[format].max : 10;
  const scoreIcons = [
    { icon: SmileIcon, label: "Happy", sentiment: "positive", value: 3 },
    { icon: MehIcon, label: "Neutral", sentiment: "neutral", value: 2 },
    { icon: FrownIcon, label: "Unhappy", sentiment: "negative", value: 1 },
  ];
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
          <FieldGroup className="anime-list-fields">
            <Field className="anilist-filter">
              <FieldLabel htmlFor="anime-list-status">Status</FieldLabel>
              <OptionSelect
                className="anilist-filter-trigger"
                contentClassName="anilist-select-menu"
                disabled={busy}
                id="anime-list-status"
                onValueChange={(status) => {
                  const option = aniListStatusLabels.find((item) => item.value === status);
                  if (option) {
                    setStatusPicked(true);
                    change({ status: option.value });
                  }
                }}
                options={aniListStatusLabels}
                placeholder="Not in list"
                value={editor.entry || statusPicked ? (values.status ?? "PLANNING") : null}
              />
            </Field>
            <Field className="anilist-filter">
              <FieldLabel htmlFor="anime-list-score">Score</FieldLabel>
              {format === "POINT_3" || format === "POINT_5" ? (
                <ToggleGroup
                  aria-label={`Score: ${values.score ? `${values.score} / ${scoreMaximum}` : "none"}. Select again to clear`}
                  className="anime-score-picker"
                  disabled={busy}
                  id="anime-list-score"
                  onValueChange={(selected) => change({ score: Number(selected[0] ?? 0) })}
                  spacing={0}
                  value={values.score ? [String(values.score)] : []}
                >
                  {format === "POINT_3"
                    ? scoreIcons.map(({ value, label, sentiment, icon: Icon }) => (
                        <ToggleGroupItem
                          aria-label={label}
                          data-sentiment={sentiment}
                          key={value}
                          value={String(value)}
                        >
                          <Icon />
                        </ToggleGroupItem>
                      ))
                    : [1, 2, 3, 4, 5].map((score) => (
                        <ToggleGroupItem
                          aria-label={`${score} star${score === 1 ? "" : "s"}`}
                          data-filled={score <= (values.score ?? 0)}
                          key={score}
                          value={String(score)}
                        >
                          <StarIcon />
                        </ToggleGroupItem>
                      ))}
                </ToggleGroup>
              ) : (
                <InputGroup>
                  <InputGroupInput
                    disabled={busy || format === null}
                    id="anime-list-score"
                    max={scoreMaximum}
                    min={0}
                    onBlur={commit}
                    onChange={(event) => edit({ score: Number(event.target.value) })}
                    placeholder="—"
                    step={format === "POINT_10_DECIMAL" ? 0.1 : 1}
                    title={format ? undefined : "Scoring format unavailable"}
                    type="number"
                    value={values.score ?? ""}
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText>/ {format ? scoreMaximum : "—"}</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
              )}
            </Field>
            <Field className="anilist-filter">
              <FieldLabel htmlFor="anime-list-progress">Episode progress</FieldLabel>
              <InputGroup>
                <InputGroupInput
                  disabled={busy}
                  id="anime-list-progress"
                  max={media.episodes ?? 10_000}
                  min={0}
                  onBlur={commit}
                  onChange={(event) => {
                    setProgressEdited(true);
                    edit({ progress: Number(event.target.value) });
                  }}
                  required
                  type="number"
                  value={(progressEdited ? values.progress : mediaProgress) ?? values.progress ?? 0}
                />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>/ {media.episodes ?? "—"}</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
            </Field>
            <Field className="anilist-filter">
              <FieldLabel htmlFor="anime-list-start">Start date</FieldLabel>
              <AniListDatePicker
                change={(startedAt) => change({ startedAt })}
                disabled={busy}
                id="anime-list-start"
                label="Start date"
                value={values.startedAt}
              />
            </Field>
            <Field className="anilist-filter">
              <FieldLabel htmlFor="anime-list-finish">Finish date</FieldLabel>
              <AniListDatePicker
                change={(completedAt) => change({ completedAt })}
                disabled={busy}
                id="anime-list-finish"
                label="Finish date"
                value={values.completedAt}
              />
            </Field>
            <Field className="anilist-filter">
              <FieldLabel htmlFor="anime-list-repeat">Total rewatches</FieldLabel>
              <Input
                disabled={busy}
                id="anime-list-repeat"
                max={1000}
                min={0}
                onBlur={commit}
                onChange={(event) => edit({ repeat: Number(event.target.value) })}
                placeholder="—"
                type="number"
                value={values.repeat ?? ""}
              />
            </Field>
            {editor.options.advancedScoringEnabled ? (
              <FieldSet className="anime-list-wide">
                <FieldLegend variant="label">Advanced scores</FieldLegend>
                <FieldGroup className="anime-list-fields">
                  {editor.options.advancedScoring.map((name, index) => (
                    <Field className="anilist-filter" key={name}>
                      <FieldLabel htmlFor={`anime-advanced-score-${index}`}>{name}</FieldLabel>
                      <InputGroup>
                        <InputGroupInput
                          disabled={busy}
                          id={`anime-advanced-score-${index}`}
                          max={100}
                          min={0}
                          onBlur={commit}
                          onChange={(event) =>
                            edit({
                              advancedScores: (values.advancedScores ?? []).map((score, current) =>
                                current === index ? Number(event.target.value) : score
                              ),
                            })
                          }
                          type="number"
                          value={values.advancedScores?.[index] ?? ""}
                        />
                        <InputGroupAddon align="inline-end">
                          <InputGroupText>/ 100</InputGroupText>
                        </InputGroupAddon>
                      </InputGroup>
                    </Field>
                  ))}
                </FieldGroup>
              </FieldSet>
            ) : null}
            <Field className="anilist-filter anime-list-wide">
              <FieldLabel htmlFor="anime-list-notes">Notes</FieldLabel>
              <Textarea
                disabled={busy}
                id="anime-list-notes"
                maxLength={6000}
                onBlur={commit}
                onChange={(event) => edit({ notes: event.target.value })}
                rows={3}
                value={values.notes ?? ""}
              />
            </Field>
          </FieldGroup>
          <FieldGroup className="anime-list-aside">
            <FieldSet className="anilist-filter anime-list-custom">
              <FieldLegend variant="label">Custom lists</FieldLegend>
              {editor.options.customLists.length ? (
                <FieldGroup>
                  {editor.options.customLists.map((name, index) => (
                    <Field key={name} orientation="horizontal">
                      <Checkbox
                        checked={values.customLists?.includes(name) ?? false}
                        disabled={busy}
                        id={`anime-custom-list-${index}`}
                        onCheckedChange={(checked) =>
                          change({
                            customLists:
                              checked === true
                                ? [...(values.customLists ?? []), name]
                                : (values.customLists ?? []).filter((item) => item !== name),
                          })
                        }
                      />
                      <FieldLabel htmlFor={`anime-custom-list-${index}`}>{name}</FieldLabel>
                    </Field>
                  ))}
                </FieldGroup>
              ) : (
                <FieldDescription>
                  No custom anime lists. Manage them in your AniList settings.
                </FieldDescription>
              )}
            </FieldSet>
            <Separator />
            <FieldSet>
              <FieldLegend className="sr-only" variant="label">
                Visibility
              </FieldLegend>
              <FieldGroup>
                <Field orientation="horizontal">
                  <Checkbox
                    checked={values.private ?? false}
                    disabled={busy}
                    id="anime-list-private"
                    onCheckedChange={(checked) => change({ private: checked === true })}
                  />
                  <FieldLabel htmlFor="anime-list-private">Private</FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <Checkbox
                    checked={values.hiddenFromStatusLists ?? false}
                    disabled={busy || !editor.options.customLists.length}
                    id="anime-list-hidden"
                    onCheckedChange={(checked) =>
                      change({ hiddenFromStatusLists: checked === true })
                    }
                  />
                  <FieldLabel htmlFor="anime-list-hidden">Hide from status lists</FieldLabel>
                </Field>
              </FieldGroup>
            </FieldSet>
            <Field className="anilist-filter">
              <FieldLabel htmlFor="anime-list-priority">Priority</FieldLabel>
              <Input
                disabled={busy}
                id="anime-list-priority"
                max={255}
                min={0}
                onBlur={commit}
                onChange={(event) => edit({ priority: Number(event.target.value) })}
                placeholder="—"
                type="number"
                value={values.priority ?? ""}
              />
            </Field>
          </FieldGroup>
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
